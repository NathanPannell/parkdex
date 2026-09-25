"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Visit } from "./account";
import { ApiError } from "./account";
import { notifyError } from "./application-notifications";
import { clearUnresolvedClaim, loadUnresolvedClaim, markUnresolvedClaim } from "./claim-recovery";
import {
  ClaimRecommendationExpiredError,
  ClaimRecommendationRejectedError,
  ClaimPhotoPersistenceError,
  ClaimReconciliationRequiredError,
  ClaimReconciliationUnavailableError,
  ClaimWorkflowInterruptedError,
  type ClaimCreationInput,
  type ClaimWorkflowConfirmation,
} from "./claim-workflow";
import type { ClaimRecommendation } from "./claims-client";
import {
  createPhotoCaptureAttemptId,
  getNativeCapabilities,
  LocationCapabilityError,
  RestoredPhotoAwaitingAdoptionError,
  type LocationSample,
  type PhotoAsset,
} from "./native-capabilities";
import { isDurablePhotoOwner } from "./photo-retry";
import type { Place } from "./places";
import { useClaimFlow } from "./use-claim-flow";

export type PlaceClaimFlowProps = {
  place: Place;
  visit?: Visit;
  busy: boolean;
  authenticated?: boolean;
  recommendClaim: (input: { location: LocationSample }) => Promise<ClaimRecommendation>;
  createClaim: (input: ClaimCreationInput) => Promise<ClaimWorkflowConfirmation>;
  reconcileClaim?: (placeId: string) => Promise<ClaimWorkflowConfirmation | null>;
  uploadPhoto: (placeId: string, file: File) => Promise<void>;
  ownerKey?: string;
  placeNameForId?: (placeId: string) => string | undefined;
  onOpenPlace?: (placeId: string) => void;
  onClaimed?: (confirmation: ClaimWorkflowConfirmation) => void;
};

type UploadRetry = {
  placeId: string;
  file: File;
  confirmation: ClaimWorkflowConfirmation;
  pendingSync?: boolean;
};

function locationMessage(error: unknown): string {
  const code = (error as ApiError | null)?.code;
  if (error instanceof LocationCapabilityError) {
    if (error.code === "permission-denied") return "Location permission is off. Allow it for Parkdex, then try again.";
    if (error.code === "precise-required") return error.message;
    if (error.code === "timeout") return "Your location took too long. Move into open sky and try again.";
    return "Your location is unavailable. Check location services and try again.";
  }
  if (code === "location_accuracy_too_low") return "Your location is too broad to confirm this boundary. Turn on Precise location for Parkdex in Android settings, then move into open sky and try again.";
  if (code === "location_stale") return "That location sample is too old. Refresh your location to continue.";
  if (code === "claim_recommendation_expired") return "This recommendation expired. Refresh your location and confirm the visit again.";
  if (code === "claim_recommendation_not_found") return "That recommendation is no longer available. Refresh your location to confirm the visit again.";
  if (code === "claim_recommendation_candidate_mismatch") return "Your location now matches a different park. Refresh and confirm the new recommendation.";
  if (error instanceof ClaimRecommendationExpiredError) return "This recommendation expired. Refresh your location and confirm the visit again.";
  if (error instanceof ClaimRecommendationRejectedError) return "Your location no longer matches this park. Refresh and confirm the visit again.";
  return "Parkdex could not confirm this visit. Try again.";
}

function previewFor(file: File): string | null {
  return typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
}

