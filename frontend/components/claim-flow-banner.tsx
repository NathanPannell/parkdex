"use client";

import { Camera, MapPin, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ClaimConfirmation, ClaimRecommendation } from "@/lib/claims-client";
import { getNativeCapabilities, type LocationSample, type PhotoAsset } from "@/lib/native-capabilities";
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
};

const EXPIRY_SAFETY_MS = 8_000;

function validForPlace(recommendation: ClaimRecommendation | null, placeId: string): recommendation is Extract<ClaimRecommendation, { status: "recommended" }> {
  return recommendation?.status === "recommended"
    && recommendation.candidate.placeId === placeId
    && Date.parse(recommendation.expiresAt) - Date.now() > EXPIRY_SAFETY_MS;
}

export function ClaimFlowBanner({ place, recommendation, ownerKey, busy, recommendClaim, createClaim, reconcileClaim, uploadPhoto, onClaimed, onFlowActiveChange, onClearRecommendation }: Props) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [terminalError, setTerminalError] = useState(false);
  const [retry, setRetry] = useState<
    { stage: "claim"; file: File } |
    { stage: "upload"; confirmation: ClaimConfirmation; file: File } |
    { stage: "cleanup"; confirmation: ClaimConfirmation } |
    null
  >(null);
  const operationRef = useRef(0);
  const workingRef = useRef(false);
  const busyRef = useRef(busy);
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

  useEffect(() => () => { operationRef.current += 1; }, []);
  useEffect(() => { onFlowActiveChangeRef.current = onFlowActiveChange; }, [onFlowActiveChange]);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  useEffect(() => {
    if (!isDurablePhotoOwner(ownerKey) || !retryStore) {
      queueMicrotask(() => setHydration({ key: hydrationKey, status: "failed" }));
      return;
    }
    let active = true;
    void retryStore.load(ownerKey, place.id).then((photo) => {
      if (!active) return;
      setHydration({ key: hydrationKey, status: "ready" });
      if (photo) {
        setRetry({ stage: "claim", file: photo.file });
        setMessage("Your saved photo is ready. Finish the postcard without reopening the camera.");
        onFlowActiveChangeRef.current(place.id);
      } else {
        setMessage("");
      }
    }).catch(() => {
      if (!active) return;
      setHydration({ key: hydrationKey, status: "failed" });
      setMessage("Parkdex could not safely check for an existing photo. Retry before taking another one.");
    });
    return () => { active = false; };
  }, [hydrationAttempt, hydrationKey, ownerKey, place.id, retryStore]);

  async function persist(photo: PhotoAsset) {
    if (!isDurablePhotoOwner(ownerKey) || !retryStore) throw new Error("Private photo storage is not ready. Wait for your account to finish loading, then try again.");
    const saved = await retryStore.save(ownerKey, place.id, photo);
    if (saved === false) throw new Error("The photo could not be saved on this device. Free some storage, then try again.");
  }

  async function removePersisted() {
    if (isDurablePhotoOwner(ownerKey) && retryStore) await retryStore.remove(ownerKey, place.id);
  }

  function pauseForAccountChange(file: File, confirmation?: ClaimConfirmation) {
    if (!busyRef.current) return false;
    setRetry(confirmation ? { stage: "upload", confirmation, file } : { stage: "claim", file });
    setMessage(confirmation
      ? "Your visit is saved. Finish the photo after the account change completes."
      : "Your photo is saved. Finish the postcard after the account change completes.");
    return true;
  }

  async function completeUpload(confirmation: ClaimConfirmation, file: File, operation: number) {
    if (pauseForAccountChange(file, confirmation)) return;
    try {
      if (!confirmation.claim.hasPhoto) await uploadPhoto(place.id, file);
    } catch {
      if (operationRef.current !== operation) return;
      setRetry({ stage: "upload", confirmation, file });
      setMessage("Your visit is saved. The photo is waiting to upload, and your postcard will appear when it finishes.");
      return;
    }
    if (operationRef.current !== operation) return;
    onClaimed(confirmation);
    try {
      await removePersisted();
    } catch {
      if (operationRef.current !== operation) return;
      setRetry({ stage: "cleanup", confirmation });
      setMessage("Your postcard is created. Parkdex still needs to remove the private retry copy from this device.");
      return;
    }
    if (operationRef.current !== operation) return;
    setRetry(null);
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
        const freshLocation = await getNativeCapabilities().getCurrentLocation({ highAccuracy: true, timeoutMs: 12_000, maxAgeMs: 0 });
        if (operationRef.current !== operation) return;
        if (pauseForAccountChange(file)) return;
        const fresh = await recommendClaim({ location: freshLocation });
        if (operationRef.current !== operation) return;
        if (pauseForAccountChange(file)) return;
        if (!validForPlace(fresh, place.id)) {
          await removePersisted();
          setRetry(null);
          setMessage("Parkdex could not confirm that you are still in this park. Stay inside the boundary and try again.");
          setTerminalError(true);
          onClearRecommendation();
          return;
        }
        try {
          confirmation = await createClaim({ recommendationToken: fresh.recommendationToken, expectedPlaceId: place.id });
        } catch (claimError) {
          // A claim can commit even when its response is lost. Re-read the
          // account before offering a retry so the only photo is never discarded.
          try { confirmation = await reconcileClaim(place.id); } catch { /* Preserve the original claim error below. */ }
          if (!confirmation) throw claimError;
        }
      }
      if (operationRef.current !== operation) return;
      if (pauseForAccountChange(file, confirmation)) return;
      await completeUpload(confirmation, file, operation);
    } catch (error) {
      if (operationRef.current !== operation) return;
      setRetry({ stage: "claim", file });
      setMessage(error instanceof Error ? `${error.message} Your photo is saved, so you can retry without reopening the camera.` : "Your photo is saved. Try finishing the claim again.");
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
    try {
      // The camera comes first. Cancelling must not redeem the server recommendation.
      const photo = await getNativeCapabilities().getPhoto();
      if (operationRef.current !== operation) return;
      if (busyRef.current) {
        onFlowActiveChange(null);
        return;
      }
      if (!photo) {
        onFlowActiveChange(null);
        return;
      }
      await persist(photo);
      if (operationRef.current !== operation) return;
      if (pauseForAccountChange(photo.file)) return;
      await finishAcceptedPhoto(photo.file, operation);
    } catch (error) {
      if (operationRef.current === operation) {
        setMessage(error instanceof Error ? error.message : "Could not finish this claim. Try again.");
        onFlowActiveChange(null);
      }
    } finally {
      if (operationRef.current === operation) {
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
    if (retry.stage === "claim") {
      await finishAcceptedPhoto(retry.file, operation, true);
      if (operationRef.current === operation) {
        workingRef.current = false;
        setWorking(false);
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
        if (operationRef.current === operation) setMessage("The private retry copy is still waiting for device storage cleanup.");
      } finally {
        if (operationRef.current === operation) {
          workingRef.current = false;
          setWorking(false);
        }
      }
      return;
    }
    try {
      await completeUpload(retry.confirmation, retry.file, operation);
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
      <button type="button" onClick={() => void retryFlow()} disabled={working || busy}><RefreshCw size={17} />{working ? "Finishing…" : retry.stage === "claim" ? "Retry claim" : retry.stage === "upload" ? "Retry photo" : "Retry cleanup"}</button>
      <button className="in-park-discard" type="button" onClick={() => void discardRetry()} disabled={working} aria-label="Discard saved photo"><X size={17} /></button>
    </span> : <button className="in-park-claim" type="button" onClick={() => void claimWithCamera()} disabled={working || busy}>
      <Camera className={working ? "pulse" : undefined} size={18} />{working ? "Finishing…" : "Claim + photo"}
    </button>}
  </aside>;
}
