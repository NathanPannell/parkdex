"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PhotoUploadTimeoutError, type ClaimRecommendation } from "@/lib/claims-client";
import { fieldDiagnostics, type FieldDiagnosticFact, type FieldDiagnosticTrace } from "@/lib/field-diagnostics";
import { createPhotoCaptureAttemptId, getNativeCapabilities, RestoredPhotoAwaitingAdoptionError, type LocationSample, type PhotoAsset } from "@/lib/native-capabilities";
import { isPreparedVisitPhoto, normalizeVisitPhoto } from "@/lib/photo-processing";
import { isDurablePhotoOwner } from "@/lib/photo-retry";
import { notifyError } from "@/lib/application-notifications";
import { loadUnresolvedClaim, markUnresolvedClaim } from "@/lib/claim-recovery";
import {
  ClaimRecommendationRejectedError,
  ClaimReconciliationUnavailableError,
  ClaimReconciliationRequiredError,
  ClaimWorkflowInterruptedError,
  type ClaimCreationInput,
  type ClaimWorkflowConfirmation,
} from "@/lib/claim-workflow";
import { useClaimFlow } from "@/lib/use-claim-flow";
import type { Place } from "@/lib/places";
import type { PlaceImageRecord } from "@/lib/place-images";

type FlowScreen = "arrival" | "review" | "upload" | "success";
type ReviewPhoto = { photo: PhotoAsset; previewUrl: string | null };
type RetryState =
  | { stage: "claim"; file: File; processingState?: PhotoAsset["processingState"]; forcePhotoUpload?: boolean; reconcileFirst?: boolean }
  | { stage: "upload"; confirmation: ClaimWorkflowConfirmation; file: File; forcePhotoUpload?: boolean }
  | { stage: "cleanup"; confirmation: ClaimWorkflowConfirmation }
  | null;

export type ArrivalClaimFlowProps = {
  place: Place;
  /** Cached place imagery supplied by the app layer when available. */
  arrivalPhotoUrl?: string | null;
  arrivalImage?: PlaceImageRecord | null;
  recommendation: Extract<ClaimRecommendation, { status: "recommended" }>;
  ownerKey: string;
  busy: boolean;
  recommendClaim: (input: { location: LocationSample }) => Promise<ClaimRecommendation>;
  createClaim: (input: ClaimCreationInput) => Promise<ClaimWorkflowConfirmation>;
  reconcileClaim: (placeId: string) => Promise<ClaimWorkflowConfirmation | null>;
  uploadPhoto: (placeId: string, file: File) => Promise<void>;
  onClaimed: (confirmation: ClaimWorkflowConfirmation) => void;
  onCompleted?: (confirmation: ClaimWorkflowConfirmation) => void;
  onDismiss?: () => void;
  onViewAccount?: () => void;
  onFlowActiveChange: (placeId: string | null) => void;
  onClearRecommendation: () => void;
  /** Incremented after account progress reset to invalidate any in-flight claim. */
  resetSignal?: number;
};

const RETRY_HYDRATION_TIMEOUT_MS = 8_000;

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

