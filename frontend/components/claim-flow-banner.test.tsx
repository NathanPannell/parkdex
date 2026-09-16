// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerNativeCapabilities } from "@/lib/native-capabilities";
import { ClaimFlowBanner } from "./claim-flow-banner";

const place = { id: "regional-bell-park", name: "Bell Park", category: "regional" as const, latitude: 49.0918726, longitude: -123.0600868, region: "Delta", description: "Neighbourhood park", sourceUrl: "https://example.test", sourceName: "City of Delta" };
const location = { latitude: place.latitude, longitude: place.longitude, accuracyMeters: 6, capturedAtEpochMs: Date.now() };
const recommendation = { status: "recommended" as const, recommendationToken: "initial", expiresAt: new Date(Date.now() + 60_000).toISOString(), candidate: { placeId: place.id, matchKind: "exact" as const, distanceMeters: 0 } };
const confirmation = { placeId: place.id, visited: true as const, visitedCount: 1, visitedAt: "2026-09-16T12:00:00Z", claim: { claimedAt: "2026-09-16T12:00:00Z", capturedAt: "2026-09-16T12:00:00Z", coordinates: { latitude: place.latitude, longitude: place.longitude }, accuracyMeters: 6, boundaryVersion: "v1", matchKind: "exact" as const, distanceMeters: 0, hasPhoto: false } };
let restore: () => void = () => undefined;

afterEach(() => { cleanup(); restore(); vi.restoreAllMocks(); });

function setup(
  photo: File | null,
  uploadPhoto = vi.fn().mockResolvedValue(undefined),
  retryOverrides: Partial<{ save: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; clearOwner: ReturnType<typeof vi.fn> }> = {},
  reconcileClaim = vi.fn().mockResolvedValue(null),
) {
  const retry = { save: vi.fn().mockResolvedValue(undefined), load: vi.fn().mockResolvedValue(null), remove: vi.fn().mockResolvedValue(undefined), clearOwner: vi.fn().mockResolvedValue(undefined), ...retryOverrides };
  const getPhoto = vi.fn().mockResolvedValue(photo ? { file: photo, mimeType: photo.type } : null);
  const getCurrentLocation = vi.fn().mockResolvedValue(location);
  restore = registerNativeCapabilities({ getPhoto, getCurrentLocation, photoRetry: retry });
  const recommendClaim = vi.fn().mockResolvedValue({ ...recommendation, recommendationToken: "fresh" });
  const createClaim = vi.fn().mockResolvedValue(confirmation);
  const onClaimed = vi.fn();
  const onFlowActiveChange = vi.fn();
  const onClearRecommendation = vi.fn();
  const props = { place, recommendation, ownerKey: "account:user-1", recommendClaim, createClaim, reconcileClaim, uploadPhoto, onClaimed, onFlowActiveChange, onClearRecommendation };
  const rendered = render(<ClaimFlowBanner {...props} busy={false} />);
  const rerenderBusy = (busy: boolean) => rendered.rerender(<ClaimFlowBanner {...props} busy={busy} />);
  return { retry, getPhoto, getCurrentLocation, recommendClaim, createClaim, reconcileClaim, uploadPhoto, onClaimed, onFlowActiveChange, onClearRecommendation, rerenderBusy };
}

