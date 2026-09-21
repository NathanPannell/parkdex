"use client";
/* eslint-disable @next/next/no-img-element -- native camera previews use temporary object URLs */

import { Camera, Check, LocateFixed, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiError, Visit } from "@/lib/account";
import type { ClaimConfirmation, ClaimRecommendation } from "@/lib/claims-client";
import { clearPhotoRetryOwner, createPhotoCaptureAttemptId, getNativeCapabilities, LocationCapabilityError, RestoredPhotoAwaitingAdoptionError, type LocationSample, type PhotoAsset } from "@/lib/native-capabilities";
import { isDurablePhotoOwner } from "@/lib/photo-retry";
import type { Place } from "@/lib/places";
import { VisitPostcard } from "./visit-postcard";

type Props = {
  place: Place;
  visit?: Visit;
  busy: boolean;
  /** Claims are account-owned; the parent passes true only for an authenticated session. */
  authenticated?: boolean;
  recommendClaim: (input: { location: LocationSample }) => Promise<ClaimRecommendation>;
  createClaim: (input: { recommendationToken: string; expectedPlaceId: string }) => Promise<ClaimConfirmation>;
  uploadPhoto: (placeId: string, file: File) => Promise<void>;
  loadPhoto: (placeId: string) => Promise<Blob>;
  removePhoto: (placeId: string) => Promise<void>;
  onClaimed?: (confirmation: ClaimConfirmation) => void;
  ownerKey?: string;
  placeNameForId?: (placeId: string) => string | undefined;
  onOpenPlace?: (placeId: string) => void;
};

const claimMessage = (error: unknown) => {
  const code = (error as ApiError)?.code;
  if (error instanceof LocationCapabilityError) return error.code === "permission-denied" ? "Location permission is off. Allow it for Parkdex, then try again." : error.code === "precise-required" ? error.message : error.code === "timeout" ? "Your location took too long. Move into open sky and try again." : "Your location is unavailable. Check location services and try again.";
  if (code === "location_accuracy_too_low") return "Your location is too broad to confirm this boundary. Turn on Precise location for Parkdex in Android settings, then move into open sky and try again.";
  if (code === "location_stale") return "That location sample is too old. Refresh your location to continue.";
  if (code === "claim_recommendation_expired") return "This recommendation expired. Refresh your location and confirm the park again.";
  if (code === "claim_recommendation_not_found") return "That recommendation is no longer available. Refresh your location to make a new claim.";
  if (code === "claim_recommendation_candidate_mismatch") return "Your location now matches a different park. Refresh and confirm the new recommendation.";
  return error instanceof Error ? error.message : "Parkdex could not confirm this claim. Try again.";
};

