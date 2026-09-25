import { describe, expect, it, vi } from "vitest";

import type { ClaimConfirmation, ClaimRecommendation } from "./claims-client";
import type { PhotoAsset } from "./native-capabilities";
import type { PhotoRetryStore } from "./photo-retry";
import { recommendClaimAtCurrentLocation, submitClaimWorkflow } from "./claim-workflow";

const placeId = "provincial-juan-de-fuca-park";
const recommendation: Extract<ClaimRecommendation, { status: "recommended" }> = {
  status: "recommended",
  recommendationToken: "offline:recommendation-1",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  candidate: { placeId, matchKind: "exact", distanceMeters: 0 },
};
const confirmation: ClaimConfirmation = {
  placeId,
  visited: true,
  visitedCount: 1,
  visitedAt: "2026-09-16T12:00:00Z",
  claim: {
    claimedAt: "2026-09-16T12:00:00Z",
    capturedAt: "2026-09-16T12:00:00Z",
    coordinates: { latitude: 48.4, longitude: -123.5 },
    accuracyMeters: 8,
    boundaryVersion: "v1",
    matchKind: "exact",
    distanceMeters: 0,
    hasPhoto: false,
  },
};

function harness() {
  const calls: string[] = [];
  const photo: PhotoAsset = { file: new File(["private bytes"], "visit.jpg", { type: "image/jpeg" }), mimeType: "image/jpeg", processingState: "prepared" };
  const store: PhotoRetryStore = {
    save: vi.fn(async () => { calls.push("save"); }),
    load: vi.fn(async () => null),
    remove: vi.fn(async () => { calls.push("remove"); }),
    clearOwner: vi.fn(async () => undefined),
  };
  return { calls, photo, store };
}