function revokePreview(url: string | null | undefined) {
  if (url && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

function confirmationForVisit(visit: Visit | undefined): ClaimWorkflowConfirmation | null {
  if (!visit?.claim) return null;
  return {
    placeId: visit.placeId,
    visited: true,
    visitedCount: 0,
    visitedAt: visit.visitedAt,
    claim: visit.claim,
  };
}

/**
 * Headless place-detail visit application flow. The panel renders this state
 * and dispatches these actions; camera, hydration, expiry, persistence, and
 * upload/reconciliation decisions stay here.
 */
export function usePlaceClaimFlow({
  place,
  visit,
  busy,
  authenticated = false,
  recommendClaim,
  createClaim,
  reconcileClaim,
  uploadPhoto,
  ownerKey,
  placeNameForId,
  onOpenPlace,
  onClaimed,
}: PlaceClaimFlowProps) {
  const placeId = place.id;
  const claimExists = Boolean(visit?.claim);
  const claimHasPhoto = Boolean(visit?.claim?.hasPhoto);
  const retryStore = getNativeCapabilities().photoRetry;
  const photoLoadKey = `${ownerKey ?? ""}\u0000${placeId}\u0000${claimExists ? "claim" : "preclaim"}`;
  const photoHydrationEnabled = authenticated && !claimHasPhoto && isDurablePhotoOwner(ownerKey) && Boolean(retryStore);
  const claimFlow = useClaimFlow(ownerKey, placeId);
  const { working, workingRef, stage } = claimFlow;
  const invalidateClaimFlow = claimFlow.invalidate;
  const [message, setMessage] = useState("");
  const [recommendation, setRecommendation] = useState<ClaimRecommendation | null>(null);
  const [sample, setSample] = useState<LocationSample | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<PhotoAsset | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoConfirmedFor, setPhotoConfirmedFor] = useState<string | null>(null);
  const [uploadRetry, setUploadRetry] = useState<UploadRetry | null>(null);
  const [unresolvedClaim, setUnresolvedClaim] = useState(false);
  const [pendingSyncKey, setPendingSyncKey] = useState<string | null>(null);
  const [recommendationExpired, setRecommendationExpired] = useState(false);
  const [photoCleanupFailed, setPhotoCleanupFailed] = useState(false);
  const [photoLoadAttempt, setPhotoLoadAttempt] = useState(0);
  const [photoLoadStatus, setPhotoLoadStatus] = useState<{ key: string; status: "pending" | "resolved" | "failed" } | null>(() => photoHydrationEnabled ? { key: photoLoadKey, status: "pending" } : null);
  const ownerRef = useRef(ownerKey);
  const placeIdentityRef = useRef(placeId);
  const operationEpochRef = useRef(0);
  const photoLoadEpochRef = useRef(0);
  const restoredCaptureAttemptRef = useRef<string | null>(null);
  const busyRef = useRef(busy);
  const photoPreviewRef = useRef<string | null>(null);
  const pendingPhotoRef = useRef<PhotoAsset | null>(pendingPhoto);
  const uploadRetryRef = useRef<UploadRetry | null>(uploadRetry);

  const candidateMatches = recommendation?.status === "recommended" && recommendation.candidate.placeId === placeId;
  const pendingSync = pendingSyncKey === `${ownerKey ?? ""}\u0000${placeId}` && !claimExists;
  const photoConfirmed = photoConfirmedFor === placeId;
  const expired = recommendation?.status === "recommended" && recommendationExpired;
  const otherCandidate = recommendation?.status === "recommended" && !candidateMatches ? recommendation.candidate : null;
  const otherCandidateName = otherCandidate ? placeNameForId?.(otherCandidate.placeId) ?? "the matching park" : "";
  const currentPhotoLoadStatus = photoHydrationEnabled ? photoLoadStatus?.key === photoLoadKey ? photoLoadStatus.status : "pending" : null;
  const photoLoadPending = currentPhotoLoadStatus === "pending";
  const photoLoadFailed = currentPhotoLoadStatus === "failed";
  const recommendationText = useMemo(() => recommendation?.status === "none" ? "No eligible park boundary matches this location." : "", [recommendation]);

  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { pendingPhotoRef.current = pendingPhoto; }, [pendingPhoto]);
  useEffect(() => { uploadRetryRef.current = uploadRetry; }, [uploadRetry]);
  useEffect(() => { photoPreviewRef.current = photoPreview; }, [photoPreview]);

  useEffect(() => () => {
    operationEpochRef.current += 1;
    photoLoadEpochRef.current += 1;
    invalidateClaimFlow();
    revokePreview(photoPreviewRef.current);
  }, [invalidateClaimFlow]);

  useEffect(() => {
    if (placeIdentityRef.current === placeId) return;
    placeIdentityRef.current = placeId;
    operationEpochRef.current += 1;
    photoLoadEpochRef.current += 1;
    restoredCaptureAttemptRef.current = null;
    setUnresolvedClaim(false);
    setMessage("");
  }, [placeId]);

  useEffect(() => {
    if (ownerRef.current === ownerKey) return;
    ownerRef.current = ownerKey;
    operationEpochRef.current += 1;
    photoLoadEpochRef.current += 1;
    invalidateClaimFlow();
    setMessage("");
    setRecommendation(null);
    setSample(null);
    setPendingPhoto(null);
    revokePreview(photoPreviewRef.current);
    photoPreviewRef.current = null;
    setPhotoPreview(null);
    setPhotoConfirmedFor(null);
    setUploadRetry(null);
    setUnresolvedClaim(false);
    setRecommendationExpired(false);
    setPhotoCleanupFailed(false);
  }, [invalidateClaimFlow, ownerKey]);

  useEffect(() => {
    restoredCaptureAttemptRef.current = null;
  }, [placeId, ownerKey]);

  useEffect(() => {
    if (!authenticated || claimHasPhoto || !isDurablePhotoOwner(ownerKey) || !retryStore) return;
    let active = true;
    const operationEpoch = operationEpochRef.current;
    const photoLoadEpoch = ++photoLoadEpochRef.current;
    const loadKey = photoLoadKey;
    void Promise.all([retryStore.load(ownerKey, placeId), loadUnresolvedClaim(ownerKey, placeId)]).then(([photo, unresolved]) => {
      if (!active || operationEpochRef.current !== operationEpoch || photoLoadEpochRef.current !== photoLoadEpoch) return;
      setPhotoLoadStatus({ key: loadKey, status: "resolved" });
      setUnresolvedClaim(Boolean(unresolved) && !claimExists);
      if (unresolved && claimExists) {
        void clearUnresolvedClaim(ownerKey, placeId).catch(() => undefined);
      }
      if (uploadRetryRef.current?.placeId === placeId) return;
      if (!photo) {
        if (unresolved && !claimExists) setMessage("Parkdex could not confirm whether your visit saved. Reconnect before retrying.");
        return;
      }
      if (claimExists) {
        const confirmation = confirmationForVisit(visit);
        if (!confirmation) return;
        const pendingSync = Boolean((visit as Visit & { pendingSync?: boolean }).pendingSync);
        setUploadRetry({ placeId, file: photo.file, confirmation, pendingSync });
        setPendingPhoto(null);
        setPhotoConfirmedFor(null);
        setMessage(pendingSync ? "Saved on this device. Syncs when online." : "Your visit is saved, but the photo still needs to upload.");
      } else {
        setUploadRetry(null);
        setPendingPhoto(photo);
        setPhotoConfirmedFor(placeId);
        setMessage(unresolved
          ? "Parkdex could not confirm whether your visit saved. Reconnect before retrying. Your photo is still saved privately."
          : "A saved photo is ready to attach after you confirm this visit.");
      }
      const nextPreview = previewFor(photo.file);
      if (photoPreviewRef.current) revokePreview(photoPreviewRef.current);
      photoPreviewRef.current = nextPreview;
      setPhotoPreview(nextPreview);
    }).catch(() => {
      if (active && operationEpochRef.current === operationEpoch && photoLoadEpochRef.current === photoLoadEpoch) setPhotoLoadStatus({ key: loadKey, status: "failed" });
    });
    return () => { active = false; };
  }, [authenticated, ownerKey, placeId, claimExists, claimHasPhoto, photoLoadAttempt, photoLoadKey, retryStore, visit]);

  useEffect(() => {
    if (!authenticated || !isDurablePhotoOwner(ownerKey) || !claimHasPhoto || !retryStore) return;
    let active = true;
    void clearUnresolvedClaim(ownerKey, placeId).catch(() => undefined);
    void retryStore.remove(ownerKey, placeId).then(() => {
      if (!active) return;
      setPhotoCleanupFailed(false);
      setUploadRetry((current) => current?.placeId === placeId ? null : current);
      setPendingPhoto(null);
      setPhotoConfirmedFor(null);
      revokePreview(photoPreviewRef.current);
      photoPreviewRef.current = null;
      setPhotoPreview(null);
    }).catch(() => {
      if (active) setPhotoCleanupFailed(true);
    });
    return () => { active = false; };
  }, [authenticated, ownerKey, placeId, claimHasPhoto, retryStore]);

  useEffect(() => {
    if (recommendation?.status !== "recommended") return;
    const timeout = window.setTimeout(() => setRecommendationExpired(true), Math.max(0, Date.parse(recommendation.expiresAt) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [recommendation]);

  function setPreview(file: File | null) {
    const previous = photoPreviewRef.current;
    const next = file ? previewFor(file) : null;
    if (previous && previous !== next) revokePreview(previous);
    photoPreviewRef.current = next;
    setPhotoPreview(next);
  }

  async function capturePhoto() {
    if (photoLoadPending || photoLoadFailed || working || busy) {
      if (photoLoadFailed) setMessage("Retry saved photo recovery before choosing another photo.");
      else if (photoLoadPending) setMessage("Please wait while Parkdex checks for a saved photo.");
      return;
    }
    if (!ownerKey) {
      setMessage("Your account is still loading. Wait a moment, then try the camera again.");
      return;
    }
    const operation = claimFlow.begin();
    if (operation === null) return;
    const epoch = ++operationEpochRef.current;
    claimFlow.setStage(operation, "camera");
    setMessage("");
    photoLoadEpochRef.current += 1;
    try {
      const photo = await getNativeCapabilities().getPhoto({ ownerKey, placeId, captureAttemptId: restoredCaptureAttemptRef.current ?? createPhotoCaptureAttemptId() });
      restoredCaptureAttemptRef.current = null;
      if (!claimFlow.isCurrent(operation) || operationEpochRef.current !== epoch) return;
      if (!photo) return;
      if (busyRef.current) return;
      setPendingPhoto(photo);
      setPhotoConfirmedFor(null);
      setPreview(photo.file);
    } catch (error) {
      if (!claimFlow.isCurrent(operation) || operationEpochRef.current !== epoch) return;
      if (error instanceof RestoredPhotoAwaitingAdoptionError) {
        restoredCaptureAttemptRef.current = error.captureAttemptId;
        setMessage("A recovered camera photo is waiting. Tap the camera again to use it for this park.");
      } else {
        notifyError(error, "Could not open the camera. Try again.");
        setMessage("The camera could not open. Your saved photos remain available; try again.");
      }
    } finally {
      if (claimFlow.isCurrent(operation)) claimFlow.finish(operation);
    }
  }

  async function removePhotoRetry(targetPlaceId = placeId, operation?: number): Promise<boolean> {
    if (!isDurablePhotoOwner(ownerKey) || !retryStore) return true;
    try {
      if (operation !== undefined) {
        const removed = await claimFlow.removePhoto(operation);
        return removed;
      }
      await retryStore.remove(ownerKey, targetPlaceId);
      return true;
    } catch {
      setPhotoCleanupFailed(true);
      return false;
    }
  }

  async function discardPhoto() {
    if (workingRef.current || uploadRetryRef.current?.pendingSync) return;
    if (pendingPhotoRef.current && uploadRetryRef.current) {
      setPreview(null);
      setPendingPhoto(null);
      setPhotoConfirmedFor(null);
      setMessage("");
      return;
    }
    const operation = claimFlow.begin();
    if (operation === null) return;
    photoLoadEpochRef.current += 1;
    try {
      const removed = await removePhotoRetry(uploadRetryRef.current?.placeId ?? placeId, operation);
      if (!claimFlow.isCurrent(operation)) return;
      if (!removed) {
        setMessage("The saved photo could not be removed. Try again when storage is available.");
        return;
      }
      if (unresolvedClaim) await markUnresolvedClaim(ownerKey, placeId, false).catch(() => undefined);
      setPreview(null);
      setPendingPhoto(null);
      setPhotoConfirmedFor(null);
      setUploadRetry(null);
      setMessage("");
    } finally {
      if (claimFlow.isCurrent(operation)) claimFlow.finish(operation);
    }
  }

  async function locate() {
    const operation = claimFlow.begin();
    if (operation === null) return;
    const epoch = ++operationEpochRef.current;
    setMessage("");
    setRecommendation(null);
    setRecommendationExpired(false);
    try {
      const result = await claimFlow.recommend(operation, recommendClaim);
      if (!result || !claimFlow.isCurrent(operation) || operationEpochRef.current !== epoch) return;
      setSample(result.location);
      setRecommendation(result.recommendation);
    } catch (error) {
      if (claimFlow.isCurrent(operation) && operationEpochRef.current === epoch) {
        const copy = locationMessage(error);
        if (!(error instanceof LocationCapabilityError) && !(error instanceof ClaimRecommendationExpiredError) && !(error instanceof ClaimRecommendationRejectedError)) notifyError(error, copy);
        setMessage(copy);
      }
    } finally {
      if (claimFlow.isCurrent(operation)) claimFlow.finish(operation);
    }
  }

  async function recommendFresh(operation: number) {
    const result = await claimFlow.recommend(operation, recommendClaim, () => !busyRef.current);
    if (!result) throw new ClaimWorkflowInterruptedError();
    setSample(result.location);
    setRecommendation(result.recommendation);
    setRecommendationExpired(false);
    return result.recommendation;
  }

  async function applyPhotoOutcome(outcome: Awaited<ReturnType<typeof claimFlow.submit>>, file: File, targetPlaceId = placeId) {
    if (!outcome) return;
    setUnresolvedClaim(false);
    if (outcome.status === "paused") {
      setUploadRetry({ placeId: targetPlaceId, file, confirmation: outcome.confirmation, pendingSync: Boolean(outcome.confirmation.pendingSync) });
      if (outcome.confirmation.pendingSync) {
        setPendingSyncKey(`${ownerKey ?? ""}\u0000${targetPlaceId}`);
        setRecommendation(null);
      }
      setMessage(outcome.confirmation.pendingSync ? "Saved on this device. Syncs when online." : "Your photo is saved. Finish it after the account change completes.");
      return;
    }
    if (outcome.status === "pending-sync") {
      setUploadRetry({ placeId: targetPlaceId, file, confirmation: outcome.confirmation, pendingSync: true });
      setPendingSyncKey(`${ownerKey ?? ""}\u0000${targetPlaceId}`);
      setRecommendation(null);
      setMessage("Saved on this device. Syncs when online.");
      return;
    }
    if (outcome.status === "photo-retry") {
      setUploadRetry({ placeId: targetPlaceId, file, confirmation: outcome.confirmation });
      if (outcome.step === "upload") {
        setMessage("Your visit is saved, but the photo did not upload. Your private retry copy is safe.");
        notifyError(outcome.error, "The photo could not upload. Your private retry copy is safe.");
      } else {
        setPhotoCleanupFailed(true);
        setMessage("The photo uploaded, but its private retry copy still needs cleanup.");
        notifyError(outcome.error, "The private retry copy still needs cleanup.");
      }
      onClaimed?.(outcome.confirmation);
      return;
    }
    setUploadRetry(null);
    setPendingSyncKey(null);
    setPendingPhoto(null);
    setPhotoConfirmedFor(null);
    setPreview(null);
    setMessage("");
    onClaimed?.(outcome.confirmation);
  }

  async function claim() {
    if (recommendation?.status !== "recommended" || !candidateMatches) return;
    if (expired || Date.now() >= Date.parse(recommendation.expiresAt)) {
      setRecommendationExpired(true);
      setMessage("This recommendation expired. Refresh your location and confirm the park again.");
      return;
    }
    const operation = claimFlow.begin();
    if (operation === null) return;
    const epoch = ++operationEpochRef.current;
    setMessage("");
    try {
      const photo = pendingPhoto && photoConfirmedFor === placeId ? pendingPhoto : undefined;
      const outcome = await claimFlow.submit(operation, {
        recommendation,
        ...(photo ? { photo } : {}),
        reconcileFirst: unresolvedClaim,
        unresolvedCreate: unresolvedClaim,
        recommendFresh: () => recommendFresh(operation),
        createClaim,
        reconcileClaim,
        uploadPhoto,
        shouldContinue: () => !busyRef.current,
      });
      if (!claimFlow.isCurrent(operation) || operationEpochRef.current !== epoch) return;
      if (photo) {
        await applyPhotoOutcome(outcome, photo.file);
      } else if (outcome?.status === "paused") {
        const pendingSync = Boolean(outcome.confirmation.pendingSync);
        setUnresolvedClaim(!pendingSync);
        setRecommendation(null);
        setPendingSyncKey(pendingSync ? `${ownerKey ?? ""}\u0000${placeId}` : null);
        setMessage(pendingSync
          ? "Saved on this device. Syncs when online."
          : "Your visit is paused while the account changes. Retry when that finishes.");
      } else if (outcome?.status === "pending-sync") {
        setUnresolvedClaim(false);
        setRecommendation(null);
        setPendingSyncKey(`${ownerKey ?? ""}\u0000${placeId}`);
        setMessage("Saved on this device. Syncs when online.");
      } else if (outcome?.status === "confirmed") {
        setUnresolvedClaim(false);
        setRecommendation(null);
        setPendingSyncKey(null);
        setMessage("");
        onClaimed?.(outcome.confirmation);
      }
    } catch (error) {
      if (!claimFlow.isCurrent(operation) || operationEpochRef.current !== epoch) return;
      if (error instanceof ClaimRecommendationRejectedError) {
        setRecommendationExpired(true);
        setMessage("Your location no longer matches this park. Refresh your location and confirm the visit again.");
      } else if (error instanceof ClaimRecommendationExpiredError) {
        setRecommendationExpired(true);
        setMessage("This recommendation expired. Refresh your location and confirm the visit again.");
      } else if (error instanceof ClaimWorkflowInterruptedError) {
        setMessage("Your visit is paused while the account changes. Retry when that finishes.");
      } else if (error instanceof ClaimReconciliationRequiredError || error instanceof ClaimReconciliationUnavailableError) {
        setUnresolvedClaim(true);
        const copy = photoConfirmed
          ? "Parkdex could not confirm whether your visit saved. Reconnect before retrying; your photo is still saved privately."
          : "Parkdex could not confirm whether your visit saved. Reconnect before retrying.";
        notifyError(error, copy);
        setMessage(copy);
      } else if (error instanceof ClaimPhotoPersistenceError) {
        notifyError(error, error.message);
        setMessage(error.message);
      } else {
        const copy = "Parkdex could not confirm this visit. Try again.";
        notifyError(error, copy);
        setMessage(photoConfirmed ? "Your photo is saved privately. Retry this visit when you are ready." : copy);
      }
    } finally {
      if (claimFlow.isCurrent(operation)) claimFlow.finish(operation);
    }
  }

  async function retryUnresolvedClaim() {
    if (!unresolvedClaim || workingRef.current || busyRef.current) return;
    const operation = claimFlow.begin();
    if (operation === null) return;
    const epoch = ++operationEpochRef.current;
    const photo = pendingPhotoRef.current && photoConfirmedFor === placeId ? pendingPhotoRef.current : undefined;
    setMessage("");
    try {
      const outcome = await claimFlow.submit(operation, {
        ...(photo ? { photo, photoAlreadyPersisted: true } : {}),
        reconcileFirst: true,
        unresolvedCreate: true,
        recommendFresh: () => recommendFresh(operation),
        createClaim,
        reconcileClaim,
        uploadPhoto,
        shouldContinue: () => !busyRef.current,
      });
      if (!outcome || !claimFlow.isCurrent(operation) || operationEpochRef.current !== epoch) return;
      if (photo) {
        await applyPhotoOutcome(outcome, photo.file);
      } else if (outcome.status === "paused") {
        const pendingSync = Boolean(outcome.confirmation.pendingSync);
        setUnresolvedClaim(!pendingSync);
        setRecommendation(null);
        setPendingSyncKey(pendingSync ? `${ownerKey ?? ""}\u0000${placeId}` : null);
        setMessage(pendingSync
          ? "Saved on this device. Syncs when online."
          : "Your visit is paused while the account changes. Retry when that finishes.");
      } else if (outcome.status === "pending-sync") {
        setUnresolvedClaim(false);
        setRecommendation(null);
        setPendingSyncKey(`${ownerKey ?? ""}\u0000${placeId}`);
        setMessage("Saved on this device. Syncs when online.");
      } else if (outcome.status === "confirmed") {
        setUnresolvedClaim(false);
        setRecommendation(null);
        setPendingSyncKey(null);
        setMessage("");
        onClaimed?.(outcome.confirmation);
      }
    } catch (error) {
      if (!claimFlow.isCurrent(operation) || operationEpochRef.current !== epoch) return;
      setUnresolvedClaim(true);
      const copy = photo
        ? "Parkdex could not confirm whether your visit saved. Reconnect before retrying; your photo is still saved privately."
        : "Parkdex could not confirm whether your visit saved. Reconnect before retrying.";
      notifyError(error, copy);
      setMessage(copy);
    } finally {
      if (claimFlow.isCurrent(operation)) claimFlow.finish(operation);
    }
  }

  async function retryPhoto() {
    const retry = uploadRetryRef.current;
    if (!retry || workingRef.current) return;
    const operation = claimFlow.begin();
    if (operation === null) return;
    const epoch = ++operationEpochRef.current;
    setMessage("");
    try {
      let confirmation = retry.confirmation;
      if (reconcileClaim) {
        claimFlow.setStage(operation, "reconciliation");
        const reconciled = await reconcileClaim(retry.placeId);
        if (!claimFlow.isCurrent(operation) || operationEpochRef.current !== epoch) return;
        if (reconciled) confirmation = reconciled;
      } else if (retry.pendingSync) {
        setMessage("Saved on this device. Syncs when online.");
        return;
      }
      if (confirmation.pendingSync) {
        setUploadRetry({ ...retry, confirmation, pendingSync: true });
        setMessage("Saved on this device. Syncs when online.");
        return;
      }
      const outcome = await claimFlow.deliver(operation, {
        placeId: retry.placeId,
        confirmation,
        photo: { file: retry.file, mimeType: retry.file.type || "image/jpeg", processingState: "prepared" },
        uploadPhoto,
        shouldContinue: () => !busyRef.current,
      });
      if (!outcome || !claimFlow.isCurrent(operation) || operationEpochRef.current !== epoch) return;
      await applyPhotoOutcome(outcome, retry.file, retry.placeId);
    } catch (error) {
      if (claimFlow.isCurrent(operation) && operationEpochRef.current === epoch) {
        notifyError(error, "Could not check or upload the saved photo. Your private retry copy is safe.");
        setMessage("Could not finish the saved photo. Your private retry copy is safe to retry.");
      }
    } finally {
      if (claimFlow.isCurrent(operation)) claimFlow.finish(operation);
    }
  }

  async function retryCleanup() {
    if (workingRef.current) return;
    const operation = claimFlow.begin();
    if (operation === null) return;
    try {
      const removed = await removePhotoRetry(placeId, operation);
      if (!claimFlow.isCurrent(operation)) return;
      if (!removed) {
        setPhotoCleanupFailed(true);
        setMessage("The private retry copy is still waiting for device storage cleanup.");
        return;
      }
      setPhotoCleanupFailed(false);
      setUploadRetry(null);
      setPendingPhoto(null);
      setPreview(null);
      setMessage("");
    } finally {
      if (claimFlow.isCurrent(operation)) claimFlow.finish(operation);
    }
  }

  function retryPhotoRecovery() {
    setPhotoLoadStatus({ key: photoLoadKey, status: "pending" });
    setPhotoLoadAttempt((attempt) => attempt + 1);
  }

  const cleanupPending = photoCleanupFailed;

  return {
    working,
    stage,
    message,
    recommendation,
    sample,
    pendingPhoto,
    photoPreview,
    photoConfirmed,
    uploadRetry,
    pendingSync,
    unresolvedClaim,
    recommendationExpired,
    photoCleanupFailed,
    cleanupPending,
    photoLoadPending,
    photoLoadFailed,
    candidateMatches,
    expired,
    otherCandidate,
    otherCandidateName,
    recommendationText,
    capturePhoto,
    discardPhoto,
    locate,
    claim,
    retryPhoto,
    retryUnresolvedClaim,
    retryCleanup,
    retryPhotoRecovery,
    confirmPhoto: () => setPhotoConfirmedFor(placeId),
    clearMessage: () => setMessage(""),
    onOpenPlace,
  };
}
