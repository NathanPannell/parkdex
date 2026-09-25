import type { ClaimConfirmation, ClaimRecommendation } from "./claims-client";
import type { LocationSample, PhotoAsset } from "./native-capabilities";
import type { PhotoRetrySaveOptions, PhotoRetryStore } from "./photo-retry";
import { isDurablePhotoOwner } from "./photo-retry";

/** Business stages shared by the arrival banner and the place detail panel. */
export type ClaimWorkflowStage =
  | "camera"
  | "processing"
  | "saving"
  | "location"
  | "recommendation"
  | "claim"
  | "reconciliation"
  | "upload"
  | "cleanup";

/** Offline commands return a local confirmation until the server accepts it. */
export type ClaimWorkflowConfirmation = ClaimConfirmation & { pendingSync?: boolean };
export type ClaimCreationInput = {
  recommendationToken: string;
  expectedPlaceId: string;
  /** Lets offline journals retain a durable upload task alongside the claim. */
  photoExpected?: boolean;
};

export type ClaimWorkflowOutcome =
  | { status: "confirmed"; confirmation: ClaimWorkflowConfirmation }
  | { status: "pending-sync"; confirmation: ClaimWorkflowConfirmation; photo?: PhotoAsset }
  | { status: "paused"; confirmation: ClaimWorkflowConfirmation; photo?: PhotoAsset }
  | {
      status: "photo-retry";
      confirmation: ClaimWorkflowConfirmation;
      photo: PhotoAsset;
      step: "upload" | "cleanup";
      error: unknown;
    };

export type ClaimWorkflowStageListener = (stage: ClaimWorkflowStage) => void;

export class ClaimRecommendationExpiredError extends Error {
  readonly code = "claim_recommendation_expired";

  constructor() {
    super("This recommendation expired. Refresh your location and confirm the visit again.");
    this.name = "ClaimRecommendationExpiredError";
  }
}

export class ClaimRecommendationRejectedError extends Error {
  readonly code = "claim_recommendation_rejected";

  constructor() {
    super("Parkdex could not confirm that you are still in this park. Stay inside the boundary and retry the saved visit.");
    this.name = "ClaimRecommendationRejectedError";
  }
}

export class ClaimWorkflowInterruptedError extends Error {
  constructor() {
    super("The visit is paused while the account changes.");
    this.name = "ClaimWorkflowInterruptedError";
  }
}

export class ClaimPhotoPersistenceError extends Error {
  constructor(message = "The photo could not be saved for retry. Check your device storage, then try logging the visit again.") {
    super(message);
    this.name = "ClaimPhotoPersistenceError";
  }
}

export class ClaimReconciliationRequiredError extends Error {
  constructor(readonly originalError: unknown) {
    super("Parkdex could not confirm whether the visit was saved. Reconnect before retrying so the visit can be checked safely.");
    this.name = "ClaimReconciliationRequiredError";
  }
}

export class ClaimReconciliationUnavailableError extends Error {
  constructor(readonly originalError: unknown) {
    super("Parkdex could not check whether the visit was saved. Reconnect before retrying.");
    this.name = "ClaimReconciliationUnavailableError";
  }
}

export const CLAIM_LOCATION_OPTIONS = {
  highAccuracy: true,
  timeoutMs: 12_000,
  maxAgeMs: 0,
  requirePrecise: true,
} as const;

export const CLAIM_RECOMMENDATION_EXPIRY_SAFETY_MS = 8_000;

export async function recommendClaimAtCurrentLocation(args: {
  getCurrentLocation: (options: typeof CLAIM_LOCATION_OPTIONS) => Promise<LocationSample>;
  recommendClaim: (input: { location: LocationSample }) => Promise<ClaimRecommendation>;
  shouldContinue?: () => boolean;
  onStage?: ClaimWorkflowStageListener;
}): Promise<{ location: LocationSample; recommendation: ClaimRecommendation; startedAt: number }> {
  args.onStage?.("location");
  const startedAt = Date.now();
  const location = await args.getCurrentLocation(CLAIM_LOCATION_OPTIONS);
  if (args.shouldContinue && !args.shouldContinue()) throw new ClaimWorkflowInterruptedError();
  args.onStage?.("recommendation");
  const recommendation = await args.recommendClaim({ location });
  return { location, recommendation, startedAt };
}

