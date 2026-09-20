"use client";

import { Camera, MapPin, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PhotoUploadTimeoutError, type ClaimConfirmation, type ClaimRecommendation } from "@/lib/claims-client";
import { fieldDiagnostics, type FieldDiagnosticFact, type FieldDiagnosticTrace } from "@/lib/field-diagnostics";
import { createPhotoCaptureAttemptId, getNativeCapabilities, RestoredPhotoAwaitingAdoptionError, type LocationSample, type PhotoAsset } from "@/lib/native-capabilities";
import { isPreparedVisitPhoto, normalizeVisitPhoto } from "@/lib/photo-processing";
import { isDurablePhotoOwner } from "@/lib/photo-retry";
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
  onFlowActiveChange: (placeId: string | null) => void;
  onClearRecommendation: () => void;
  /** Incremented after account progress reset to invalidate any in-flight claim. */
  resetSignal?: number;
};

const EXPIRY_SAFETY_MS = 8_000;
const RETRY_HYDRATION_TIMEOUT_MS = 8_000;
type WorkStage = "camera" | "processing" | "saving" | "location" | "claim" | "upload" | "cleanup";

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

export function ClaimFlowBanner({ place, recommendation, ownerKey, busy, recommendClaim, createClaim, reconcileClaim, uploadPhoto, onClaimed, onFlowActiveChange, onClearRecommendation, resetSignal = 0 }: Props) {
  const [working, setWorking] = useState(false);
  const [workStage, setWorkStage] = useState<WorkStage | null>(null);
  const [message, setMessage] = useState("");
  const [terminalError, setTerminalError] = useState(false);
  const [retry, setRetry] = useState<
    { stage: "claim"; file: File; processingState?: PhotoAsset["processingState"] } |
    { stage: "upload"; confirmation: ClaimConfirmation; file: File } |
    { stage: "cleanup"; confirmation: ClaimConfirmation } |
    null
  >(null);
  const operationRef = useRef(0);
  const diagnosticRef = useRef<FieldDiagnosticTrace | null>(null);
  const diagnosticRetryRef = useRef(0);
  const workingRef = useRef(false);
  const busyRef = useRef(busy);
  const restoredCaptureAttemptRef = useRef<string | null>(null);
  const onFlowActiveChangeRef = useRef(onFlowActiveChange);
  const retryStore = getNativeCapabilities().photoRetry;
  const hydrationKey = `${ownerKey}\u0000${place.id}`;
  const canHydrate = isDurablePhotoOwner(ownerKey) && Boolean(retryStore);
  const [hydration, setHydration] = useState<{ key: string; status: "loading" | "ready" | "failed" }>({
    key: hydrationKey,
    status: canHydrate ? "loading" : "failed",
  });
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const hydrationStatus = hydration.key === hydrationKey ? hydration.status : "loading";

  useEffect(() => () => {
    operationRef.current += 1;
    // The parent uses this flag to keep account reset actions out of an
    // active claim. Clear it when the banner leaves the tree as well, such as
    // after location drift or navigation away from the map.
    onFlowActiveChangeRef.current(null);
  }, []);
  useEffect(() => { onFlowActiveChangeRef.current = onFlowActiveChange; }, [onFlowActiveChange]);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { restoredCaptureAttemptRef.current = null; }, [hydrationKey]);
  useEffect(() => {
    if (resetSignal === 0) return;
    // Reset Everything owns the account boundary. Invalidate work that may
    // still be awaiting the camera, location, claim, or upload so a late
    // completion cannot re-open this flow after the account was cleared.
    operationRef.current += 1;
    workingRef.current = false;
    restoredCaptureAttemptRef.current = null;
    queueMicrotask(() => {
      setWorking(false);
      setWorkStage(null);
      setRetry(null);
      setMessage("");
      setTerminalError(false);
    });
    onFlowActiveChangeRef.current(null);
    onClearRecommendation();
  }, [onClearRecommendation, resetSignal]);

  useEffect(() => {
    if (!isDurablePhotoOwner(ownerKey) || !retryStore) {
      queueMicrotask(() => setHydration({ key: hydrationKey, status: "failed" }));
      return;
    }
    let active = true;
    // Treat the durable read as active claim work. Reset/sign-out controls stay
    // disabled until this read settles, so clearOwner cannot race a queued
    // normalization save and accidentally resurrect a discarded photo.
    onFlowActiveChangeRef.current(place.id);
    let hydrationTimeout: ReturnType<typeof setTimeout> | undefined;
    const boundedLoad = Promise.race([
      retryStore.load(ownerKey, place.id),
      new Promise<never>((_, reject) => {
        hydrationTimeout = setTimeout(() => reject(new Error("Private photo recovery timed out.")), RETRY_HYDRATION_TIMEOUT_MS);
      }),
    ]);
    void boundedLoad.then(async (photo) => {
      if (!active) return;
      if (!photo) {
        setHydration({ key: hydrationKey, status: "ready" });
        setMessage("");
        onFlowActiveChangeRef.current(null);
        return;
      }
      let retryPhoto = photo;
      try {
        if (!isPreparedVisitPhoto(photo)) {
          retryPhoto = await normalizeVisitPhoto(photo);
          if (!active) return;
          const saved = await retryStore.save(ownerKey, place.id, retryPhoto);
          if (saved === false) throw new Error("The prepared retry photo could not be saved.");
        }
      } catch {
        // Keep the accepted original. A later retry will attempt normalization
        // again before any claim or upload request is sent.
        retryPhoto = photo;
      }
      if (!active) return;
      setHydration({ key: hydrationKey, status: "ready" });
      setRetry({ stage: "claim", file: retryPhoto.file, processingState: retryPhoto.processingState });
      setMessage("Your saved photo is ready. Finish the postcard without reopening the camera.");
      onFlowActiveChangeRef.current(place.id);
    }).catch(() => {
      if (!active) return;
      setHydration({ key: hydrationKey, status: "failed" });
      setMessage("Parkdex could not safely check for an existing photo. Retry before taking another one.");
      onFlowActiveChangeRef.current(null);
    }).finally(() => {
      if (hydrationTimeout) clearTimeout(hydrationTimeout);
    });
    return () => {
      active = false;
      if (hydrationTimeout) clearTimeout(hydrationTimeout);
    };
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

  function pauseForAccountChange(file: File, confirmation?: ClaimConfirmation) {
    if (!busyRef.current) return false;
    setRetry(confirmation ? { stage: "upload", confirmation, file } : { stage: "claim", file, processingState: "prepared" });
    setMessage(confirmation
      ? "Your visit is saved. Finish the photo after the account change completes."
      : "Your photo is saved. Finish the postcard after the account change completes.");
    return true;
  }

  async function completeUpload(confirmation: ClaimConfirmation, file: File, operation: number) {
    if (pauseForAccountChange(file, confirmation)) return;
    try {
      setWorkStage("upload");
      diagnosticRef.current?.stage("upload", {
        summary: confirmation.claim.hasPhoto ? "Checking the photo already saved with this visit" : "Uploading the prepared photo",
        facts: [networkFact(), { kind: "file-bytes", value: file.size }, { kind: "mime-type", value: "image/jpeg" }],
      });
      if (!confirmation.claim.hasPhoto) await uploadPhoto(place.id, file);
      diagnosticRef.current?.stage("upload", {
        summary: confirmation.claim.hasPhoto ? "The server already has this photo" : "Photo upload completed",
        facts: [{ kind: "result", value: "saved" }],
      });
    } catch (error) {
      if (operationRef.current !== operation) return;
      setRetry({ stage: "upload", confirmation, file });
      setWorkStage(null);
      setMessage(`Your visit is saved. The retry photo is saved too. ${error instanceof Error ? error.message : "The photo upload did not finish."}`);
      diagnosticRef.current?.warn("upload", {
        summary: error instanceof PhotoUploadTimeoutError ? "Photo upload timed out. The retry copy is safe" : "Photo upload stopped. The retry copy is safe",
        facts: failureFacts(error),
      });
      return;
    }
    if (operationRef.current !== operation) return;
    onClaimed(confirmation);
    try {
      setWorkStage("cleanup");
      diagnosticRef.current?.stage("cleanup", { summary: "Removing the private retry copy from this device" });
      await removePersisted();
    } catch {
      if (operationRef.current !== operation) return;
      setRetry({ stage: "cleanup", confirmation });
      setMessage("Your postcard is created. Parkdex still needs to remove the private retry copy from this device.");
      diagnosticRef.current?.warn("cleanup", {
        summary: "Postcard created, but the local retry copy still needs cleanup",
        facts: [{ kind: "result", value: "failed" }],
      });
      return;
    }
    if (operationRef.current !== operation) return;
    setRetry(null);
    setWorkStage(null);
    diagnosticRef.current?.succeed("cleanup", {
      summary: "Postcard created and retry copy removed",
      facts: [{ kind: "result", value: "complete" }],
    });
    onFlowActiveChange(null);
    onClearRecommendation();
  }

  async function finishAcceptedPhoto(file: File, operation: number, reconcileFirst = false) {
    try {
      if (pauseForAccountChange(file)) return;
      let confirmation = reconcileFirst ? await reconcileClaim(place.id) : null;
      if (operationRef.current !== operation) return;
      if (pauseForAccountChange(file, confirmation ?? undefined)) return;
      if (!confirmation) {
        // Revalidate after the external camera activity so location and token age
        // remain server-authoritative at the moment the claim is redeemed.
        setWorkStage("location");
        const locationStartedAt = Date.now();
        diagnosticRef.current?.stage("location-recheck", { summary: "Confirming a fresh park location" });
        const freshLocation = await getNativeCapabilities().getCurrentLocation({ highAccuracy: true, timeoutMs: 12_000, maxAgeMs: 0, requirePrecise: true });
        diagnosticRef.current?.stage("location-recheck", {
          summary: "Fresh location received",
          facts: [{ kind: "elapsed-ms", value: Date.now() - locationStartedAt }, { kind: "accuracy-meters", value: freshLocation.accuracyMeters }],
        });
        if (operationRef.current !== operation) return;
        if (pauseForAccountChange(file)) return;
        const fresh = await recommendClaim({ location: freshLocation });
        if (operationRef.current !== operation) return;
        if (pauseForAccountChange(file)) return;
        if (!validForPlace(fresh, place.id)) {
          setRetry({ stage: "claim", file, processingState: "prepared" });
          setMessage("Parkdex could not confirm that you are still in this park. Your photo is saved. Stay inside the boundary and retry the claim.");
          diagnosticRef.current?.fail("boundary-check", {
            summary: "The fresh location was outside the selected park boundary",
            facts: [{ kind: "result", value: "rejected" }],
          });
          onClearRecommendation();
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
      if (operationRef.current !== operation) return;
      if (pauseForAccountChange(file, confirmation)) return;
      await completeUpload(confirmation, file, operation);
    } catch (error) {
      if (operationRef.current !== operation) return;
      setRetry({ stage: "claim", file, processingState: "prepared" });
      setWorkStage(null);
      setMessage(error instanceof Error ? `${error.message} Your photo is saved, so you can retry without reopening the camera.` : "Your photo is saved. Try finishing the claim again.");
      diagnosticRef.current?.warn("claim", {
        summary: "The postcard paused after the photo was saved for retry",
        facts: failureFacts(error),
      });
    }
  }

  async function claimWithCamera() {
    if (workingRef.current || hydrationStatus !== "ready") return;
    const operation = ++operationRef.current;
    workingRef.current = true;
    setWorking(true);
    setMessage("");
    setTerminalError(false);
    onFlowActiveChange(place.id);
    diagnosticRetryRef.current = 0;
    const trace = fieldDiagnostics.begin({
      key: `photo:${place.id}`,
      flow: "photo",
      title: `Postcard for ${place.name}`,
      stage: "camera",
      summary: "Opening the camera",
      facts: [networkFact(), { kind: "result", value: "started" }],
    });
    diagnosticRef.current = trace;
    let diagnosticStage: "camera" | "local-save" = "camera";
    let savedPhoto: PhotoAsset | null = null;
    try {
      // The camera comes first. Cancelling must not redeem the server recommendation.
      setWorkStage("camera");
      const capturedPhoto = await getNativeCapabilities().getPhoto({
        ownerKey,
        placeId: place.id,
        captureAttemptId: restoredCaptureAttemptRef.current ?? createPhotoCaptureAttemptId(),
      });
      restoredCaptureAttemptRef.current = null;
      if (operationRef.current !== operation) return;
      if (busyRef.current) {
        onFlowActiveChange(null);
        return;
      }
      if (!capturedPhoto) {
        trace.succeed("camera", { summary: "Camera closed without taking a photo", facts: [{ kind: "result", value: "cancelled" }] });
        onFlowActiveChange(null);
        return;
      }
      trace.stage("camera", {
        summary: "Photo accepted from the camera",
        facts: [{ kind: "file-bytes", value: capturedPhoto.file.size }, { kind: "result", value: "accepted" }],
      });
      diagnosticStage = "local-save";
      setWorkStage("saving");
      await persist(capturedPhoto, true);
      savedPhoto = capturedPhoto;
      setRetry({ stage: "claim", file: capturedPhoto.file, processingState: capturedPhoto.processingState ?? "raw" });
      trace.stage("local-save", { summary: "Accepted camera bytes saved for crash recovery", facts: [{ kind: "result", value: "saved" }] });
      if (operationRef.current !== operation) return;
      setWorkStage("processing");
      trace.stage("local-save", { summary: "Compressing the photo for a field upload" });
      const photo = await normalizeVisitPhoto(capturedPhoto);
      trace.stage("local-save", {
        summary: "Photo prepared as a bounded JPEG",
        facts: [{ kind: "file-bytes", value: photo.file.size }, { kind: "mime-type", value: "image/jpeg" }],
      });
      if (operationRef.current !== operation) return;
      setWorkStage("saving");
      await persist(photo);
      savedPhoto = photo;
      setRetry({ stage: "claim", file: photo.file, processingState: photo.processingState });
      trace.stage("local-save", { summary: "Private retry copy saved on this device", facts: [{ kind: "result", value: "saved" }] });
      if (operationRef.current !== operation) return;
      if (pauseForAccountChange(photo.file)) return;
      await finishAcceptedPhoto(photo.file, operation);
    } catch (error) {
      if (operationRef.current === operation) {
        if (error instanceof RestoredPhotoAwaitingAdoptionError) {
          restoredCaptureAttemptRef.current = error.captureAttemptId;
          setMessage(error.message);
          onFlowActiveChange(place.id);
        } else if (savedPhoto) {
          setRetry({ stage: "claim", file: savedPhoto.file, processingState: savedPhoto.processingState });
          setMessage(`${error instanceof Error ? error.message : "The photo could not be prepared."} Your accepted photo is saved, so you can retry without reopening the camera.`);
          onFlowActiveChange(place.id);
        } else {
          setMessage(error instanceof Error ? error.message : "Could not finish this claim. Try again.");
          onFlowActiveChange(null);
        }
        trace.fail(diagnosticStage, {
          summary: diagnosticStage === "camera" ? "The camera could not return a usable photo" : "The photo could not be prepared or saved",
          facts: failureFacts(error),
        });
      }
    } finally {
      if (operationRef.current === operation) {
        setWorkStage(null);
        workingRef.current = false;
        setWorking(false);
      }
    }
  }

  async function retryFlow() {
    if (!retry) return;
    if (workingRef.current) return;
    const operation = ++operationRef.current;
    workingRef.current = true;
    setWorking(true);
    setMessage("");
    diagnosticRetryRef.current += 1;
    const retryTrace = diagnosticRef.current ?? fieldDiagnostics.begin({
      key: `photo:${place.id}`,
      flow: "photo",
      title: `Postcard for ${place.name}`,
      stage: retry.stage === "upload" ? "upload" : retry.stage === "cleanup" ? "cleanup" : "claim",
      summary: "Resuming the saved postcard",
      facts: [{ kind: "retry-attempt", value: diagnosticRetryRef.current }, networkFact()],
    });
    diagnosticRef.current = retryTrace;
    retryTrace.stage(retry.stage === "upload" ? "upload" : retry.stage === "cleanup" ? "cleanup" : "claim", {
      summary: "Retrying the saved postcard",
      facts: [{ kind: "retry-attempt", value: diagnosticRetryRef.current }, networkFact()],
    });
    if (retry.stage === "claim") {
      try {
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
        setRetry({ stage: "claim", file: prepared.file, processingState: prepared.processingState });
        await finishAcceptedPhoto(prepared.file, operation, true);
      } catch (error) {
        if (operationRef.current === operation) {
          setWorkStage(null);
          setMessage(`${error instanceof Error ? error.message : "The saved photo could not be prepared."} Your original photo is still saved.`);
        }
      } finally {
        if (operationRef.current === operation) {
          workingRef.current = false;
          setWorking(false);
        }
      }
      return;
    }
    if (retry.stage === "cleanup") {
      try {
        await removePersisted();
        if (operationRef.current !== operation) return;
        setRetry(null);
        onFlowActiveChange(null);
        onClearRecommendation();
      } catch {
        if (operationRef.current === operation) {
          setMessage("The private retry copy is still waiting for device storage cleanup.");
          retryTrace.warn("cleanup", { summary: "Local retry cleanup is still waiting", facts: [{ kind: "result", value: "failed" }] });
        }
      } finally {
        if (operationRef.current === operation) {
          workingRef.current = false;
          setWorking(false);
        }
      }
      return;
    }
    try {
      setWorkStage("claim");
      const reconciled = await reconcileClaim(place.id);
      if (operationRef.current !== operation) return;
      await completeUpload(reconciled ?? retry.confirmation, retry.file, operation);
    } catch (error) {
      if (operationRef.current === operation) {
        setWorkStage(null);
        setMessage(`${error instanceof Error ? error.message : "Parkdex could not check the saved visit."} Your retry photo is still saved.`);
      }
    } finally {
      if (operationRef.current === operation) {
        workingRef.current = false;
        setWorking(false);
      }
    }
  }

  async function discardRetry() {
    try {
      await removePersisted();
      const confirmation = retry?.stage === "upload" || retry?.stage === "cleanup" ? retry.confirmation : null;
      setRetry(null);
      onFlowActiveChange(null);
      onClearRecommendation();
      if (confirmation) onClaimed(confirmation);
    } catch {
      setMessage("The saved photo could not be removed yet. Try again when device storage is available.");
    }
  }

  function dismissTerminalError() {
    setTerminalError(false);
    onFlowActiveChange(null);
  }

  function retryHydration() {
    setHydration({ key: hydrationKey, status: "loading" });
    setMessage("");
    setHydrationAttempt((current) => current + 1);
  }

  const workingLabel = workStage ? STAGE_LABELS[workStage] : "Finishing…";

  return <aside className="in-park-banner" role={message ? "alert" : "status"} aria-live="polite">
    <span className="in-park-marker"><MapPin size={19} /></span>
    <div className="in-park-copy">
      <strong>{hydrationStatus === "loading" ? "Checking saved photos" : hydrationStatus === "failed" ? "Saved photo unavailable" : terminalError ? "Couldn’t confirm location" : retry ? "Finish your postcard" : recommendation.candidate.matchKind === "exact" ? `You’re in ${place.name}` : `You’re near ${place.name}`}</strong>
      <p>{message || (hydrationStatus === "loading" ? "Making sure an earlier photo is not overwritten." : recommendation.candidate.matchKind === "exact" ? "Your live location is inside the park boundary." : `You’re ${Math.round(recommendation.candidate.distanceMeters)} m from the park boundary.`)}</p>
    </div>
    {hydrationStatus === "loading" ? <span className="in-park-actions">
      <button type="button" disabled><RefreshCw className="pulse" size={17} />Checking…</button>
    </span> : hydrationStatus === "failed" ? <span className="in-park-actions">
      <button type="button" onClick={retryHydration}><RefreshCw size={17} />Retry saved photo</button>
    </span> : terminalError ? <span className="in-park-actions">
      <button type="button" onClick={dismissTerminalError}><X size={17} />Dismiss</button>
    </span> : retry ? <span className="in-park-actions">
      <button type="button" onClick={() => void retryFlow()} disabled={working || busy}><RefreshCw size={17} />{working ? workingLabel : retry.stage === "claim" ? "Retry claim" : retry.stage === "upload" ? "Retry photo" : "Retry cleanup"}</button>
      <button className="in-park-discard" type="button" onClick={() => void discardRetry()} disabled={working} aria-label="Discard saved photo"><X size={17} /></button>
    </span> : <button className="in-park-claim" type="button" onClick={() => void claimWithCamera()} disabled={working || busy}>
      <Camera className={working ? "pulse" : undefined} size={18} />{working ? workingLabel : "Claim + photo"}
    </button>}
  </aside>;
}