export function useArrivalClaimFlow({
  place,
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
}: ArrivalClaimFlowProps) {
  const [flowScreen, setFlowScreen] = useState<FlowScreen>("arrival");
  const claimFlow = useClaimFlow(ownerKey, place.id);
  const { working, stage: workStage } = claimFlow;
  const invalidateClaimFlow = claimFlow.invalidate;
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState<RetryState>(null);
  const [noPhotoRetry, setNoPhotoRetry] = useState(false);
  const [noPhotoReconciliationRequired, setNoPhotoReconciliationRequired] = useState(false);
  const [reviewPhoto, setReviewPhoto] = useState<ReviewPhoto | null>(null);
  const [successPhotoUrl, setSuccessPhotoUrl] = useState<string | null>(null);
  const [successConfirmation, setSuccessConfirmation] = useState<ClaimWorkflowConfirmation | null>(null);
  const [hydration, setHydration] = useState<{ key: string; status: "loading" | "ready" | "failed" }>(() => {
    const store = getNativeCapabilities().photoRetry;
    return { key: `${ownerKey}\u0000${place.id}`, status: isDurablePhotoOwner(ownerKey) && Boolean(store) ? "loading" : "failed" };
  });
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const [diagnosticRetryCount, setDiagnosticRetryCount] = useState(0);
  const diagnosticRef = useRef<FieldDiagnosticTrace | null>(null);
  const workingRef = claimFlow.workingRef;
  const busyRef = useRef(busy);
  const restoredCaptureAttemptRef = useRef<string | null>(null);
  const reviewPhotoRef = useRef<ReviewPhoto | null>(null);
  const successPhotoUrlRef = useRef<string | null>(null);
  const completedRef = useRef<string | null>(null);
  const hydratedReviewRef = useRef(false);
  const forcePhotoUploadRef = useRef(false);
  const onFlowActiveChangeRef = useRef(onFlowActiveChange);
  const onClearRecommendationRef = useRef(onClearRecommendation);
  const onDismissRef = useRef(onDismiss);
  const onViewAccountRef = useRef(onViewAccount);
  const onCompletedRef = useRef(onCompleted);
  const retryStore = getNativeCapabilities().photoRetry;
  const hydrationKey = `${ownerKey}\u0000${place.id}`;
  const flowIdentityRef = useRef(hydrationKey);
  const hydrationStatus = hydration.key === hydrationKey ? hydration.status : "loading";

  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { onFlowActiveChangeRef.current = onFlowActiveChange; }, [onFlowActiveChange]);
  useEffect(() => { onClearRecommendationRef.current = onClearRecommendation; }, [onClearRecommendation]);
  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => { onViewAccountRef.current = onViewAccount; }, [onViewAccount]);
  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);

  useEffect(() => {
    if (flowIdentityRef.current === hydrationKey) return;
    flowIdentityRef.current = hydrationKey;
    restoredCaptureAttemptRef.current = null;
    const reviewUrl = reviewPhotoRef.current?.previewUrl;
    const successUrl = successPhotoUrlRef.current;
    if (reviewUrl) revokePreview(reviewUrl);
    if (successUrl && successUrl !== reviewUrl) revokePreview(successUrl);
    reviewPhotoRef.current = null;
    successPhotoUrlRef.current = null;
    hydratedReviewRef.current = false;
    forcePhotoUploadRef.current = false;
    setReviewPhoto(null);
    setRetry(null);
    setNoPhotoRetry(false);
    setNoPhotoReconciliationRequired(false);
    setMessage("");
    setSuccessPhotoUrl(null);
    setSuccessConfirmation(null);
    setFlowScreen("arrival");
    onFlowActiveChangeRef.current(null);
  }, [hydrationKey]);

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

  const invalidate = useCallback(() => {
    invalidateClaimFlow();
    restoredCaptureAttemptRef.current = null;
  }, [invalidateClaimFlow]);
  const isWorking = useCallback(() => workingRef.current, [workingRef]);

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
    setNoPhotoReconciliationRequired(false);
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
  }, [invalidate]);

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
      setRetry(null);
      setNoPhotoRetry(false);
      setNoPhotoReconciliationRequired(false);
      setMessage("");
      setSuccessPhotoUrl(null);
      setSuccessConfirmation(null);
    });
    onFlowActiveChangeRef.current(null);
    onClearRecommendationRef.current();
  }, [invalidate, resetSignal]);

  useEffect(() => {
    if (!isDurablePhotoOwner(ownerKey) || !retryStore) {
      queueMicrotask(() => setHydration({ key: hydrationKey, status: "failed" }));
      return;
    }
    let active = true;
    onFlowActiveChangeRef.current(place.id);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const load = Promise.race([
      Promise.all([retryStore.load(ownerKey, place.id), loadUnresolvedClaim(ownerKey, place.id)]),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Private photo recovery timed out.")), RETRY_HYDRATION_TIMEOUT_MS); }),
    ]);
    void load.then(([photo, unresolved]) => {
      if (!active) return;
      setHydration({ key: hydrationKey, status: "ready" });
      if (!photo) {
        if (unresolved) {
          setNoPhotoRetry(true);
          setNoPhotoReconciliationRequired(true);
          setFlowScreen("arrival");
          setMessage("Parkdex could not confirm whether your visit saved. Reconnect before retrying.");
          onFlowActiveChangeRef.current(place.id);
          return;
        }
        setFlowScreen((current) => current === "success" ? current : "arrival");
        setMessage("");
        onFlowActiveChangeRef.current(null);
        return;
      }
      hydratedReviewRef.current = true;
      replaceReviewPhoto(photo);
      setRetry({ stage: "claim", file: photo.file, processingState: photo.processingState, reconcileFirst: Boolean(unresolved) });
      setFlowScreen("review");
      setMessage(unresolved
        ? "Parkdex could not confirm whether your visit saved. Reconnect before retrying. Your photo is still saved privately."
        : "Your saved photo is ready. Keep this one or retake it before saving your visit.");
      onFlowActiveChangeRef.current(place.id);
    }).catch(() => {
      if (!active) return;
      setHydration({ key: hydrationKey, status: "failed" });
      setMessage("Parkdex could not safely check for an existing photo. Retry before taking another one.");
      onFlowActiveChangeRef.current(null);
    }).finally(() => { if (timeout) clearTimeout(timeout); });
    return () => { active = false; if (timeout) clearTimeout(timeout); };
  }, [hydrationAttempt, hydrationKey, ownerKey, place.id, resetSignal, retryStore]);

  async function persist(photo: PhotoAsset, operation: number, rawStaging = false) {
    return claimFlow.persistPhoto(operation, photo, rawStaging ? { rawStaging: true } : undefined);
  }

  async function removePersisted(operation: number) {
    await claimFlow.removePhoto(operation);
  }

  function pauseForAccountChange(file?: File, confirmation?: ClaimWorkflowConfirmation, processingState?: PhotoAsset["processingState"], forcePhotoUpload = false) {
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
      setNoPhotoReconciliationRequired(Boolean(confirmation && !confirmation.pendingSync));
      setFlowScreen("arrival");
      if (confirmation?.pendingSync) {
        setSuccessConfirmation(confirmation);
        setMessage("Saved on this device. Syncs when online.");
      } else {
        setMessage("Your location check is paused while the account changes. Retry the saved visit when it finishes.");
      }
    }
    return true;
  }

  function announceCompletion(confirmation: ClaimWorkflowConfirmation) {
    const completionKey = `${confirmation.placeId}:${confirmation.visitedAt}`;
    if (completedRef.current === completionKey) return;
    completedRef.current = completionKey;
    onClaimed(confirmation);
    onCompletedRef.current?.(confirmation);
  }

  function applyWorkflowOutcome(
    outcome: NonNullable<Awaited<ReturnType<typeof claimFlow.submit>>>,
    file: File,
    forcePhotoUpload: boolean,
  ) {
    if (outcome.status === "paused") {
      pauseForAccountChange(file, outcome.confirmation, "prepared", forcePhotoUpload);
      return;
    }
    if (outcome.status === "pending-sync") {
      setRetry({ stage: "upload", confirmation: outcome.confirmation, file, forcePhotoUpload });
      setSuccessConfirmation(outcome.confirmation);
      setMessage("Saved on this device. Syncs when online.");
      setFlowScreen("upload");
      diagnosticRef.current?.stage("claim", { summary: "Visit saved on this device for sync", facts: [{ kind: "result", value: "saved" }] });
      return;
    }
    if (outcome.status === "photo-retry" && outcome.step === "upload") {
      setRetry({ stage: "upload", confirmation: outcome.confirmation, file, forcePhotoUpload });
      setSuccessConfirmation(outcome.confirmation);
      setFlowScreen("upload");
      setMessage("Your visit is saved. Your retry photo is saved privately.");
      diagnosticRef.current?.warn("upload", { summary: outcome.error instanceof PhotoUploadTimeoutError ? "Photo upload timed out. The retry copy is safe" : "Photo upload stopped. The retry copy is safe", facts: failureFacts(outcome.error) });
      notifyError(outcome.error, "The photo could not upload. Your private retry copy is safe.");
      return;
    }

    const completed = outcome.confirmation;
    announceCompletion(completed);
    setSuccessPreview(file);
    setSuccessConfirmation(completed);
    setNoPhotoRetry(false);
    setNoPhotoReconciliationRequired(false);
    if (outcome.status === "photo-retry" && outcome.step === "cleanup") {
      setRetry({ stage: "cleanup", confirmation: completed });
      setFlowScreen("success");
      setMessage("Your postcard is saved. Parkdex still needs to remove the private retry copy from this device.");
      diagnosticRef.current?.warn("cleanup", { summary: "Postcard created, but the local retry copy still needs cleanup", facts: [{ kind: "result", value: "failed" }] });
      return;
    }

    setRetry(null);
    setMessage("");
    setFlowScreen("success");
    diagnosticRef.current?.succeed("cleanup", { summary: "Postcard created and retry copy removed", facts: [{ kind: "result", value: "complete" }] });
    onFlowActiveChangeRef.current(place.id);
  }

  async function completeUpload(confirmation: ClaimWorkflowConfirmation, file: File, operation: number, forcePhotoUpload = false) {
    if (pauseForAccountChange(file, confirmation, "prepared", forcePhotoUpload)) {
      setSuccessConfirmation(confirmation);
      return;
    }
    setFlowScreen("upload");
    setSuccessConfirmation(confirmation);
    setRetry({ stage: "upload", confirmation, file, forcePhotoUpload });
    diagnosticRef.current?.stage("upload", {
      summary: "Uploading the prepared photo",
      facts: [networkFact(), { kind: "file-bytes", value: file.size }, { kind: "mime-type", value: "image/jpeg" }],
    });
    const outcome = await claimFlow.deliver(operation, {
      confirmation,
      photo: { file, mimeType: file.type || "image/jpeg", processingState: "prepared" },
      forcePhotoUpload,
      uploadPhoto,
      shouldContinue: () => !busyRef.current,
    });
    if (!outcome || !claimFlow.isCurrent(operation)) return;
    applyWorkflowOutcome(outcome, file, forcePhotoUpload);
  }

  async function freshRecommendation(operation: number, pausedFile?: File, forcePhotoUpload = false) {
    diagnosticRef.current?.stage("location-recheck", { summary: "Confirming a fresh park location" });
    const result = await claimFlow.recommend(operation, recommendClaim, () => !busyRef.current);
    if (!result || !claimFlow.isCurrent(operation)) return null;
    diagnosticRef.current?.stage("location-recheck", { summary: "Fresh location received", facts: [{ kind: "elapsed-ms", value: Date.now() - result.startedAt }, { kind: "accuracy-meters", value: result.location.accuracyMeters }] });
    if (pauseForAccountChange(pausedFile, undefined, pausedFile ? "prepared" : undefined, forcePhotoUpload)) {
      throw new ClaimWorkflowInterruptedError();
    }
    return result.recommendation;
  }

  async function finishAcceptedPhoto(file: File, operation: number, reconcileFirst = false, forcePhotoUpload = false, unresolvedCreate = false) {
    try {
      if (pauseForAccountChange(file, undefined, "prepared", forcePhotoUpload)) return;
      const photo = { file, mimeType: file.type || "image/jpeg", processingState: "prepared" } satisfies PhotoAsset;
      const outcome = await claimFlow.submit(operation, {
        photo,
        photoAlreadyPersisted: true,
        forcePhotoUpload,
        reconcileFirst,
        unresolvedCreate,
        createClaim,
        reconcileClaim,
        recommendFresh: async () => (await freshRecommendation(operation, file, forcePhotoUpload)) ?? { status: "none" },
        uploadPhoto,
        shouldContinue: () => !busyRef.current,
      });
      if (!outcome || !claimFlow.isCurrent(operation)) return;
      applyWorkflowOutcome(outcome, file, forcePhotoUpload);
    } catch (error) {
      if (!claimFlow.isCurrent(operation)) return;
      if (error instanceof ClaimRecommendationRejectedError) {
        setRetry({ stage: "claim", file, processingState: "prepared", forcePhotoUpload });
        setFlowScreen("arrival");
        setMessage("Parkdex could not confirm that you are still in this park. Your photo is saved. Stay inside the boundary and retry the saved visit.");
        diagnosticRef.current?.fail("boundary-check", { summary: "The fresh location was outside the selected park boundary", facts: [{ kind: "result", value: "rejected" }] });
        onFlowActiveChangeRef.current(place.id);
        onClearRecommendationRef.current();
        return;
      }
      if (error instanceof ClaimWorkflowInterruptedError) {
        pauseForAccountChange(file, undefined, "prepared", forcePhotoUpload);
        return;
      }
      const reconcileFirst = error instanceof ClaimReconciliationRequiredError || error instanceof ClaimReconciliationUnavailableError;
      setRetry({ stage: "claim", file, processingState: "prepared", forcePhotoUpload, reconcileFirst });
      setFlowScreen("arrival");
      claimFlow.setStage(operation, null);
      if (reconcileFirst) notifyError(error, "Parkdex could not confirm whether your visit saved. Reconnect before retrying; your photo is still saved privately.");
      setMessage(reconcileFirst ? "Parkdex could not confirm whether your visit saved. Reconnect before retrying. Your photo is still saved privately." : "Your photo is saved. Try finishing the visit again.");
      diagnosticRef.current?.warn("claim", { summary: "The postcard paused after the photo was saved for retry", facts: failureFacts(error) });
    }
  }

  async function claimWithCamera() {
    if (workingRef.current || hydrationStatus !== "ready") return;
    const operation = claimFlow.begin();
    if (operation === null) return;
    setMessage("");
    setRetry(null);
    setNoPhotoRetry(false);
    setNoPhotoReconciliationRequired(false);
    onFlowActiveChangeRef.current(place.id);
    const trace = fieldDiagnostics.begin({ key: `photo:${place.id}`, flow: "photo", title: `Postcard for ${place.name}`, stage: "camera", summary: "Opening the camera", facts: [networkFact(), { kind: "result", value: "started" }] });
    diagnosticRef.current = trace;
    let savedPhoto: PhotoAsset | null = null;
    try {
      claimFlow.setStage(operation, "camera");
      const capturedPhoto = await getNativeCapabilities().getPhoto({ ownerKey, placeId: place.id, captureAttemptId: restoredCaptureAttemptRef.current ?? createPhotoCaptureAttemptId() });
      restoredCaptureAttemptRef.current = null;
      if (!claimFlow.isCurrent(operation)) return;
      if (busyRef.current) { onFlowActiveChangeRef.current(null); return; }
      if (!capturedPhoto) {
        trace.succeed("camera", { summary: "Camera closed without taking a photo", facts: [{ kind: "result", value: "cancelled" }] });
        onFlowActiveChangeRef.current(null);
        return;
      }
      trace.stage("camera", { summary: "Photo accepted from the camera", facts: [{ kind: "file-bytes", value: capturedPhoto.file.size }, { kind: "result", value: "accepted" }] });
      claimFlow.setStage(operation, "saving");
      await persist(capturedPhoto, operation, true);
      if (!claimFlow.isCurrent(operation)) return;
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
      if (claimFlow.isCurrent(operation)) {
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
      if (claimFlow.isCurrent(operation)) {
        claimFlow.setStage(operation, null);
        claimFlow.finish(operation);
      }
    }
  }

  async function retakePhoto() {
    if (workingRef.current || !reviewPhotoRef.current) return;
    const operation = claimFlow.begin();
    if (operation === null) return;
    claimFlow.setStage(operation, "camera");
    setMessage("");
    onFlowActiveChangeRef.current(place.id);
    try {
      const capturedPhoto = await getNativeCapabilities().getPhoto({ ownerKey, placeId: place.id, captureAttemptId: restoredCaptureAttemptRef.current ?? createPhotoCaptureAttemptId() });
      restoredCaptureAttemptRef.current = null;
      if (!claimFlow.isCurrent(operation)) return;
      if (busyRef.current) { setMessage("Your current photo is still saved while the account changes."); return; }
      if (!capturedPhoto) { setMessage("Your current photo is still selected."); return; }
      const replacingHydratedPhoto = hydratedReviewRef.current || forcePhotoUploadRef.current;
      await persist(capturedPhoto, operation, true);
      if (!claimFlow.isCurrent(operation)) return;
      forcePhotoUploadRef.current = replacingHydratedPhoto;
      replaceReviewPhoto(capturedPhoto);
      setRetry({ stage: "claim", file: capturedPhoto.file, processingState: capturedPhoto.processingState ?? "raw", forcePhotoUpload: replacingHydratedPhoto });
      setMessage("New photo ready. Keep this one or retake it again.");
      onFlowActiveChangeRef.current(place.id);
    } catch (error) {
      if (claimFlow.isCurrent(operation)) {
        if (error instanceof RestoredPhotoAwaitingAdoptionError) restoredCaptureAttemptRef.current = error.captureAttemptId;
        setMessage(`${error instanceof Error ? error.message : "The replacement photo could not be saved."} Your current photo is still saved.`);
        onFlowActiveChangeRef.current(place.id);
      }
    } finally {
      if (claimFlow.isCurrent(operation)) {
        claimFlow.setStage(operation, null);
        claimFlow.finish(operation);
      }
    }
  }

  async function saveReviewedPhoto() {
    const current = reviewPhotoRef.current;
    if (!current || workingRef.current) return;
    const operation = claimFlow.begin();
    if (operation === null) return;
    setMessage("");
    claimFlow.setStage(operation, "processing");
    onFlowActiveChangeRef.current(place.id);
    try {
      const forcePhotoUpload = forcePhotoUploadRef.current;
      if (pauseForAccountChange(current.photo.file, undefined, current.photo.processingState, forcePhotoUpload)) return;
      const prepared = isPreparedVisitPhoto(current.photo) ? current.photo : await normalizeVisitPhoto(current.photo);
      if (!claimFlow.isCurrent(operation)) return;
      claimFlow.setStage(operation, "saving");
      await persist(prepared, operation);
      if (!claimFlow.isCurrent(operation)) return;
      replaceReviewPhoto(prepared);
      setRetry({ stage: "claim", file: prepared.file, processingState: prepared.processingState, forcePhotoUpload });
      setFlowScreen("upload");
      await finishAcceptedPhoto(prepared.file, operation, hydratedReviewRef.current, forcePhotoUpload, Boolean(retry?.stage === "claim" && retry.reconcileFirst));
    } catch (error) {
      if (claimFlow.isCurrent(operation)) {
        setFlowScreen("review");
        claimFlow.setStage(operation, null);
        setMessage(`${error instanceof Error ? error.message : "The photo could not be prepared."} Your saved photo is still available.`);
      }
    } finally {
      if (claimFlow.isCurrent(operation)) {
        claimFlow.setStage(operation, null);
        claimFlow.finish(operation);
      }
    }
  }

  async function claimWithoutPhoto() {
    if (workingRef.current || hydrationStatus !== "ready") return;
    const operation = claimFlow.begin();
    if (operation === null) return;
    const retryingNoPhoto = noPhotoRetry && noPhotoReconciliationRequired;
    setNoPhotoRetry(false);
    setNoPhotoReconciliationRequired(false);
    setRetry(null);
    setMessage("");
    setFlowScreen("upload");
    onFlowActiveChangeRef.current(place.id);
    const trace = fieldDiagnostics.begin({ key: `location-claim:${place.id}`, flow: "location", title: `Visit at ${place.name}`, stage: "location-recheck", summary: "Confirming a fresh park location", facts: [networkFact(), { kind: "result", value: "started" }] });
    diagnosticRef.current = trace;
    try {
      if (pauseForAccountChange()) return;
      const outcome = await claimFlow.submit(operation, {
        reconcileFirst: retryingNoPhoto,
        unresolvedCreate: retryingNoPhoto,
        recommendFresh: async () => (await freshRecommendation(operation)) ?? { status: "none" },
        createClaim,
        reconcileClaim,
        uploadPhoto,
        shouldContinue: () => !busyRef.current,
      });
      if (!outcome || !claimFlow.isCurrent(operation)) return;
      if (outcome.status === "paused") {
        pauseForAccountChange(undefined, outcome.confirmation);
        return;
      }
      if (outcome.status === "pending-sync") {
        setNoPhotoRetry(true);
        setNoPhotoReconciliationRequired(false);
        setFlowScreen("arrival");
        setMessage("Saved on this device. Syncs when online.");
        setSuccessConfirmation(outcome.confirmation);
        trace.stage("claim", { summary: "Visit saved on this device for sync", facts: [{ kind: "result", value: "saved" }] });
        return;
      }
      if (outcome.status !== "confirmed") return;
      setNoPhotoRetry(false);
      setNoPhotoReconciliationRequired(false);
      trace.succeed("claim", { summary: "Visit saved without a photo", facts: [{ kind: "result", value: "saved" }] });
      announceCompletion(outcome.confirmation);
      setSuccessConfirmation(outcome.confirmation);
      setSuccessPreview(undefined);
      setMessage("");
      claimFlow.setStage(operation, null);
      setFlowScreen("success");
      onFlowActiveChangeRef.current(place.id);
    } catch (error) {
      if (claimFlow.isCurrent(operation)) {
        setNoPhotoRetry(true);
        setNoPhotoReconciliationRequired(error instanceof ClaimReconciliationRequiredError || error instanceof ClaimReconciliationUnavailableError);
        setFlowScreen("arrival");
        claimFlow.setStage(operation, null);
        if (error instanceof ClaimRecommendationRejectedError) {
          setMessage("Parkdex could not confirm that you are still in this park. Stay inside the boundary and retry the saved visit.");
          trace.fail("boundary-check", { summary: "The fresh location was outside the selected park boundary", facts: [{ kind: "result", value: "rejected" }] });
          onClearRecommendationRef.current();
        } else if (error instanceof ClaimWorkflowInterruptedError) {
          pauseForAccountChange();
        } else if (error instanceof ClaimReconciliationRequiredError || error instanceof ClaimReconciliationUnavailableError) {
          notifyError(error, "Parkdex could not confirm whether your visit saved. Reconnect before retrying.");
          setMessage("Parkdex could not confirm whether your visit saved. Reconnect before retrying.");
          trace.warn("claim", { summary: "The saved visit needs reconciliation before retry", facts: failureFacts(error) });
        } else {
          notifyError(error, "Your visit could not be saved. Retry it when you are ready.");
          setMessage("Your visit could not be saved. Retry the saved visit when you’re ready.");
          trace.warn("claim", { summary: "The no-photo visit paused for retry", facts: failureFacts(error) });
        }
      }
    } finally {
      if (claimFlow.isCurrent(operation)) {
        claimFlow.finish(operation);
      }
    }
  }

  async function retryFlow() {
    if (workingRef.current) return;
    if (noPhotoRetry) { await claimWithoutPhoto(); return; }
    if (!retry) return;
    const operation = claimFlow.begin();
    if (operation === null) return;
    setMessage("");
    const retryAttempt = diagnosticRetryCount + 1;
    setDiagnosticRetryCount(retryAttempt);
    const retryTrace = diagnosticRef.current ?? fieldDiagnostics.begin({ key: `photo:${place.id}`, flow: "photo", title: `Postcard for ${place.name}`, stage: retry.stage === "upload" ? "upload" : retry.stage === "cleanup" ? "cleanup" : "claim", summary: "Resuming the saved postcard", facts: [{ kind: "retry-attempt", value: retryAttempt }, networkFact()] });
    diagnosticRef.current = retryTrace;
    retryTrace.stage(retry.stage === "upload" ? "upload" : retry.stage === "cleanup" ? "cleanup" : "claim", { summary: "Retrying the saved postcard", facts: [{ kind: "retry-attempt", value: retryAttempt }, networkFact()] });

    if (retry.stage === "claim") {
      try {
        setFlowScreen("upload");
        claimFlow.setStage(operation, "processing");
        const retryPhoto = { file: retry.file, mimeType: retry.file.type || "application/octet-stream", processingState: retry.processingState } satisfies PhotoAsset;
        const alreadyPrepared = isPreparedVisitPhoto(retryPhoto);
        const prepared = alreadyPrepared ? retryPhoto : await normalizeVisitPhoto(retryPhoto);
        if (!claimFlow.isCurrent(operation)) return;
        if (!alreadyPrepared) {
          claimFlow.setStage(operation, "saving");
          await persist(prepared, operation);
          if (!claimFlow.isCurrent(operation)) return;
        }
        replaceReviewPhoto(prepared);
        setRetry({ stage: "claim", file: prepared.file, processingState: prepared.processingState, forcePhotoUpload: retry.forcePhotoUpload, reconcileFirst: retry.reconcileFirst });
        await finishAcceptedPhoto(prepared.file, operation, Boolean(retry.reconcileFirst), retry.forcePhotoUpload, Boolean(retry.reconcileFirst));
      } catch (error) {
        if (claimFlow.isCurrent(operation)) {
          setFlowScreen("arrival");
          claimFlow.setStage(operation, null);
          setMessage(`${error instanceof Error ? error.message : "The saved photo could not be prepared."} Your original photo is still saved.`);
        }
      } finally {
        if (claimFlow.isCurrent(operation)) claimFlow.finish(operation);
      }
      return;
    }

    if (retry.stage === "cleanup") {
      try {
        claimFlow.setStage(operation, "cleanup");
        await removePersisted(operation);
        if (!claimFlow.isCurrent(operation)) return;
        setRetry(null);
        claimFlow.setStage(operation, null);
        setMessage("");
        setFlowScreen("success");
        onFlowActiveChangeRef.current(place.id);
      } catch {
        if (claimFlow.isCurrent(operation)) { claimFlow.setStage(operation, null); setMessage("The private retry copy is still waiting for device storage cleanup."); retryTrace.warn("cleanup", { summary: "Local retry cleanup is still waiting", facts: [{ kind: "result", value: "failed" }] }); }
      } finally {
        if (claimFlow.isCurrent(operation)) claimFlow.finish(operation);
      }
      return;
    }

    try {
      setFlowScreen("upload");
      claimFlow.setStage(operation, "claim");
      const reconciled = await reconcileClaim(place.id);
      if (!claimFlow.isCurrent(operation)) return;
      await completeUpload(reconciled ?? retry.confirmation, retry.file, operation, retry.forcePhotoUpload);
    } catch (error) {
      if (claimFlow.isCurrent(operation)) { claimFlow.setStage(operation, null); setMessage(`${error instanceof Error ? error.message : "Parkdex could not check the saved visit."} Your retry photo is still saved.`); }
    } finally {
      if (claimFlow.isCurrent(operation)) claimFlow.finish(operation);
    }
  }

  async function discardRetry() {
    if (workingRef.current || !retry) return;
    const current = retry;
    const operation = claimFlow.begin();
    if (operation === null) return;
    try {
      let reconciled: ClaimWorkflowConfirmation | null = null;
      if (current.stage === "upload" || current.stage === "cleanup") {
        try {
          claimFlow.setStage(operation, "claim");
          reconciled = await reconcileClaim(place.id);
        } catch (error) {
          if (!claimFlow.isCurrent(operation)) return;
          claimFlow.setStage(operation, null);
          setMessage(error instanceof Error ? `Parkdex could not verify the saved visit. Your photo is still saved. ${error.message}` : "Parkdex could not verify the saved visit. Your photo is still saved.");
          return;
        }
      }
      if (!claimFlow.isCurrent(operation)) return;
      if (current.stage === "upload" && current.confirmation.pendingSync) {
        setMessage("Saved on this device. Syncs when online.");
        return;
      }
      await removePersisted(operation);
      if (!claimFlow.isCurrent(operation)) return;
      if (current.stage === "claim" && current.reconcileFirst) {
        await markUnresolvedClaim(ownerKey, place.id, false).catch(() => undefined);
      }
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
      claimFlow.finish(operation);
      dismissFlow();
    } catch {
      if (claimFlow.isCurrent(operation)) setMessage("The saved photo could not be removed yet. Try again when device storage is available.");
    } finally {
      if (claimFlow.isCurrent(operation)) {
        claimFlow.finish(operation);
        claimFlow.setStage(operation, null);
      }
    }
  }

  function retryHydration() {
    setHydration({ key: hydrationKey, status: "loading" });
    setMessage("");
    setHydrationAttempt((current) => current + 1);
  }

  function closeToMap() {
    dismissFlow();
  }

  return {
    flowScreen,
    working,
    isWorking,
    workStage,
    message,
    retry,
    noPhotoRetry,
    reviewPhoto,
    successPhotoUrl,
    successConfirmation,
    hydrationStatus,
    dismissFlow,
    retryHydration,
    closeToMap,
    claimWithCamera,
    claimWithoutPhoto,
    retryFlow,
    discardRetry,
    retakePhoto,
    saveReviewedPhoto,
    openAccount: () => onViewAccountRef.current?.(),
  };

}
