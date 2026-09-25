"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  deliverClaimPhoto,
  recommendClaimAtCurrentLocation,
  removePrivateClaimPhoto,
  persistPrivateClaimPhoto,
  submitClaimWorkflow,
  type ClaimWorkflowConfirmation,
  type ClaimWorkflowOutcome,
  type ClaimWorkflowStage,
} from "./claim-workflow";
import type { ClaimRecommendation } from "./claims-client";
import { clearUnresolvedClaim, markUnresolvedClaim } from "./claim-recovery";
import { isOfflineClaimRecommendationToken } from "./offline-claims";
import { getNativeCapabilities, type LocationSample, type PhotoAsset } from "./native-capabilities";
import type { PhotoRetrySaveOptions } from "./photo-retry";

type SubmitOptions = Omit<Parameters<typeof submitClaimWorkflow>[0], "ownerKey" | "placeId" | "store" | "onStage" | "persistUnresolved" | "clearUnresolved">;

type DeliveryOptions = {
  placeId?: string;
  confirmation: ClaimWorkflowConfirmation;
  photo: PhotoAsset;
  forcePhotoUpload?: boolean;
  uploadPhoto: (placeId: string, file: File) => Promise<void>;
  shouldContinue?: () => boolean;
};

export type ClaimFlowController = {
  working: boolean;
  stage: ClaimWorkflowStage | null;
  /** Stable ref for native Back handlers that must see the current operation state. */
  workingRef: { readonly current: boolean };
  begin(): number | null;
  isCurrent(operation: number): boolean;
  setStage(operation: number, stage: ClaimWorkflowStage | null): void;
  finish(operation: number): void;
  invalidate(): void;
  recommend(
    operation: number,
    recommendClaim: (input: { location: LocationSample }) => Promise<ClaimRecommendation>,
    shouldContinue?: () => boolean,
  ): Promise<{ location: LocationSample; recommendation: ClaimRecommendation; startedAt: number } | null>;
  persistPhoto(operation: number, photo: PhotoAsset, options?: PhotoRetrySaveOptions): Promise<boolean>;
  removePhoto(operation: number): Promise<boolean>;
  submit(operation: number, options: SubmitOptions): Promise<ClaimWorkflowOutcome | null>;
  deliver(operation: number, options: DeliveryOptions): Promise<ClaimWorkflowOutcome | null>;
};

/**
 * Headless operation state and business adapters for claim and private photo
 * work. Views own presentation state while this controller owns generations,
 * stage updates, and the shared persistence/create/reconcile/upload ordering.
 */
export function useClaimFlow(ownerKey: string | undefined, placeId: string): ClaimFlowController {
  const [state, setState] = useState<{ working: boolean; stage: ClaimWorkflowStage | null }>({ working: false, stage: null });
  const operationRef = useRef(0);
  const workingRef = useRef(false);
  const identityRef = useRef(`${ownerKey ?? ""}\u0000${placeId}`);
  const retryStore = getNativeCapabilities().photoRetry;

  const begin = useCallback(() => {
    if (workingRef.current) return null;
    const operation = ++operationRef.current;
    workingRef.current = true;
    setState({ working: true, stage: null });
    return operation;
  }, []);

  const isCurrent = useCallback((operation: number) => operationRef.current === operation, []);

  const setStage = useCallback((operation: number, stage: ClaimWorkflowStage | null) => {
    if (operationRef.current === operation) setState({ working: true, stage });
  }, []);

  const finish = useCallback((operation: number) => {
    if (operationRef.current !== operation) return;
    workingRef.current = false;
    setState({ working: false, stage: null });
  }, []);

  const invalidate = useCallback(() => {
    operationRef.current += 1;
    workingRef.current = false;
    setState({ working: false, stage: null });
  }, []);

  useEffect(() => {
    const nextIdentity = `${ownerKey ?? ""}\u0000${placeId}`;
    if (identityRef.current === nextIdentity) return;
    identityRef.current = nextIdentity;
    invalidate();
  }, [invalidate, ownerKey, placeId]);

  const recommend = useCallback(async (
    operation: number,
    recommendClaim: (input: { location: LocationSample }) => Promise<ClaimRecommendation>,
    shouldContinue?: () => boolean,
  ) => {
    const result = await recommendClaimAtCurrentLocation({
      getCurrentLocation: (options) => getNativeCapabilities().getCurrentLocation(options),
      recommendClaim,
      shouldContinue,
      onStage: (stage) => setStage(operation, stage),
    });
    return isCurrent(operation) ? result : null;
  }, [isCurrent, setStage]);

  const persistPhoto = useCallback(async (operation: number, photo: PhotoAsset, options?: PhotoRetrySaveOptions) => {
    if (!isCurrent(operation)) return false;
    setStage(operation, "saving");
    await persistPrivateClaimPhoto({ ownerKey, placeId, store: retryStore, photo, options });
    return isCurrent(operation);
  }, [isCurrent, ownerKey, placeId, retryStore, setStage]);

  const removePhoto = useCallback(async (operation: number) => {
    if (!isCurrent(operation)) return false;
    setStage(operation, "cleanup");
    await removePrivateClaimPhoto({ ownerKey, placeId, store: retryStore });
    return isCurrent(operation);
  }, [isCurrent, ownerKey, placeId, retryStore, setStage]);

  const submit = useCallback(async (operation: number, options: SubmitOptions) => {
    if (!isCurrent(operation)) return null;
    const outcome = await submitClaimWorkflow({
      ...options,
      ownerKey,
      placeId,
      store: retryStore,
      persistUnresolved: (photoExpected) => markUnresolvedClaim(ownerKey, placeId, photoExpected),
      clearUnresolved: () => clearUnresolvedClaim(ownerKey, placeId),
      isOfflineRecommendation: isOfflineClaimRecommendationToken,
      onStage: (stage) => setStage(operation, stage),
    });
    return isCurrent(operation) ? outcome : null;
  }, [isCurrent, ownerKey, placeId, retryStore, setStage]);

  const deliver = useCallback(async (operation: number, options: DeliveryOptions) => {
    if (!isCurrent(operation)) return null;
    const { placeId: targetPlaceId = placeId, ...deliveryOptions } = options;
    const outcome = await deliverClaimPhoto({
      ...deliveryOptions,
      ownerKey,
      placeId: targetPlaceId,
      store: retryStore,
      onStage: (stage) => setStage(operation, stage),
    });
    return isCurrent(operation) ? outcome : null;
  }, [isCurrent, ownerKey, placeId, retryStore, setStage]);

  useEffect(() => () => {
    operationRef.current += 1;
    workingRef.current = false;
  }, []);

  return {
    ...state,
    workingRef,
    begin,
    isCurrent,
    setStage,
    finish,
    invalidate,
    recommend,
    persistPhoto,
    removePhoto,
    submit,
    deliver,
  };
}