export function ClaimVisitPanel({ place, visit, busy, authenticated = false, recommendClaim, createClaim, uploadPhoto, loadPhoto, removePhoto, onClaimed, ownerKey, placeNameForId, onOpenPlace }: Props) {
  const claimExists = Boolean(visit?.claim);
  const claimHasPhoto = Boolean(visit?.claim?.hasPhoto);
  const photoRetryStore = getNativeCapabilities().photoRetry;
  const photoLoadKey = `${ownerKey ?? ""}\u0000${place.id}\u0000${claimExists ? "claim" : "preclaim"}`;
  const photoHydrationEnabled = authenticated && !claimHasPhoto && isDurablePhotoOwner(ownerKey) && Boolean(photoRetryStore);
  const [working, setWorking] = useState(false), [message, setMessage] = useState(""), [recommendation, setRecommendation] = useState<ClaimRecommendation | null>(null);
  const [sample, setSample] = useState<LocationSample | null>(null), [pendingPhoto, setPendingPhoto] = useState<PhotoAsset | null>(null), [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoConfirmedFor, setPhotoConfirmedFor] = useState<string | null>(null);
  const [uploadRetry, setUploadRetry] = useState<{ placeId: string; file: File } | null>(null);
  const [recommendationExpired, setRecommendationExpired] = useState(false);
  const [ownerCleanupAttempt, setOwnerCleanupAttempt] = useState(0);
  const [ownerCleanupFailed, setOwnerCleanupFailed] = useState(false);
  const [photoCleanupAttempt, setPhotoCleanupAttempt] = useState(0);
  const [photoCleanupFailed, setPhotoCleanupFailed] = useState(false);
  const [photoLoadAttempt, setPhotoLoadAttempt] = useState(0);
  const [photoLoadStatus, setPhotoLoadStatus] = useState<{ key: string; status: "pending" | "resolved" | "failed" } | null>(() => photoHydrationEnabled ? { key: photoLoadKey, status: "pending" } : null);
  const ownerCleanupFailedRef = useRef(false);
  const ownerRef = useRef(ownerKey);
  const operationEpochRef = useRef(0);
  const photoLoadEpochRef = useRef(0);
  const restoredCaptureAttemptRef = useRef<string | null>(null);
  const candidateMatches = recommendation?.status === "recommended" && recommendation.candidate.placeId === place.id;
  const photoConfirmed = photoConfirmedFor === place.id;
  const expired = recommendation?.status === "recommended" && recommendationExpired;
  const otherCandidate = recommendation?.status === "recommended" && !candidateMatches ? recommendation.candidate : null;
  const otherCandidateName = otherCandidate ? placeNameForId?.(otherCandidate.placeId) ?? "the matching park" : "";
  const currentPhotoLoadStatus = photoHydrationEnabled
    ? photoLoadStatus?.key === photoLoadKey ? photoLoadStatus.status : "pending"
    : null;
  const photoLoadPending = currentPhotoLoadStatus === "pending";
  const photoLoadFailed = currentPhotoLoadStatus === "failed";
  const recommendationText = useMemo(() => recommendation?.status === "none" ? "No eligible park boundary matches this location." : "", [recommendation]);

  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);
  useEffect(() => { restoredCaptureAttemptRef.current = null; }, [ownerKey, place.id]);
  useEffect(() => {
    if (ownerRef.current === ownerKey && !ownerCleanupFailedRef.current) return;
    const previousOwner = ownerRef.current;
    operationEpochRef.current += 1;
    photoLoadEpochRef.current += 1;
    setWorking(false);
    setMessage("");
    setRecommendation(null);
    setSample(null);
    setPendingPhoto(null);
    setPhotoPreview(null);
    setPhotoConfirmedFor(null);
    setUploadRetry(null);
    setRecommendationExpired(false);
    setPhotoCleanupFailed(false);
    let active = true;
    void clearPhotoRetryOwner(previousOwner).then(() => {
      if (!active || ownerRef.current !== previousOwner) return;
      ownerRef.current = ownerKey;
      ownerCleanupFailedRef.current = false;
      setOwnerCleanupFailed(false);
    }).catch(() => {
      if (active) {
        ownerCleanupFailedRef.current = true;
        setOwnerCleanupFailed(true);
      }
    });
    return () => { active = false; };
  }, [ownerKey, ownerCleanupAttempt]);
  useEffect(() => {
    const owner = ownerKey;
    const store = getNativeCapabilities().photoRetry;
    if (!authenticated || claimHasPhoto || !isDurablePhotoOwner(owner) || !store) return;
    let active = true;
    const operationEpoch = operationEpochRef.current;
    const photoLoadEpoch = ++photoLoadEpochRef.current;
    const loadKey = photoLoadKey;
    void store.load(owner, place.id).then((photo) => {
      if (!active || operationEpochRef.current !== operationEpoch || photoLoadEpochRef.current !== photoLoadEpoch) return;
      setPhotoLoadStatus({ key: loadKey, status: "resolved" });
      if (!photo) return;
      if (claimExists) {
        setUploadRetry({ placeId: place.id, file: photo.file });
        setPendingPhoto(null);
        setPhotoConfirmedFor(null);
        setMessage("Your visit is saved, but the photo still needs to upload.");
      } else {
        setUploadRetry(null);
        setPendingPhoto(photo);
        setPhotoConfirmedFor(place.id);
        setMessage("A saved photo is ready to attach after you confirm this park.");
      }
      setPhotoPreview(URL.createObjectURL(photo.file));
    }).catch(() => {
      if (active && operationEpochRef.current === operationEpoch && photoLoadEpochRef.current === photoLoadEpoch) setPhotoLoadStatus({ key: loadKey, status: "failed" });
    });
    return () => { active = false; };
  }, [authenticated, ownerKey, place.id, claimExists, claimHasPhoto, photoLoadAttempt, photoLoadKey]);
  useEffect(() => {
    if (!authenticated || !isDurablePhotoOwner(ownerKey) || !claimHasPhoto) {
      return;
    }
    const store = getNativeCapabilities().photoRetry;
    if (!store) return;
    let active = true;
    void store.remove(ownerKey, place.id).then(() => {
      if (!active) return;
      setPhotoCleanupFailed(false);
      setUploadRetry((current) => current?.placeId === place.id ? null : current);
      setPendingPhoto(null);
      setPhotoConfirmedFor(null);
      setPhotoPreview(null);
    }).catch(() => {
      if (active) setPhotoCleanupFailed(true);
    });
    return () => { active = false; };
  }, [authenticated, ownerKey, place.id, claimHasPhoto, photoCleanupAttempt]);
  useEffect(() => {
    if (recommendation?.status !== "recommended") return;
    const timeout = window.setTimeout(() => setRecommendationExpired(true), Math.max(0, Date.parse(recommendation.expiresAt) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [recommendation]);

  async function capturePhoto() {
    if (photoLoadPending || photoLoadFailed) {
      setMessage(photoLoadFailed ? "Retry saved photo recovery before choosing another photo." : "Please wait while Parkdex checks for a saved photo.");
      return;
    }
    const operationEpoch = operationEpochRef.current;
    photoLoadEpochRef.current += 1;
    setMessage("");
    try {
      if (!ownerKey) throw new Error("Your account is still loading. Wait a moment, then try the camera again.");
      const photo = await getNativeCapabilities().getPhoto({
        ownerKey,
        placeId: place.id,
        captureAttemptId: restoredCaptureAttemptRef.current ?? createPhotoCaptureAttemptId(),
      });
      restoredCaptureAttemptRef.current = null;
      if (!photo || operationEpochRef.current !== operationEpoch) return;
      if (uploadRetry) await removePhotoRetry(uploadRetry.placeId);
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      setUploadRetry(null);
      setPendingPhoto(photo); setPhotoConfirmedFor(null); setPhotoPreview(URL.createObjectURL(photo.file));
    } catch (error) {
      if (operationEpochRef.current === operationEpoch) {
        if (error instanceof RestoredPhotoAwaitingAdoptionError) restoredCaptureAttemptRef.current = error.captureAttemptId;
        setMessage(error instanceof Error ? error.message : "Could not open the camera.");
      }
    }
  }

  async function savePhotoRetry(photo: PhotoAsset): Promise<"stored" | "unavailable" | "failed"> {
    if (!ownerKey) return "unavailable";
    if (!isDurablePhotoOwner(ownerKey)) return "unavailable";
    const store = getNativeCapabilities().photoRetry;
    if (!store) return "unavailable";
    try {
      const result = await store.save(ownerKey, place.id, photo);
      return result === false ? "failed" : "stored";
    } catch {
      return "failed";
    }
  }

  async function removePhotoRetry(placeId = place.id) {
    if (!isDurablePhotoOwner(ownerKey)) return true;
    const store = getNativeCapabilities().photoRetry;
    if (!store) return true;
    try {
      await store.remove(ownerKey, placeId);
      return true;
    } catch {
      setPhotoCleanupFailed(true);
      return false;
    }
  }

  async function discardPhoto() {
    photoLoadEpochRef.current += 1;
    const removed = await removePhotoRetry(uploadRetry?.placeId);
    if (!removed) {
      setMessage("The saved photo could not be removed. Try again when storage is available.");
      return;
    }
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(null);
    setPendingPhoto(null);
    setPhotoConfirmedFor(null);
    setUploadRetry(null);
    setMessage("");
  }

  async function locate() {
    const operationEpoch = operationEpochRef.current;
    setWorking(true); setMessage(""); setRecommendation(null); setRecommendationExpired(false);
    try {
      const location = await getNativeCapabilities().getCurrentLocation({ highAccuracy: true, timeoutMs: 12000, maxAgeMs: 0, requirePrecise: true });
      if (operationEpochRef.current !== operationEpoch) return;
      setSample(location);
      const result = await recommendClaim({ location });
      if (operationEpochRef.current !== operationEpoch) return;
      setRecommendation(result);
    } catch (error) {
      if (operationEpochRef.current === operationEpoch) setMessage(claimMessage(error));
    } finally {
      if (operationEpochRef.current === operationEpoch) setWorking(false);
    }
  }

  async function claim() {
    if (recommendation?.status !== "recommended" || !candidateMatches) return;
    if (expired || Date.now() >= Date.parse(recommendation.expiresAt)) { setRecommendationExpired(true); setMessage("This recommendation expired. Refresh your location and confirm the park again."); return; }
    const operationEpoch = operationEpochRef.current;
    setWorking(true); setMessage("");
    try {
      const photoToUpload = pendingPhoto && photoConfirmed ? pendingPhoto : null;
      const photoPersistence = photoToUpload ? await savePhotoRetry(photoToUpload) : "unavailable";
      if (operationEpochRef.current !== operationEpoch) return;
      if (photoToUpload && ownerKey && photoPersistence !== "stored") {
        setMessage(photoPersistence === "failed"
          ? "The photo could not be saved for retry. Check your device storage, then try claiming again."
          : "Wait for your account to finish loading before attaching a photo.");
        return;
      }
      const confirmation = await createClaim({ recommendationToken: recommendation.recommendationToken, expectedPlaceId: place.id });
      if (operationEpochRef.current !== operationEpoch) return;
      onClaimed?.(confirmation);
      if (photoToUpload) {
        if (operationEpochRef.current !== operationEpoch) return;
        try {
          await uploadPhoto(place.id, photoToUpload.file);
          if (operationEpochRef.current !== operationEpoch) return;
          const removed = await removePhotoRetry(place.id);
          if (!removed) {
            setUploadRetry({ placeId: place.id, file: photoToUpload.file });
            setMessage("The photo uploaded, but its local retry copy could not be removed. Remove the saved copy when storage is available.");
            setRecommendation(null);
            return;
          }
          setPendingPhoto(null); setPhotoConfirmedFor(null); setPhotoPreview(null);
        } catch {
          if (operationEpochRef.current !== operationEpoch) return;
          setUploadRetry({ placeId: place.id, file: photoToUpload.file }); setMessage("Your visit is saved, but the photo did not upload. Try the photo again when you’re online.");
        }
      }
      setRecommendation(null);
    } catch (error) {
      if (operationEpochRef.current === operationEpoch) setMessage(claimMessage(error));
    } finally {
      if (operationEpochRef.current === operationEpoch) setWorking(false);
    }
  }

  async function retryPhoto() {
    if (!uploadRetry) return;
    const operationEpoch = operationEpochRef.current;
    setWorking(true); setMessage("");
    try {
      await uploadPhoto(uploadRetry.placeId, uploadRetry.file);
      if (operationEpochRef.current !== operationEpoch) return;
      const removed = await removePhotoRetry(uploadRetry.placeId);
      if (!removed) {
        setMessage("The photo uploaded, but its local retry copy could not be removed. Remove the saved copy when storage is available.");
        return;
      }
      setUploadRetry(null); setPendingPhoto(null); setPhotoConfirmedFor(null); setPhotoPreview(null);
    } catch {
      if (operationEpochRef.current === operationEpoch) setMessage("The photo still could not upload. Your visit remains saved; try again later.");
    } finally {
      if (operationEpochRef.current === operationEpoch) setWorking(false);
    }
  }

  const retryControl = uploadRetry && <div className="claim-photo-recovery" role="alert"><p>{message || "Your visit is saved, but the photo still needs to upload."}</p><button className="claim-refresh" type="button" onClick={() => void retryPhoto()} disabled={working}><RefreshCw size={16} />{working ? "Uploading photo…" : "Retry photo upload"}</button><button type="button" onClick={() => void discardPhoto()} disabled={working}><X size={16} />Remove saved photo</button></div>;
  const cleanupControl = (ownerCleanupFailed || photoCleanupFailed) && <div className="claim-photo-recovery" role="alert"><p>{ownerCleanupFailed ? "A private photo from the previous account could not be removed yet." : "This visit already has a photo, but its local retry copy could not be removed yet."}</p><button className="claim-refresh" type="button" onClick={() => { if (ownerCleanupFailed) setOwnerCleanupAttempt((current) => current + 1); if (photoCleanupFailed) setPhotoCleanupAttempt((current) => current + 1); }} disabled={working}><RefreshCw size={16} />Retry private photo cleanup</button></div>;
  const photoLoadControl = photoLoadFailed && <div className="claim-photo-recovery" role="alert"><p>{claimExists ? "A saved photo could not be loaded. Retry recovery before uploading it." : "A saved photo could not be loaded. Retry recovery before choosing another photo or claiming."}</p><button className="claim-refresh" type="button" onClick={() => { setPhotoLoadStatus({ key: photoLoadKey, status: "pending" }); setPhotoLoadAttempt((current) => current + 1); }} disabled={working}><RefreshCw size={16} />Retry saved photo recovery</button></div>;

  if (!authenticated) return <><section className="claim-owner-gate" aria-label="Account claims"><strong>Visit claims belong to your account.</strong><p>Sign in to confirm a visit or add a private photo to this field note.</p></section>{cleanupControl}{photoLoadControl}</>;
  if (visit?.claim) return <section className="claimed-visit"><VisitPostcard place={place} visit={visit} loadPhoto={loadPhoto} removePhoto={removePhoto} ownerKey={ownerKey} onOpenPlace={onOpenPlace ? () => onOpenPlace(place.id) : undefined} />{retryControl}{cleanupControl}{photoLoadControl}</section>;
  if (visit) return <><p className="legacy-visit-note"><Check size={16} />Visited {new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(visit.visitedAt))}. This legacy visit remains in your journal.</p>{cleanupControl}{photoLoadControl}</>;

  return <section className="claim-visit" aria-label={`Claim ${place.name}`}>
     <div className="claim-photo-prompt">
       {photoPreview ? <><img src={photoPreview} alt="Photo ready to attach after you claim this park" /><div><strong>{photoConfirmed ? `Photo ready for ${place.name}` : `Use this photo for ${place.name}?`}</strong><p>{photoConfirmed ? "It will upload after the boundary claim succeeds." : "Confirm the park before this recovered or new photo can be attached."}</p><span className="claim-photo-actions">{!photoConfirmed && <button type="button" onClick={() => setPhotoConfirmedFor(place.id)}><Check size={16} />Use photo</button>}<button type="button" onClick={() => void discardPhoto()}><X size={16} />Discard</button></span></div></> : <button type="button" onClick={() => void capturePhoto()} disabled={working || busy || photoLoadPending || photoLoadFailed}><Camera size={18} />Take an optional visit photo</button>}
    </div>
    {!candidateMatches && <button className="claim-locate" type="button" onClick={() => void locate()} disabled={working || busy}><LocateFixed size={19} />{working ? "Checking your boundary…" : "Check if I can claim a park"}</button>}
    {candidateMatches && <div className="claim-recommendation"><strong>You’re here, claim this park now</strong><p>{recommendation.candidate.matchKind === "exact" ? "Your location is inside the published boundary." : `You’re ${Math.round(recommendation.candidate.distanceMeters)} m from this boundary.`}</p><button type="button" onClick={() => void claim()} disabled={working || busy || expired || Boolean(pendingPhoto && !photoConfirmed)}><Check size={19} />{working ? "Claiming…" : "Claim this park"}</button>{pendingPhoto && !photoConfirmed && <small>Use or discard the photo before claiming.</small>}{expired && <button type="button" className="claim-refresh" onClick={() => void locate()}><RefreshCw size={16} />Refresh location</button>}</div>}
    {otherCandidate && <div className="claim-other-candidate" role="status"><p>Your location matches <strong>{otherCandidateName}</strong>.</p>{onOpenPlace && <button type="button" onClick={() => onOpenPlace(otherCandidate.placeId)}>Open {otherCandidateName}</button>}</div>}
    {recommendationText && <p className="claim-state" role="status">{recommendationText}</p>}
     {message && !uploadRetry && <p className="claim-state claim-error" role="alert">{message}</p>}
     {retryControl}{cleanupControl}{photoLoadControl}
    {sample && <small className="claim-sample">Location accuracy ±{Math.round(sample.accuracyMeters)} m</small>}
  </section>;
}