export function isClaimRecommendationCurrent(
  recommendation: ClaimRecommendation | null | undefined,
  placeId: string,
  now = Date.now(),
): recommendation is Extract<ClaimRecommendation, { status: "recommended" }> {
  return recommendation?.status === "recommended"
    && recommendation.candidate.placeId === placeId
    && Date.parse(recommendation.expiresAt) - now > CLAIM_RECOMMENDATION_EXPIRY_SAFETY_MS;
}

export async function persistPrivateClaimPhoto(args: {
  ownerKey: string | undefined;
  placeId: string;
  store: PhotoRetryStore | undefined;
  photo: PhotoAsset;
  options?: PhotoRetrySaveOptions;
}): Promise<void> {
  if (!isDurablePhotoOwner(args.ownerKey) || !args.store) {
    throw new ClaimPhotoPersistenceError("Wait for private photo storage to be ready before attaching this photo.");
  }
  let saved: void | boolean;
  try {
    saved = args.options
      ? await args.store.save(args.ownerKey, args.placeId, args.photo, args.options)
      : await args.store.save(args.ownerKey, args.placeId, args.photo);
  } catch {
    throw new ClaimPhotoPersistenceError();
  }
  if (saved === false) throw new ClaimPhotoPersistenceError();
}

export async function removePrivateClaimPhoto(args: {
  ownerKey: string | undefined;
  placeId: string;
  store: PhotoRetryStore | undefined;
}): Promise<void> {
  if (!isDurablePhotoOwner(args.ownerKey) || !args.store) {
    throw new Error("Private photo storage is not ready. Wait for your account to finish loading, then try again.");
  }
  await args.store.remove(args.ownerKey, args.placeId);
}

export async function deliverClaimPhoto(args: {
  ownerKey: string | undefined;
  placeId: string;
  store: PhotoRetryStore | undefined;
  confirmation: ClaimWorkflowConfirmation;
  photo: PhotoAsset;
  forcePhotoUpload?: boolean;
  uploadPhoto: (placeId: string, file: File) => Promise<void>;
  shouldContinue?: () => boolean;
  onStage?: ClaimWorkflowStageListener;
}): Promise<ClaimWorkflowOutcome> {
  if (args.confirmation.pendingSync) {
    return { status: "pending-sync", confirmation: args.confirmation, photo: args.photo };
  }
  if (args.shouldContinue && !args.shouldContinue()) {
    return { status: "paused", confirmation: args.confirmation, photo: args.photo };
  }

  if (args.confirmation.claim.hasPhoto && !args.forcePhotoUpload) {
    args.onStage?.("cleanup");
    try {
      await removePrivateClaimPhoto({ ownerKey: args.ownerKey, placeId: args.placeId, store: args.store });
      return { status: "confirmed", confirmation: args.confirmation };
    } catch (error) {
      return {
        status: "photo-retry",
        confirmation: args.confirmation,
        photo: args.photo,
        step: "cleanup",
        error,
      };
    }
  }

  args.onStage?.("upload");
  try {
    await args.uploadPhoto(args.placeId, args.photo.file);
  } catch (error) {
    return { status: "photo-retry", confirmation: args.confirmation, photo: args.photo, step: "upload", error };
  }

  args.onStage?.("cleanup");
  try {
    await removePrivateClaimPhoto({ ownerKey: args.ownerKey, placeId: args.placeId, store: args.store });
  } catch (error) {
    return {
      status: "photo-retry",
      confirmation: withPhoto(args.confirmation),
      photo: args.photo,
      step: "cleanup",
      error,
    };
  }

  return { status: "confirmed", confirmation: withPhoto(args.confirmation) };
}

/**
 * Persists accepted bytes before claim creation, reconciles ambiguous creates,
 * and only uploads or removes the private copy after a server confirmation.
 */