describe("claim workflow application layer", () => {
  it("persists an accepted photo before create and uploads before private cleanup", async () => {
    const { calls, photo, store } = harness();
    const outcome = await submitClaimWorkflow({
      ownerKey: "account:user-1",
      placeId,
      store,
      photo,
      recommendation,
      persistUnresolved: async (photoExpected) => { calls.push(`mark:${photoExpected}`); },
      clearUnresolved: async () => { calls.push("clear-marker"); },
      createClaim: async (input) => {
        calls.push("create");
        expect(input).toEqual({ recommendationToken: recommendation.recommendationToken, expectedPlaceId: placeId, photoExpected: true });
        return confirmation;
      },
      uploadPhoto: async () => { calls.push("upload"); },
    });

    expect(outcome.status).toBe("confirmed");
    expect(calls).toEqual(["save", "mark:true", "create", "clear-marker", "upload", "remove"]);
  });

  it("keeps offline confirmation and private bytes pending until the durable queue syncs", async () => {
    const { calls, photo, store } = harness();
    const localConfirmation = { ...confirmation, pendingSync: true };
    const uploadPhoto = vi.fn(async () => { calls.push("upload"); });
    const outcome = await submitClaimWorkflow({
      ownerKey: "account:user-1",
      placeId,
      store,
      photo,
      recommendation,
      createClaim: async (input) => {
        calls.push("create");
        expect(input.photoExpected).toBe(true);
        return localConfirmation;
      },
      uploadPhoto,
    });

    expect(outcome.status).toBe("pending-sync");
    expect(outcome.confirmation.pendingSync).toBe(true);
    expect(calls).toEqual(["save", "create"]);
    expect(uploadPhoto).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous create before photo delivery", async () => {
    const { calls, photo, store } = harness();
    const createClaim = vi.fn(async () => {
      calls.push("create");
      throw new Error("response lost");
    });
    const outcome = await submitClaimWorkflow({
      ownerKey: "account:user-1",
      placeId,
      store,
      photo,
      recommendation,
      createClaim,
      reconcileClaim: async () => { calls.push("reconcile"); return confirmation; },
      uploadPhoto: async () => { calls.push("upload"); },
    });

    expect(outcome.status).toBe("confirmed");
    expect(calls).toEqual(["save", "create", "reconcile", "upload", "remove"]);
    expect(createClaim).toHaveBeenCalledTimes(1);
  });

  it("leaves durable unresolved evidence when create and reconciliation both lose connectivity", async () => {
    const { calls, photo, store } = harness();
    const outcome = submitClaimWorkflow({
      ownerKey: "account:user-1",
      placeId,
      store,
      photo,
      recommendation,
      persistUnresolved: async (photoExpected) => { calls.push(`mark:${photoExpected}`); },
      clearUnresolved: async () => { calls.push("clear-marker"); },
      createClaim: async () => { calls.push("create"); throw new Error("connection closed"); },
      reconcileClaim: async () => { calls.push("reconcile"); throw new Error("offline"); },
      uploadPhoto: async () => { calls.push("upload"); },
    });

    await expect(outcome).rejects.toMatchObject({ name: "ClaimReconciliationRequiredError" });
    expect(calls).toEqual(["save", "mark:true", "create", "reconcile"]);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("does not create a new local visit while an earlier online create is unresolved", async () => {
    const { calls, photo, store } = harness();
    const createClaim = vi.fn(async () => { calls.push("create"); return confirmation; });
    const outcome = submitClaimWorkflow({
      ownerKey: "account:user-1",
      placeId,
      store,
      photo,
      photoAlreadyPersisted: true,
      reconcileFirst: true,
      unresolvedCreate: true,
      isOfflineRecommendation: (token) => token.startsWith("offline:"),
      recommendFresh: async () => ({ ...recommendation, recommendationToken: "offline:new-local-request" }),
      createClaim,
      reconcileClaim: async () => null,
      uploadPhoto: async () => { calls.push("upload"); },
    });

    await expect(outcome).rejects.toMatchObject({ name: "ClaimReconciliationUnavailableError" });
    expect(createClaim).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("still permits local save when connectivity is known offline before any create attempt", async () => {
    const { calls, photo, store } = harness();
    const localConfirmation = { ...confirmation, pendingSync: true };
    const outcome = await submitClaimWorkflow({
      ownerKey: "account:user-1",
      placeId,
      store,
      photo,
      recommendFresh: async () => ({ ...recommendation, recommendationToken: "offline:new-local-request" }),
      isOfflineRecommendation: (token) => token.startsWith("offline:"),
      persistUnresolved: async (photoExpected) => { calls.push(`mark:${photoExpected}`); },
      clearUnresolved: async () => { calls.push("clear-marker"); },
      createClaim: async () => { calls.push("create"); return localConfirmation; },
      uploadPhoto: async () => { calls.push("upload"); },
    });

    expect(outcome.status).toBe("pending-sync");
    expect(calls).toEqual(["save", "mark:true", "create", "clear-marker"]);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("does not reupload a photo already confirmed during reconciliation", async () => {
    const { calls, photo, store } = harness();
    const alreadyUploaded = { ...confirmation, claim: { ...confirmation.claim, hasPhoto: true } };
    const uploadPhoto = vi.fn(async () => { calls.push("upload"); });
    const outcome = await submitClaimWorkflow({
      ownerKey: "account:user-1",
      placeId,
      store,
      photo,
      photoAlreadyPersisted: true,
      reconcileFirst: true,
      createClaim: vi.fn(),
      reconcileClaim: async () => { calls.push("reconcile"); return alreadyUploaded; },
      uploadPhoto,
    });

    expect(outcome.status).toBe("confirmed");
    expect(calls).toEqual(["reconcile", "remove"]);
    expect(uploadPhoto).not.toHaveBeenCalled();
  });

  it("retains the private retry copy when upload fails", async () => {
    const { calls, photo, store } = harness();
    const outcome = await submitClaimWorkflow({
      ownerKey: "account:user-1",
      placeId,
      store,
      photo,
      recommendation,
      createClaim: async () => { calls.push("create"); return confirmation; },
      uploadPhoto: async () => { calls.push("upload"); throw new Error("offline"); },
    });

    expect(outcome.status).toBe("photo-retry");
    expect(outcome.status === "photo-retry" && outcome.step).toBe("upload");
    expect(calls).toEqual(["save", "create", "upload"]);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("cancels before the recommendation request if account state changes during location lookup", async () => {
    const recommendClaim = vi.fn(async () => recommendation);
    const getCurrentLocation = vi.fn(async () => ({ latitude: 48.4, longitude: -123.5, accuracyMeters: 8, capturedAtEpochMs: Date.now() }));
    await expect(recommendClaimAtCurrentLocation({
      getCurrentLocation,
      recommendClaim,
      shouldContinue: () => false,
    })).rejects.toThrow("paused while the account changes");
    expect(recommendClaim).not.toHaveBeenCalled();
  });
});