describe("ClaimFlowBanner", () => {
  it("keeps the recommendation untouched when the camera is cancelled", async () => {
    const handlers = setup(null);
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    await waitFor(() => expect(handlers.getPhoto).toHaveBeenCalledTimes(1));
    expect(handlers.getCurrentLocation).not.toHaveBeenCalled();
    expect(handlers.recommendClaim).not.toHaveBeenCalled();
    expect(handlers.createClaim).not.toHaveBeenCalled();
    expect(handlers.uploadPhoto).not.toHaveBeenCalled();
    expect(handlers.onClaimed).not.toHaveBeenCalled();
  });

  it("persists the accepted photo, revalidates location, claims, uploads, then reports the postcard", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const handlers = setup(photo);
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(confirmation));
    expect(handlers.retry.save).toHaveBeenCalledWith("account:user-1", place.id, { file: photo, mimeType: photo.type });
    expect(handlers.recommendClaim).toHaveBeenCalledWith({ location });
    expect(handlers.createClaim).toHaveBeenCalledWith({ recommendationToken: "fresh", expectedPlaceId: place.id });
    expect(handlers.uploadPhoto).toHaveBeenCalledWith(place.id, photo);
    expect(handlers.retry.remove).toHaveBeenCalledWith("account:user-1", place.id);
    expect(handlers.retry.save.mock.invocationCallOrder[0]).toBeLessThan(handlers.createClaim.mock.invocationCallOrder[0]);
    expect(handlers.uploadPhoto.mock.invocationCallOrder[0]).toBeLessThan(handlers.onClaimed.mock.invocationCallOrder[0]);
  });

  it("keeps the saved visit and offers photo retry when upload fails", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const uploadPhoto = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const handlers = setup(photo, uploadPhoto);
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    expect(await screen.findByText(/Your visit is saved/)).toBeTruthy();
    expect(handlers.onClaimed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry photo" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(confirmation));
    expect(uploadPhoto).toHaveBeenCalledTimes(2);
  });

  it("keeps an accepted photo and retries a failed pre-claim check without reopening the camera", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const handlers = setup(photo);
    handlers.recommendClaim.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ...recommendation, recommendationToken: "fresh" });
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    expect(await screen.findByRole("button", { name: "Retry claim" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry claim" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(confirmation));
    expect(handlers.getPhoto).toHaveBeenCalledTimes(1);
    expect(handlers.getCurrentLocation).toHaveBeenCalledTimes(2);
    expect(handlers.retry.save).toHaveBeenCalledTimes(1);
  });

  it("pauses after persisting the photo when an account transition starts", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const locationResult = Promise.withResolvers<typeof location>();
    const handlers = setup(photo);
    handlers.getCurrentLocation.mockReturnValueOnce(locationResult.promise);
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    await waitFor(() => expect(handlers.retry.save).toHaveBeenCalledTimes(1));
    handlers.rerenderBusy(true);
    locationResult.resolve(location);
    expect(await screen.findByText(/Your photo is saved.*account change completes/)).toBeTruthy();
    expect(handlers.recommendClaim).not.toHaveBeenCalled();
    expect(handlers.createClaim).not.toHaveBeenCalled();
    expect(handlers.uploadPhoto).not.toHaveBeenCalled();
  });

  it("restores a persisted pre-claim photo after remount without reopening the camera", async () => {
    const photo = new File(["saved-photo"], "bell-park.jpg", { type: "image/jpeg" });
    const handlers = setup(null, undefined, { load: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }) });
    expect(await screen.findByRole("button", { name: "Retry claim" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry claim" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(confirmation));
    expect(handlers.getPhoto).not.toHaveBeenCalled();
    expect(handlers.reconcileClaim).toHaveBeenCalledWith(place.id);
    expect(handlers.uploadPhoto).toHaveBeenCalledWith(place.id, photo);
  });

  it("blocks camera capture while durable-photo recovery is still pending", async () => {
    const pending = Promise.withResolvers<null>();
    const handlers = setup(null, undefined, { load: vi.fn().mockReturnValue(pending.promise) });
    const checking = screen.getByRole("button", { name: "Checking…" });
    expect((checking as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(checking);
    expect(handlers.getPhoto).not.toHaveBeenCalled();
    pending.resolve(null);
    expect((await screen.findByRole("button", { name: "Claim + photo" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("retries failed durable-photo recovery instead of allowing an overwrite", async () => {
    const saved = new File(["original"], "original.jpg", { type: "image/jpeg" });
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("storage busy"))
      .mockResolvedValueOnce({ file: saved, mimeType: saved.type });
    const handlers = setup(null, undefined, { load });
    expect(await screen.findByRole("button", { name: "Retry saved photo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Claim + photo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved photo" }));
    expect(await screen.findByRole("button", { name: "Retry claim" })).toBeTruthy();
    expect(handlers.getPhoto).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not delete an existing retry entry when saving a replacement fails", async () => {
    const photo = new File(["replacement"], "replacement.jpg", { type: "image/jpeg" });
    const handlers = setup(photo, undefined, { save: vi.fn().mockRejectedValue(new Error("storage full")) });
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    expect(await screen.findByText("storage full")).toBeTruthy();
    expect(handlers.retry.remove).not.toHaveBeenCalled();
  });

  it("reconciles a committed claim whose response was lost before uploading the saved photo", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const reconcileClaim = vi.fn().mockResolvedValue(confirmation);
    const handlers = setup(photo, undefined, {}, reconcileClaim);
    handlers.createClaim.mockRejectedValueOnce(new Error("connection closed"));
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(confirmation));
    expect(reconcileClaim).toHaveBeenCalledWith(place.id);
    expect(handlers.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(handlers.retry.remove).toHaveBeenCalledWith("account:user-1", place.id);
  });

  it("retries only private-copy cleanup after the photo upload has succeeded", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const remove = vi.fn().mockRejectedValueOnce(new Error("storage busy")).mockResolvedValueOnce(undefined);
    const handlers = setup(photo, undefined, { remove });
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    expect(await screen.findByRole("button", { name: "Retry cleanup" })).toBeTruthy();
    expect(handlers.onClaimed).toHaveBeenCalledWith(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry cleanup" })).toBeNull());
    expect(handlers.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(handlers.onClaimed).toHaveBeenCalledTimes(1);
  });

  it("dismisses stale eligibility when the fresh post-camera check is outside the park", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const handlers = setup(photo);
    handlers.recommendClaim.mockResolvedValueOnce({ status: "no_candidate" });
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    expect(await screen.findByText(/could not confirm that you are still in this park/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(handlers.createClaim).not.toHaveBeenCalled();
    expect(handlers.retry.remove).toHaveBeenCalledWith("account:user-1", place.id);
    expect(handlers.onClearRecommendation).toHaveBeenCalledTimes(1);
  });
});
