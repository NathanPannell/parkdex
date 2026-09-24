"use client";

/* eslint-disable @next/next/no-img-element -- camera previews and private retry photos use temporary object URLs. */

import { Camera, Check, Image as ImageIcon, LockKeyhole, MapPin, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ParkSeal } from "@/components/park-seal";
import { PostcardPrint } from "@/components/postcard-print";
import { PhotoUploadTimeoutError, type ClaimConfirmation, type ClaimRecommendation } from "@/lib/claims-client";
import { fieldDiagnostics, type FieldDiagnosticFact, type FieldDiagnosticTrace } from "@/lib/field-diagnostics";
import { addNativeBackConsumer } from "@/lib/native-back";
import { createPhotoCaptureAttemptId, getNativeCapabilities, RestoredPhotoAwaitingAdoptionError, type LocationSample, type PhotoAsset } from "@/lib/native-capabilities";
import { isPreparedVisitPhoto, normalizeVisitPhoto } from "@/lib/photo-processing";
import { isDurablePhotoOwner } from "@/lib/photo-retry";
import { getPlaceImage } from "@/lib/place-images";
import type { Place } from "@/lib/places";

type Props = {
  place: Place;
  recommendation: Extract<ClaimRecommendation, { status: "recommended" }>;
  ownerKey: string;
  busy: boolean;
  recommendClaim: (input: { location: LocationSample }) => Promise<ClaimRecommendation>;
  createClaim: (input: { recommendationToken: string; expectedPlaceId: string }) => Promise<ClaimConfirmation>;
  reconcileClaim: (placeId: string) => Promise<ClaimConfirmation | null>;
  uploadPhoto: (placeId: string, file: File) => Promise<void>;
  onClaimed: (confirmation: ClaimConfirmation) => void;
  onCompleted?: (confirmation: ClaimConfirmation) => void;
  onDismiss?: () => void;
  onViewAccount?: () => void;
  onFlowActiveChange: (placeId: string | null) => void;
  onClearRecommendation: () => void;
  /** Incremented after account progress reset to invalidate any in-flight claim. */
  resetSignal?: number;
};

const EXPIRY_SAFETY_MS = 8_000;
const RETRY_HYDRATION_TIMEOUT_MS = 8_000;
type WorkStage = "camera" | "processing" | "saving" | "location" | "claim" | "upload" | "cleanup";
type FlowScreen = "arrival" | "review" | "upload" | "success";
type ReviewPhoto = { photo: PhotoAsset; previewUrl: string | null };
type RetryState =
  | { stage: "claim"; file: File; processingState?: PhotoAsset["processingState"]; forcePhotoUpload?: boolean }
  | { stage: "upload"; confirmation: ClaimConfirmation; file: File; forcePhotoUpload?: boolean }
  | { stage: "cleanup"; confirmation: ClaimConfirmation }
  | null;

const STAGE_LABELS: Record<WorkStage, string> = {
  camera: "Opening camera…",
  processing: "Preparing photo…",
  saving: "Saving retry copy…",
  location: "Confirming location…",
  claim: "Saving visit…",
  upload: "Uploading photo…",
  cleanup: "Finalizing postcard…",
};

function validForPlace(recommendation: ClaimRecommendation | null, placeId: string): recommendation is Extract<ClaimRecommendation, { status: "recommended" }> {
  return recommendation?.status === "recommended"
    && recommendation.candidate.placeId === placeId
    && Date.parse(recommendation.expiresAt) - Date.now() > EXPIRY_SAFETY_MS;
}

function networkFact(): FieldDiagnosticFact {
  return { kind: "network", value: typeof navigator !== "undefined" && navigator.onLine ? "online" : "offline" };
}

function failureFacts(error: unknown): FieldDiagnosticFact[] {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
  return [
    networkFact(),
    ...(Number.isFinite(status) ? [{ kind: "http-status", value: status } as const] : []),
    { kind: "result", value: error instanceof PhotoUploadTimeoutError ? "timed-out" : "failed" },
  ];
}

function previewFor(file: File): string | null {
  return typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
}