export async function submitClaimWorkflow(args: {
  ownerKey: string | undefined;
  placeId: string;
  store: PhotoRetryStore | undefined;
  photo?: PhotoAsset;
  photoAlreadyPersisted?: boolean;
  forcePhotoUpload?: boolean;
  rawStaging?: boolean;
  recommendation?: ClaimRecommendation | null;
  recommendFresh?: () => Promise<ClaimRecommendation>;
  reconcileFirst?: boolean;
  unresolvedCreate?: boolean;
  isOfflineRecommendation?: (recommendationToken: string) => boolean;
  shouldContinue?: () => boolean;
  persistUnresolved?: (photoExpected: boolean) => Promise<void>;
  clearUnresolved?: () => Promise<void>;
  createClaim: (input: ClaimCreationInput) => Promise<ClaimWorkflowConfirmation>;
  reconcileClaim?: (placeId: string) => Promise<ClaimWorkflowConfirmation | null>;
  uploadPhoto: (placeId: string, file: File) => Promise<void>;
  onStage?: ClaimWorkflowStageListener;
}): Promise<ClaimWorkflowOutcome> {
  if (args.photo) {
    if (args.photoAlreadyPersisted) {
      if (!isDurablePhotoOwner(args.ownerKey) || !args.store) {
        throw new Error("Private photo storage is not ready. Wait for your account to finish loading, then try again.");
      }
    } else {
      args.onStage?.("saving");
      await persistPrivateClaimPhoto({
        ownerKey: args.ownerKey,
        placeId: args.placeId,
        store: args.store,
        photo: args.photo,
        options: args.rawStaging ? { rawStaging: true } : undefined,
      });
    }
  }

  let confirmation: ClaimWorkflowConfirmation | null = null;
  if (args.reconcileFirst) {
    if (!args.reconcileClaim) throw new ClaimReconciliationUnavailableError(new Error("Reconciliation is unavailable."));
    args.onStage?.("reconciliation");
    try {
      confirmation = await args.reconcileClaim(args.placeId);
    } catch (error) {
      throw new ClaimReconciliationUnavailableError(error);
    }
  }

  if (!confirmation) {
    if (args.shouldContinue && !args.shouldContinue()) throw new ClaimWorkflowInterruptedError();
    let recommendation = args.recommendation ?? null;
    if (!isClaimRecommendationCurrent(recommendation, args.placeId)) {
      if (!args.recommendFresh) throw new ClaimRecommendationExpiredError();
      recommendation = await args.recommendFresh();
    }
    if (!isClaimRecommendationCurrent(recommendation, args.placeId)) {
      throw new ClaimRecommendationRejectedError();
    }
    if (args.unresolvedCreate && args.isOfflineRecommendation?.(recommendation.recommendationToken)) {
      throw new ClaimReconciliationUnavailableError(new Error("An unresolved online visit cannot fall back to a new offline request."));
    }
    if (args.shouldContinue && !args.shouldContinue()) {
      throw new ClaimWorkflowInterruptedError();
    }

    // Record the in-flight intent before sending the request so a reload can
    // reconcile before retrying if the response is lost or the app closes.
    await args.persistUnresolved?.(Boolean(args.photo));
    args.onStage?.("claim");
    try {
      confirmation = await args.createClaim({
        recommendationToken: recommendation.recommendationToken,
        expectedPlaceId: args.placeId,
        ...(args.photo ? { photoExpected: true } : {}),
      });
    } catch (createError) {
      if (!args.reconcileClaim) throw new ClaimReconciliationRequiredError(createError);
      args.onStage?.("reconciliation");
      try {
        confirmation = await args.reconcileClaim(args.placeId);
      } catch {
        throw new ClaimReconciliationRequiredError(createError);
      }
      if (!confirmation) throw new ClaimReconciliationRequiredError(createError);
    }
  }

  if (confirmation.pendingSync) {
    await args.clearUnresolved?.().catch(() => undefined);
  }
  if (args.shouldContinue && !args.shouldContinue()) {
    return { status: "paused", confirmation, ...(args.photo ? { photo: args.photo } : {}) };
  }
  if (confirmation.pendingSync) {
    return { status: "pending-sync", confirmation, ...(args.photo ? { photo: args.photo } : {}) };
  }
  await args.clearUnresolved?.().catch(() => undefined);
  if (!args.photo) return { status: "confirmed", confirmation };
  if (args.shouldContinue && !args.shouldContinue()) throw new ClaimWorkflowInterruptedError();

  return deliverClaimPhoto({
    ownerKey: args.ownerKey,
    placeId: args.placeId,
    store: args.store,
    confirmation,
    photo: args.photo,
    forcePhotoUpload: args.forcePhotoUpload,
    uploadPhoto: args.uploadPhoto,
    shouldContinue: args.shouldContinue,
    onStage: args.onStage,
  });
}

function withPhoto(confirmation: ClaimWorkflowConfirmation): ClaimWorkflowConfirmation {
  if (confirmation.claim.hasPhoto) return confirmation;
  return { ...confirmation, claim: { ...confirmation.claim, hasPhoto: true } };
}