function revokePreview(url: string | null | undefined) {
  if (url && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

function completedWithPhoto(confirmation: ClaimConfirmation): ClaimConfirmation {
  if (confirmation.claim.hasPhoto) return confirmation;
  return { ...confirmation, claim: { ...confirmation.claim, hasPhoto: true } };
}

export function ClaimFlowBanner({
  place,
  recommendation,
  ownerKey,
  busy,
  recommendClaim,
  createClaim,
  reconcileClaim,
  uploadPhoto,
  onClaimed,
  onCompleted,
  onDismiss,
  onViewAccount,
  onFlowActiveChange,
  onClearRecommendation,
  resetSignal = 0,
}: Props) {
  const [flowScreen, setFlowScreen] = useState<FlowScreen>("arrival");
  const [working, setWorking] = useState(false);
  const [workStage, setWorkStage] = useState<WorkStage | null>(null);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState<RetryState>(null);
  const [noPhotoRetry, setNoPhotoRetry] = useState(false);
  const [reviewPhoto, setReviewPhoto] = useState<ReviewPhoto | null>(null);
  const [successPhotoUrl, setSuccessPhotoUrl] = useState<string | null>(null);
  const [successConfirmation, setSuccessConfirmation] = useState<ClaimConfirmation | null>(null);
  const [hydration, setHydration] = useState<{ key: string; status: "loading" | "ready" | "failed" }>(() => {
    const store = getNativeCapabilities().photoRetry;
    return { key: `${ownerKey}\u0000${place.id}`, status: isDurablePhotoOwner(ownerKey) && Boolean(store) ? "loading" : "failed" };
  });
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const [diagnosticRetryCount, setDiagnosticRetryCount] = useState(0);
  const operationRef = useRef(0);
  const diagnosticRef = useRef<FieldDiagnosticTrace | null>(null);
  const workingRef = useRef(false);
  const busyRef = useRef(busy);
  const restoredCaptureAttemptRef = useRef<string | null>(null);
  const reviewPhotoRef = useRef<ReviewPhoto | null>(null);
  const successPhotoUrlRef = useRef<string | null>(null);
  const completedRef = useRef<string | null>(null);
  const hydratedReviewRef = useRef(false);
  const forcePhotoUploadRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const dismissFlowRef = useRef<() => void>(() => undefined);
  const onFlowActiveChangeRef = useRef(onFlowActiveChange);
  const onClearRecommendationRef = useRef(onClearRecommendation);
  const onDismissRef = useRef(onDismiss);
  const onViewAccountRef = useRef(onViewAccount);
  const onCompletedRef = useRef(onCompleted);
  const retryStore = getNativeCapabilities().photoRetry;
  const hydrationKey = `${ownerKey}\u0000${place.id}`;
  const hydrationStatus = hydration.key === hydrationKey ? hydration.status : "loading";
  const placeImage = getPlaceImage(place.id);

  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { onFlowActiveChangeRef.current = onFlowActiveChange; }, [onFlowActiveChange]);
  useEffect(() => { onClearRecommendationRef.current = onClearRecommendation; }, [onClearRecommendation]);
  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => { onViewAccountRef.current = onViewAccount; }, [onViewAccount]);
  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);

  function replaceReviewPhoto(photo: PhotoAsset) {
    const next = { photo, previewUrl: previewFor(photo.file) } satisfies ReviewPhoto;
    const previous = reviewPhotoRef.current?.previewUrl;
    if (previous && previous !== successPhotoUrlRef.current) revokePreview(previous);
    reviewPhotoRef.current = next;
    setReviewPhoto(next);
  }

  function clearReviewPhoto() {
    const previous = reviewPhotoRef.current?.previewUrl;
    if (previous && previous !== successPhotoUrlRef.current) revokePreview(previous);
    reviewPhotoRef.current = null;
    setReviewPhoto(null);
  }

  function setSuccessPreview(file: File | undefined) {
    const current = reviewPhotoRef.current;
    const existing = current && current.photo.file === file ? current.previewUrl : null;
    const next = existing ?? (file ? previewFor(file) : null);
    if (successPhotoUrlRef.current && successPhotoUrlRef.current !== next) revokePreview(successPhotoUrlRef.current);
    successPhotoUrlRef.current = next;
    setSuccessPhotoUrl(next);
  }

  function invalidate() {
    operationRef.current += 1;
    workingRef.current = false;
    restoredCaptureAttemptRef.current = null;
  }

  function dismissFlow() {
    if (workingRef.current) return;
    const preserveCleanupRetry = retry?.stage === "cleanup";
    invalidate();
    const reviewUrl = reviewPhotoRef.current?.previewUrl;
    clearReviewPhoto();
    if (successPhotoUrlRef.current && successPhotoUrlRef.current !== reviewUrl) revokePreview(successPhotoUrlRef.current);
    successPhotoUrlRef.current = null;
    setSuccessPhotoUrl(null);
    setSuccessConfirmation(null);
    forcePhotoUploadRef.current = false;
    if (!preserveCleanupRetry) setRetry(null);
    setNoPhotoRetry(false);
    setMessage("");
    onFlowActiveChangeRef.current(null);
    onDismissRef.current?.();
    onClearRecommendationRef.current();
  }

  useEffect(() => () => {
    invalidate();
    const reviewUrl = reviewPhotoRef.current?.previewUrl;
    const successUrl = successPhotoUrlRef.current;
    if (reviewUrl) revokePreview(reviewUrl);
    if (successUrl && successUrl !== reviewUrl) revokePreview(successUrl);
    onFlowActiveChangeRef.current(null);
  }, []);

  // Treat the impression as a real modal on Android. A Back press dismisses only
  // when no camera, location, upload, or storage operation is in flight.
  useEffect(() => addNativeBackConsumer(() => {
    if (!workingRef.current) dismissFlowRef.current();
  }), []);

  useEffect(() => { dismissFlowRef.current = dismissFlow; });

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...node.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
    (node.querySelector<HTMLElement>("[data-impression-initial-focus]") ?? focusable()[0])?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!workingRef.current) { event.preventDefault(); dismissFlowRef.current(); }
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [flowScreen, hydrationStatus]);

  useEffect(() => {
    if (resetSignal === 0) return;
    invalidate();
    const reviewUrl = reviewPhotoRef.current?.previewUrl;
    if (reviewUrl && reviewUrl !== successPhotoUrlRef.current) revokePreview(reviewUrl);
    reviewPhotoRef.current = null;
    if (successPhotoUrlRef.current) revokePreview(successPhotoUrlRef.current);
    successPhotoUrlRef.current = null;
    forcePhotoUploadRef.current = false;
    queueMicrotask(() => {
      setReviewPhoto(null);
      setFlowScreen("arrival");
      setWorking(false);
      setWorkStage(null);
      setRetry(null);
      setNoPhotoRetry(false);
      setMessage("");
      setSuccessPhotoUrl(null);
      setSuccessConfirmation(null);
    });
    onFlowActiveChangeRef.current(null);
    onClearRecommendationRef.current();
  }, [resetSignal]);

  useEffect(() => {
    if (!isDurablePhotoOwner(ownerKey) || !retryStore) {
      queueMicrotask(() => setHydration({ key: hydrationKey, status: "failed" }));
      return;
    }
    let active = true;
    onFlowActiveChangeRef.current(place.id);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const load = Promise.race([
      retryStore.load(ownerKey, place.id),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Private photo recovery timed out.")), RETRY_HYDRATION_TIMEOUT_MS); }),
    ]);
    void load.then((photo) => {
      if (!active) return;
      setHydration({ key: hydrationKey, status: "ready" });
      if (!photo) {
        setFlowScreen((current) => current === "success" ? current : "arrival");
        setMessage("");
        onFlowActiveChangeRef.current(null);
        return;
      }
      hydratedReviewRef.current = true;
      replaceReviewPhoto(photo);
      setRetry({ stage: "claim", file: photo.file, processingState: photo.processingState });
      setFlowScreen("review");
      setMessage("Your saved photo is ready. Keep this one or retake it before saving your visit.");
      onFlowActiveChangeRef.current(place.id);
    }).catch(() => {
      if (!active) return;
      setHydration({ key: hydrationKey, status: "failed" });
      setMessage("Parkdex could not safely check for an existing photo. Retry before taking another one.");
      onFlowActiveChangeRef.current(null);
    }).finally(() => { if (timeout) clearTimeout(timeout); });
    return () => { active = false; if (timeout) clearTimeout(timeout); };
  }, [hydrationAttempt, hydrationKey, ownerKey, place.id, resetSignal, retryStore]);

  async function persist(photo: PhotoAsset, rawStaging = false) {
    if (!isDurablePhotoOwner(ownerKey) || !retryStore) throw new Error("Private photo storage is not ready. Wait for your account to finish loading, then try again.");
    const saved = rawStaging
      ? await retryStore.save(ownerKey, place.id, photo, { rawStaging: true })
      : await retryStore.save(ownerKey, place.id, photo);
    if (saved === false) throw new Error("The photo could not be saved on this device. Free some storage, then try again.");
  }

  async function removePersisted() {
    if (isDurablePhotoOwner(ownerKey) && retryStore) await retryStore.remove(ownerKey, place.id);
  }

  function pauseForAccountChange(file?: File, confirmation?: ClaimConfirmation, processingState?: PhotoAsset["processingState"], forcePhotoUpload = false) {
    if (!busyRef.current) return false;
    if (confirmation && file) {
      setRetry({ stage: "upload", confirmation, file, forcePhotoUpload });
      setFlowScreen("upload");
      setMessage("Your visit is saved. Finish the photo after the account change completes.");
    } else if (file) {
      setRetry({ stage: "claim", file, processingState: processingState ?? "prepared", forcePhotoUpload });
      setFlowScreen("arrival");
      setMessage("Your photo is saved. Finish the postcard after the account change completes.");
    } else {
      setNoPhotoRetry(true);
      setFlowScreen("arrival");
      setMessage("Your location check is paused while the account changes. Retry the saved visit when it finishes.");
    }
    return true;
  }

  async function completeUpload(confirmation: ClaimConfirmation, file: File, operation: number, forcePhotoUpload = false) {
    if (pauseForAccountChange(file, confirmation, "prepared", forcePhotoUpload)) {
      setSuccessConfirmation(confirmation);
      return;
    }
    setFlowScreen("upload");
    setSuccessConfirmation(confirmation);
    setRetry({ stage: "upload", confirmation, file, forcePhotoUpload });
    try {
      setWorkStage("upload");
      diagnosticRef.current?.stage("upload", {
        summary: "Uploading the prepared photo",
        facts: [networkFact(), { kind: "file-bytes", value: file.size }, { kind: "mime-type", value: "image/jpeg" }],
      });
      // The local file may be a replacement for a server photo, including
      // after a process restart where the in-memory replacement marker is
      // gone. The endpoint is idempotent and accepts the prepared bytes.
      await uploadPhoto(place.id, file);
      diagnosticRef.current?.stage("upload", { summary: "Photo upload completed", facts: [{ kind: "result", value: "saved" }] });
    } catch (error) {
      if (operationRef.current !== operation) return;
      setRetry({ stage: "upload", confirmation, file, forcePhotoUpload });
      setWorkStage(null);
      setFlowScreen("upload");
      setMessage(`Your visit is saved. The retry photo is saved too. ${error instanceof Error ? error.message : "The photo upload did not finish."}`);
      diagnosticRef.current?.warn("upload", { summary: error instanceof PhotoUploadTimeoutError ? "Photo upload timed out. The retry copy is safe" : "Photo upload stopped. The retry copy is safe", facts: failureFacts(error) });
      return;
    }
    if (operationRef.current !== operation) return;

    const completed = completedWithPhoto(confirmation);
    const completionKey = `${completed.placeId}:${completed.visitedAt}`;
    if (completedRef.current !== completionKey) {
      completedRef.current = completionKey;
      onClaimed(completed);
      onCompletedRef.current?.(completed);
    }
    setSuccessPreview(file);
    setSuccessConfirmation(completed);
    setRetry(null);
    setNoPhotoRetry(false);
    setMessage("");
    setFlowScreen("success");
    onFlowActiveChangeRef.current(place.id);

    try {
      setWorkStage("cleanup");
      diagnosticRef.current?.stage("cleanup", { summary: "Removing the private retry copy from this device" });
      await removePersisted();
    } catch {
      if (operationRef.current !== operation) return;
      setRetry({ stage: "cleanup", confirmation: completed });
      setWorkStage(null);
      setFlowScreen("success");
      setMessage("Your postcard is created. Parkdex still needs to remove the private retry copy from this device.");
      diagnosticRef.current?.warn("cleanup", { summary: "Postcard created, but the local retry copy still needs cleanup", facts: [{ kind: "result", value: "failed" }] });
      return;
    }
    if (operationRef.current !== operation) return;
    setWorkStage(null);
    diagnosticRef.current?.succeed("cleanup", { summary: "Postcard created and retry copy removed", facts: [{ kind: "result", value: "complete" }] });
    onFlowActiveChangeRef.current(place.id);
  }

  async function freshRecommendation(operation: number, pausedFile?: File, forcePhotoUpload = false) {
    setWorkStage("location");
    const startedAt = Date.now();
    diagnosticRef.current?.stage("location-recheck", { summary: "Confirming a fresh park location" });
    const freshLocation = await getNativeCapabilities().getCurrentLocation({ highAccuracy: true, timeoutMs: 12_000, maxAgeMs: 0, requirePrecise: true });
    diagnosticRef.current?.stage("location-recheck", { summary: "Fresh location received", facts: [{ kind: "elapsed-ms", value: Date.now() - startedAt }, { kind: "accuracy-meters", value: freshLocation.accuracyMeters }] });
    if (operationRef.current !== operation) return null;
    if (pauseForAccountChange(pausedFile, undefined, pausedFile ? "prepared" : undefined, forcePhotoUpload)) return null;
    const fresh = await recommendClaim({ location: freshLocation });
    if (operationRef.current !== operation) return null;
    return fresh;
  }

  async function finishAcceptedPhoto(file: File, operation: number, reconcileFirst = false, forcePhotoUpload = false) {
    try {
      if (pauseForAccountChange(file, undefined, "prepared", forcePhotoUpload)) return;
      let confirmation = reconcileFirst ? await reconcileClaim(place.id) : null;
      if (operationRef.current !== operation) return;
      if (pauseForAccountChange(file, confirmation ?? undefined, "prepared", forcePhotoUpload)) return;
      if (!confirmation) {
        const fresh = await freshRecommendation(operation, file, forcePhotoUpload);
        if (!fresh || pauseForAccountChange(file, undefined, "prepared", forcePhotoUpload) || operationRef.current !== operation) return;
        if (!validForPlace(fresh, place.id)) {
          setRetry({ stage: "claim", file, processingState: "prepared", forcePhotoUpload });
          setFlowScreen("arrival");
          setMessage("Parkdex could not confirm that you are still in this park. Your photo is saved. Stay inside the boundary and retry the saved visit.");
          diagnosticRef.current?.fail("boundary-check", { summary: "The fresh location was outside the selected park boundary", facts: [{ kind: "result", value: "rejected" }] });
          // Keep the claim flow pinned around its durable retry photo while
          // clearing the live eligibility cache below.
          onFlowActiveChangeRef.current(place.id);
          onClearRecommendationRef.current();
          return;
        }
        try {
          setWorkStage("claim");
          diagnosticRef.current?.stage("claim", { summary: "Saving the park visit", facts: [networkFact()] });
          confirmation = await createClaim({ recommendationToken: fresh.recommendationToken, expectedPlaceId: place.id });
        } catch (claimError) {
          // A claim can commit even when its response is lost. Re-read the
          // account before offering a retry so the only photo is never discarded.
          try { confirmation = await reconcileClaim(place.id); } catch { /* Preserve the original claim error below. */ }
          if (!confirmation) throw claimError;
        }
        diagnosticRef.current?.stage("claim", { summary: "Park visit saved", facts: [{ kind: "result", value: "saved" }] });
      }
      if (operationRef.current !== operation || !confirmation) return;
      if (pauseForAccountChange(file, confirmation, "prepared", forcePhotoUpload)) return;
      await completeUpload(confirmation, file, operation, forcePhotoUpload);
    } catch (error) {
      if (operationRef.current !== operation) return;
      setRetry({ stage: "claim", file, processingState: "prepared", forcePhotoUpload });
      setFlowScreen("arrival");
      setWorkStage(null);
      setMessage(error instanceof Error ? `${error.message} Your photo is saved, so you can retry the saved visit without reopening the camera.` : "Your photo is saved. Try finishing the visit again.");
      diagnosticRef.current?.warn("claim", { summary: "The postcard paused after the photo was saved for retry", facts: failureFacts(error) });
    }
  }

  async function claimWithCamera() {
    if (workingRef.current || hydrationStatus !== "ready") return;
    const operation = ++operationRef.current;
    workingRef.current = true;
    setWorking(true);
    setMessage("");
    setRetry(null);
    setNoPhotoRetry(false);
    onFlowActiveChangeRef.current(place.id);
    const trace = fieldDiagnostics.begin({ key: `photo:${place.id}`, flow: "photo", title: `Postcard for ${place.name}`, stage: "camera", summary: "Opening the camera", facts: [networkFact(), { kind: "result", value: "started" }] });
    diagnosticRef.current = trace;
    let savedPhoto: PhotoAsset | null = null;
    try {
      setWorkStage("camera");
      const capturedPhoto = await getNativeCapabilities().getPhoto({ ownerKey, placeId: place.id, captureAttemptId: restoredCaptureAttemptRef.current ?? createPhotoCaptureAttemptId() });
      restoredCaptureAttemptRef.current = null;
      if (operationRef.current !== operation) return;
      if (busyRef.current) { onFlowActiveChangeRef.current(null); return; }
      if (!capturedPhoto) {
        trace.succeed("camera", { summary: "Camera closed without taking a photo", facts: [{ kind: "result", value: "cancelled" }] });
        onFlowActiveChangeRef.current(null);
        return;
      }
      trace.stage("camera", { summary: "Photo accepted from the camera", facts: [{ kind: "file-bytes", value: capturedPhoto.file.size }, { kind: "result", value: "accepted" }] });
      setWorkStage("saving");
      await persist(capturedPhoto, true);
      if (operationRef.current !== operation) return;
      savedPhoto = capturedPhoto;
      forcePhotoUploadRef.current = false;
      hydratedReviewRef.current = false;
      replaceReviewPhoto(capturedPhoto);
      setRetry({ stage: "claim", file: capturedPhoto.file, processingState: capturedPhoto.processingState ?? "raw" });
      setFlowScreen("review");
      setMessage("");
      trace.stage("local-save", { summary: "Accepted camera bytes saved for review and crash recovery", facts: [{ kind: "result", value: "saved" }] });
      onFlowActiveChangeRef.current(place.id);
    } catch (error) {
      if (operationRef.current === operation) {
        if (error instanceof RestoredPhotoAwaitingAdoptionError) {
          restoredCaptureAttemptRef.current = error.captureAttemptId;
          setMessage(error.message);
          onFlowActiveChangeRef.current(place.id);
        } else if (savedPhoto) {
          setRetry({ stage: "claim", file: savedPhoto.file, processingState: savedPhoto.processingState });
          setFlowScreen("review");
          setMessage(`${error instanceof Error ? error.message : "The photo could not be prepared."} Your accepted photo is saved, so you can retry the saved visit without reopening the camera.`);
          onFlowActiveChangeRef.current(place.id);
        } else {
          setMessage(error instanceof Error ? error.message : "Could not finish this visit. Try again.");
          onFlowActiveChangeRef.current(null);
        }
        trace.fail("camera", { summary: savedPhoto ? "The accepted photo is safe for retry" : "The camera could not return a usable photo", facts: failureFacts(error) });
      }
    } finally {
      if (operationRef.current === operation) {
        setWorkStage(null);
        workingRef.current = false;
        setWorking(false);
      }
    }
  }

  async function retakePhoto() {
    if (workingRef.current || !reviewPhotoRef.current) return;
    const operation = ++operationRef.current;
    workingRef.current = true;
    setWorking(true);
    setWorkStage("camera");
    setMessage("");
    onFlowActiveChangeRef.current(place.id);
    try {
      const capturedPhoto = await getNativeCapabilities().getPhoto({ ownerKey, placeId: place.id, captureAttemptId: restoredCaptureAttemptRef.current ?? createPhotoCaptureAttemptId() });
      restoredCaptureAttemptRef.current = null;
      if (operationRef.current !== operation) return;
      if (busyRef.current) { setMessage("Your current photo is still saved while the account changes."); return; }
      if (!capturedPhoto) { setMessage("Your current photo is still selected."); return; }
      const replacingHydratedPhoto = hydratedReviewRef.current || forcePhotoUploadRef.current;
      await persist(capturedPhoto, true);
      if (operationRef.current !== operation) return;
      forcePhotoUploadRef.current = replacingHydratedPhoto;
      replaceReviewPhoto(capturedPhoto);
      setRetry({ stage: "claim", file: capturedPhoto.file, processingState: capturedPhoto.processingState ?? "raw", forcePhotoUpload: replacingHydratedPhoto });
      setMessage("New photo ready. Keep this one or retake it again.");
      onFlowActiveChangeRef.current(place.id);
    } catch (error) {
      if (operationRef.current === operation) {
        if (error instanceof RestoredPhotoAwaitingAdoptionError) restoredCaptureAttemptRef.current = error.captureAttemptId;
        setMessage(`${error instanceof Error ? error.message : "The replacement photo could not be saved."} Your current photo is still saved.`);
        onFlowActiveChangeRef.current(place.id);
      }
    } finally {
      if (operationRef.current === operation) {
        setWorkStage(null);
        workingRef.current = false;
        setWorking(false);
      }
    }
  }

  async function saveReviewedPhoto() {
    const current = reviewPhotoRef.current;
    if (!current || workingRef.current) return;
    const operation = ++operationRef.current;
    workingRef.current = true;
    setWorking(true);
    setMessage("");
    setWorkStage("processing");
    onFlowActiveChangeRef.current(place.id);
    try {
      const forcePhotoUpload = forcePhotoUploadRef.current;
      if (pauseForAccountChange(current.photo.file, undefined, current.photo.processingState, forcePhotoUpload)) return;
      const prepared = isPreparedVisitPhoto(current.photo) ? current.photo : await normalizeVisitPhoto(current.photo);
      if (operationRef.current !== operation) return;
      setWorkStage("saving");
      await persist(prepared);
      if (operationRef.current !== operation) return;
      replaceReviewPhoto(prepared);
      setRetry({ stage: "claim", file: prepared.file, processingState: prepared.processingState, forcePhotoUpload });
      setFlowScreen("upload");
      await finishAcceptedPhoto(prepared.file, operation, hydratedReviewRef.current, forcePhotoUpload);
    } catch (error) {
      if (operationRef.current === operation) {
        setFlowScreen("review");
        setWorkStage(null);
        setMessage(`${error instanceof Error ? error.message : "The photo could not be prepared."} Your saved photo is still available.`);
      }
    } finally {
      if (operationRef.current === operation) {
        setWorkStage(null);
        workingRef.current = false;
        setWorking(false);
      }
    }
  }

  async function claimWithoutPhoto() {
    if (workingRef.current || hydrationStatus !== "ready") return;
    const operation = ++operationRef.current;
    const retryingNoPhoto = noPhotoRetry;
    workingRef.current = true;
    setWorking(true);
    setNoPhotoRetry(false);
    setRetry(null);
    setMessage("");
    setFlowScreen("upload");
    onFlowActiveChangeRef.current(place.id);
    const trace = fieldDiagnostics.begin({ key: `location-claim:${place.id}`, flow: "location", title: `Visit at ${place.name}`, stage: "location-recheck", summary: "Confirming a fresh park location", facts: [networkFact(), { kind: "result", value: "started" }] });
    diagnosticRef.current = trace;
    try {
      if (pauseForAccountChange()) return;
      let confirmation: ClaimConfirmation | null = null;
      if (retryingNoPhoto) {
        // A lost create response can make the server stop recommending this
        // place. Reconcile before requesting a fresh boundary recommendation.
        setWorkStage("claim");
        confirmation = await reconcileClaim(place.id);
        if (operationRef.current !== operation) return;
      }
      if (!confirmation) {
        const fresh = await freshRecommendation(operation);
        if (!fresh || operationRef.current !== operation) return;
        if (pauseForAccountChange()) return;
        if (!validForPlace(fresh, place.id)) {
        // The location may have drifted after a claim committed but before its
        // response arrived. Reconcile before treating the fresh boundary as a
        // definitive no-claim result.
          try {
            setWorkStage("claim");
            confirmation = await reconcileClaim(place.id);
          } catch { /* Keep the boundary result as the retry state below. */ }
          if (operationRef.current !== operation) return;
          if (!confirmation) {
            setNoPhotoRetry(true);
            setFlowScreen("arrival");
            setMessage("Parkdex could not confirm that you are still in this park. Stay inside the boundary and retry the saved visit.");
            trace.fail("boundary-check", { summary: "The fresh location was outside the selected park boundary", facts: [{ kind: "result", value: "rejected" }] });
            // Keep the claim flow pinned around its durable no-photo retry;
            // the live recommendation cache can still be cleared safely.
            onFlowActiveChangeRef.current(place.id);
            onClearRecommendationRef.current();
            return;
          }
        } else {
          setWorkStage("claim");
          try {
            confirmation = await createClaim({ recommendationToken: fresh.recommendationToken, expectedPlaceId: place.id });
          } catch (claimError) {
            // A claim can commit even when its response is lost. Re-read the
            // account before offering a retry so the visit is never duplicated.
            try { confirmation = await reconcileClaim(place.id); } catch { /* Preserve the original claim error below. */ }
            if (!confirmation) throw claimError;
          }
        }
      }
      if (operationRef.current !== operation || !confirmation) return;
      if (pauseForAccountChange(undefined, confirmation)) return;
      trace.succeed("claim", { summary: "Visit saved without a photo", facts: [{ kind: "result", value: "saved" }] });
      const completionKey = `${confirmation.placeId}:${confirmation.visitedAt}`;
      if (completedRef.current !== completionKey) {
        completedRef.current = completionKey;
        onClaimed(confirmation);
        onCompletedRef.current?.(confirmation);
      }
      setSuccessConfirmation(confirmation);
      setSuccessPreview(undefined);
      setMessage("");
      setWorkStage(null);
      setFlowScreen("success");
      onFlowActiveChangeRef.current(place.id);
    } catch (error) {
      if (operationRef.current === operation) {
        setNoPhotoRetry(true);
        setFlowScreen("arrival");
        setWorkStage(null);
        setMessage(error instanceof Error ? `${error.message} Retry the saved visit when you’re ready.` : "Your visit could not be saved. Retry the saved visit.");
        trace.warn("claim", { summary: "The no-photo visit paused for retry", facts: failureFacts(error) });
      }
    } finally {
      if (operationRef.current === operation) {
        workingRef.current = false;
        setWorking(false);
      }
    }
  }

  async function retryFlow() {
    if (workingRef.current) return;
    if (noPhotoRetry) { await claimWithoutPhoto(); return; }
    if (!retry) return;
    const operation = ++operationRef.current;
    workingRef.current = true;
    setWorking(true);
    setMessage("");
    const retryAttempt = diagnosticRetryCount + 1;
    setDiagnosticRetryCount(retryAttempt);
    const retryTrace = diagnosticRef.current ?? fieldDiagnostics.begin({ key: `photo:${place.id}`, flow: "photo", title: `Postcard for ${place.name}`, stage: retry.stage === "upload" ? "upload" : retry.stage === "cleanup" ? "cleanup" : "claim", summary: "Resuming the saved postcard", facts: [{ kind: "retry-attempt", value: retryAttempt }, networkFact()] });
    diagnosticRef.current = retryTrace;
    retryTrace.stage(retry.stage === "upload" ? "upload" : retry.stage === "cleanup" ? "cleanup" : "claim", { summary: "Retrying the saved postcard", facts: [{ kind: "retry-attempt", value: retryAttempt }, networkFact()] });

    if (retry.stage === "claim") {
      try {
        setFlowScreen("upload");
        setWorkStage("processing");
        const retryPhoto = { file: retry.file, mimeType: retry.file.type || "application/octet-stream", processingState: retry.processingState } satisfies PhotoAsset;
        const alreadyPrepared = isPreparedVisitPhoto(retryPhoto);
        const prepared = alreadyPrepared ? retryPhoto : await normalizeVisitPhoto(retryPhoto);
        if (operationRef.current !== operation) return;
        if (!alreadyPrepared) {
          setWorkStage("saving");
          await persist(prepared);
          if (operationRef.current !== operation) return;
        }
        replaceReviewPhoto(prepared);
        setRetry({ stage: "claim", file: prepared.file, processingState: prepared.processingState, forcePhotoUpload: retry.forcePhotoUpload });
        await finishAcceptedPhoto(prepared.file, operation, true, retry.forcePhotoUpload);
      } catch (error) {
        if (operationRef.current === operation) {
          setFlowScreen("arrival");
          setWorkStage(null);
          setMessage(`${error instanceof Error ? error.message : "The saved photo could not be prepared."} Your original photo is still saved.`);
        }
      } finally {
        if (operationRef.current === operation) { workingRef.current = false; setWorking(false); }
      }
      return;
    }

    if (retry.stage === "cleanup") {
      try {
        setWorkStage("cleanup");
        await removePersisted();
        if (operationRef.current !== operation) return;
        setRetry(null);
        setWorkStage(null);
        setMessage("");
        setFlowScreen("success");
        onFlowActiveChangeRef.current(place.id);
      } catch {
        if (operationRef.current === operation) { setWorkStage(null); setMessage("The private retry copy is still waiting for device storage cleanup."); retryTrace.warn("cleanup", { summary: "Local retry cleanup is still waiting", facts: [{ kind: "result", value: "failed" }] }); }
      } finally {
        if (operationRef.current === operation) { workingRef.current = false; setWorking(false); }
      }
      return;
    }

    try {
      setFlowScreen("upload");
      setWorkStage("claim");
      const reconciled = await reconcileClaim(place.id);
      if (operationRef.current !== operation) return;
      await completeUpload(reconciled ?? retry.confirmation, retry.file, operation, retry.forcePhotoUpload);
    } catch (error) {
      if (operationRef.current === operation) { setWorkStage(null); setMessage(`${error instanceof Error ? error.message : "Parkdex could not check the saved visit."} Your retry photo is still saved.`); }
    } finally {
      if (operationRef.current === operation) { workingRef.current = false; setWorking(false); }
    }
  }

  async function discardRetry() {
    if (workingRef.current || !retry) return;
    const current = retry;
    const operation = ++operationRef.current;
    workingRef.current = true;
    setWorking(true);
    try {
      let reconciled: ClaimConfirmation | null = null;
      if (current.stage === "upload" || current.stage === "cleanup") {
        try {
          setWorkStage("claim");
          reconciled = await reconcileClaim(place.id);
        } catch (error) {
          if (operationRef.current !== operation) return;
          setWorkStage(null);
          setMessage(error instanceof Error ? `Parkdex could not verify the saved visit. Your photo is still saved. ${error.message}` : "Parkdex could not verify the saved visit. Your photo is still saved.");
          return;
        }
      }
      if (operationRef.current !== operation) return;
      await removePersisted();
      if (operationRef.current !== operation) return;
      if (reconciled || current.stage === "upload" || current.stage === "cleanup") {
        const confirmation = reconciled ?? (current.stage === "upload" || current.stage === "cleanup" ? current.confirmation : null);
        if (!confirmation) return;
        const completionKey = `${confirmation.placeId}:${confirmation.visitedAt}`;
        if (completedRef.current !== completionKey) {
          completedRef.current = completionKey;
          onClaimed(confirmation);
          onCompletedRef.current?.(confirmation);
        }
        setSuccessConfirmation(confirmation);
        setSuccessPreview(undefined);
        setFlowScreen("success");
        setRetry(null);
        setMessage("");
        onFlowActiveChangeRef.current(place.id);
        return;
      }
      clearReviewPhoto();
      setRetry(null);
      setNoPhotoRetry(false);
      workingRef.current = false;
      setWorking(false);
      dismissFlowRef.current();
    } catch {
      if (operationRef.current === operation) setMessage("The saved photo could not be removed yet. Try again when device storage is available.");
    } finally {
      if (operationRef.current === operation) {
        workingRef.current = false;
        setWorking(false);
        setWorkStage(null);
      }
    }
  }

  function retryHydration() {
    setHydration({ key: hydrationKey, status: "loading" });
    setMessage("");
    setHydrationAttempt((current) => current + 1);
  }

  function closeToMap() {
    if (!workingRef.current) dismissFlow();
  }

  const workingLabel = workStage ? STAGE_LABELS[workStage] : "Finishing…";
  const reviewUrl = reviewPhoto?.previewUrl;
  const success = successConfirmation;
  const uploadConfirmation = success ?? (retry?.stage === "upload" || retry?.stage === "cleanup" ? retry.confirmation : null);
  const arrivalIsInside = recommendation.candidate.matchKind === "exact";
  const dialogTitle = flowScreen === "success" ? "You were here." : flowScreen === "review" ? "Keep this one?" : flowScreen === "upload" ? "A moment in the making." : retry || noPhotoRetry ? "Finish your postcard" : `Hello, ${place.name}.`;
  const closeButton = <button className="impression-icon-button impression-close" type="button" onClick={closeToMap} disabled={working} aria-label="Close sealed impression" data-impression-initial-focus><X size={19} /></button>;
  const retryControl = !working && retry && <div className="impression-recovery" role="alert">
    <p>{message || (retry.stage === "upload" ? "Your visit is saved, but the photo still needs to upload." : retry.stage === "cleanup" ? "Your postcard is saved, but the private retry copy still needs cleanup." : "Your saved photo is ready to finish the visit.")}</p>
    <div className="impression-recovery-actions">
      <button className="impression-primary" type="button" onClick={() => void retryFlow()} disabled={working || busy}>{working ? workingLabel : retry.stage === "upload" ? "Retry photo" : retry.stage === "cleanup" ? "Retry private photo cleanup" : "Retry saved visit"}</button>
      {retry.stage !== "cleanup" && <button className="impression-secondary" type="button" onClick={() => void discardRetry()} disabled={working}>{retry.stage === "upload" ? "Keep visit without photo" : "Discard saved photo"}</button>}
    </div>
  </div>;
  const noPhotoRetryControl = noPhotoRetry && !retry && <div className="impression-recovery" role="alert"><p>{message || "Your visit could not be saved yet."}</p><button className="impression-primary" type="button" onClick={() => void retryFlow()} disabled={working || busy}>{working ? workingLabel : "Retry saved visit"}</button></div>;

  return <aside ref={dialogRef} className={`impression-flow impression-flow--${flowScreen}`} role="dialog" aria-modal="true" aria-labelledby="impression-flow-title" aria-live="polite">
    {flowScreen === "arrival" && <section className="impression-arrival">
      <div className="impression-arrival-art" aria-hidden={placeImage ? undefined : "true"}>{placeImage ? <img src={placeImage.detail.src} alt={placeImage.alt} /> : <div className="impression-arrival-placeholder"><MapPin size={44} /><span>Place boundary</span></div>}{placeImage && <small className="impression-arrival-credit">Photo <a href={placeImage.sourceUrl} target="_blank" rel="noreferrer">{placeImage.creator}</a> · <a href={placeImage.originalUrl} target="_blank" rel="noreferrer">Original</a> · <a href={placeImage.licenseUrl} target="_blank" rel="noreferrer">{placeImage.license}</a><span className="impression-arrival-credit-changes">Changes: {placeImage.changes}</span></small>}</div>
      <header className="impression-header"><span className="impression-brand"><MapPin size={18} /> Parkdex</span>{closeButton}</header>
      <div className="impression-sheet">
        {hydrationStatus === "ready" && !retry && !noPhotoRetry && <ParkSeal place={place} className="impression-arrival-seal" />}
        <span className="impression-eyebrow">{hydrationStatus === "loading" ? "Checking saved photos" : retry || noPhotoRetry ? "Your next postcard" : arrivalIsInside ? "Inside the park" : "Near the boundary"}</span>
        <h1 id="impression-flow-title">{dialogTitle}</h1>
        <p>{message || (hydrationStatus === "loading" ? "Making sure an earlier photo is not overwritten." : retry || noPhotoRetry ? "Finish this visit from the saved copy on your device." : arrivalIsInside ? "Your location is inside the published boundary." : `About ${Math.round(recommendation.candidate.distanceMeters)} m from the park boundary.`)}</p>
        {hydrationStatus === "loading" && <button className="impression-primary" type="button" disabled><RefreshCw className="impression-spin" size={18} />Checking saved photos…</button>}
        {hydrationStatus === "failed" && <button className="impression-primary" type="button" onClick={retryHydration}><RefreshCw size={18} />Retry saved photo check</button>}
        {hydrationStatus === "ready" && !retry && !noPhotoRetry && <>
          <button className="impression-primary" type="button" onClick={() => void claimWithCamera()} disabled={working || busy}><Camera size={18} />{working ? workingLabel : "Log visit + photo"}</button>
          <button className="impression-secondary" type="button" onClick={() => void claimWithoutPhoto()} disabled={working || busy}>Log without photo</button>
        </>}
        {retryControl}
        {noPhotoRetryControl}
        {hydrationStatus === "ready" && !working && <button className="impression-text-button" type="button" onClick={dismissFlow}>Not now</button>}
      </div>
    </section>}

    {flowScreen === "review" && <section className="impression-review">
      <header className="impression-header">{closeButton}<span className="impression-photo-tag">Your view</span></header>
      <div className="impression-review-photo">{reviewUrl ? <img src={reviewUrl} alt={`Your selected visit photo preview for ${place.name}`} /> : <div className="impression-photo-missing"><ImageIcon size={34} /><span>Photo preview unavailable</span></div>}</div>
      <div className="impression-review-copy"><div><h1 id="impression-flow-title">Keep this one?</h1><p>{place.name}</p></div><button className="impression-icon-button" type="button" onClick={() => void retakePhoto()} disabled={working || busy} aria-label="Retake photo"><Camera size={19} /></button></div>
      <div className="impression-actions"><div className="impression-privacy"><LockKeyhole size={14} /> Just for you</div><button className="impression-primary" type="button" onClick={() => void saveReviewedPhoto()} disabled={working || busy}>{working ? workingLabel : <><Check size={18} />Save my visit</>}</button>{message && <p className="impression-state" role="alert">{message}</p>}</div>
    </section>}

    {flowScreen === "upload" && <section className="impression-upload">
      <header className="impression-header">{closeButton}<span className="impression-eyebrow">{workStage === "upload" ? "Sending your photo" : "Saving your visit"}</span></header>
      <div className="impression-upload-heading"><h1 id="impression-flow-title">A moment<br />in the making.</h1><p>{(workStage === "upload" || workStage === "cleanup" || retry?.stage === "upload") ? "Your visit is saved." : "Saving your visit."}</p></div>
      <div className="impression-print-stage"><PostcardPrint place={place} photoUrl={reviewUrl ?? successPhotoUrl ?? undefined} visitedAt={uploadConfirmation?.visitedAt} /></div>
      {retryControl || <div className="impression-upload-status" role="status"><RefreshCw className="impression-spin" size={18} /><span>{workingLabel}<small>We’ll keep a copy if it needs a retry.</small></span></div>}
      <div className="impression-actions"><button className="impression-text-button" type="button" onClick={closeToMap} disabled={working}>Back to map</button></div>
    </section>}

    {flowScreen === "success" && <section className="impression-success">
      <header className="impression-header"><span className="impression-brand"><MapPin size={18} /> Parkdex</span>{closeButton}</header>
      <div className="impression-success-heading"><h1 id="impression-flow-title">You were here.</h1><p>Now it’s one of your places.</p></div>
      <div className="impression-print-stage"><PostcardPrint place={place} photoUrl={successPhotoUrl ?? undefined} visitedAt={success?.visitedAt} sealed compact={false} /></div>
      <p className="impression-success-caption">{success?.claim.hasPhoto ? "Visit and photo saved." : "Visit saved. Add a photo another time."}</p>
      {retryControl}
      <div className="impression-actions"><button className="impression-primary" type="button" onClick={closeToMap}><MapPin size={18} />Back to map</button><button className="impression-text-button" type="button" onClick={() => { if (!working) { dismissFlow(); onViewAccountRef.current?.(); } }}>See my collection</button></div>
    </section>}
  </aside>;
}
