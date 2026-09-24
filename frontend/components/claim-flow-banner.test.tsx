// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerNativeCapabilities, RestoredPhotoAwaitingAdoptionError } from "@/lib/native-capabilities";
import { normalizeVisitPhoto } from "@/lib/photo-processing";
import { ClaimFlowBanner } from "./claim-flow-banner";

vi.mock("@/lib/photo-processing", () => ({
  isPreparedVisitPhoto: (photo: { processingState?: string; file: File; mimeType: string }) => photo.processingState === "prepared" && photo.mimeType === "image/jpeg" && photo.file.size <= 900_000,
  normalizeVisitPhoto: vi.fn(async (photo) => photo),
}));

const place = { id: "provincial-goldstream-park", name: "Goldstream Park", category: "provincial" as const, latitude: 48.475557, longitude: -123.542431, region: "South Island", description: "A BC provincial park in the South Island collection. The map pin represents the largest official park polygon, not an entrance or trailhead.", sourceUrl: "https://catalogue.data.gov.bc.ca/dataset/parks-ecological-reserves-and-protected-areas", sourceName: "BC Parks / DataBC", sourceId: "705" };
const location = { latitude: place.latitude, longitude: place.longitude, accuracyMeters: 6, capturedAtEpochMs: Date.now() };
const recommendation = { status: "recommended" as const, recommendationToken: "initial", expiresAt: new Date(Date.now() + 60_000).toISOString(), candidate: { placeId: place.id, matchKind: "exact" as const, distanceMeters: 0 } };
const confirmation = { placeId: place.id, visited: true as const, visitedCount: 1, visitedAt: "2026-09-16T12:00:00Z", claim: { claimedAt: "2026-09-16T12:00:00Z", capturedAt: "2026-09-16T12:00:00Z", coordinates: { latitude: place.latitude, longitude: place.longitude }, accuracyMeters: 6, boundaryVersion: "v1", matchKind: "exact" as const, distanceMeters: 0, hasPhoto: false } };
const photoConfirmation = { ...confirmation, claim: { ...confirmation.claim, hasPhoto: true } };
let restore: () => void = () => undefined;

beforeEach(() => {
  vi.mocked(normalizeVisitPhoto).mockClear();
  vi.mocked(normalizeVisitPhoto).mockImplementation(async (photo) => photo);
});
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
  const onCompleted = vi.fn();
  const onDismiss = vi.fn();
  const onViewAccount = vi.fn();
  const onFlowActiveChange = vi.fn();
  const onClearRecommendation = vi.fn();
  const props = { place, recommendation, ownerKey: "account:user-1", recommendClaim, createClaim, reconcileClaim, uploadPhoto, onClaimed, onCompleted, onDismiss, onViewAccount, onFlowActiveChange, onClearRecommendation };
  const rendered = render(<ClaimFlowBanner {...props} busy={false} />);
  const rerenderBusy = (busy: boolean) => rendered.rerender(<ClaimFlowBanner {...props} busy={busy} />);
  const rerenderReset = (resetSignal: number) => rendered.rerender(<ClaimFlowBanner {...props} busy={false} resetSignal={resetSignal} />);
  return { retry, getPhoto, getCurrentLocation, recommendClaim, createClaim, reconcileClaim, uploadPhoto, onClaimed, onCompleted, onDismiss, onViewAccount, onFlowActiveChange, onClearRecommendation, rerenderBusy, rerenderReset };
}

async function openPhotoReview() {
  fireEvent.click(await screen.findByRole("button", { name: "Log visit + photo" }));
  return screen.findByRole("button", { name: "Save my visit" });
}

async function savePhotoReview() {
  fireEvent.click(await openPhotoReview());
}

describe("ClaimFlowBanner", () => {
  it("credits the original photo, license, and display changes on arrival", () => {
    setup(null);
    const credit = document.querySelector<HTMLElement>(".impression-arrival-credit")!;
    expect(credit.textContent).toContain("Changes: Resized without upscaling, converted to WebP");
    expect(credit.querySelector('a[href*="upload.wikimedia.org"]')).toBeTruthy();
    expect(credit.querySelector('a[href*="creativecommons.org"]')).toBeTruthy();
  });

  it("keeps the recommendation untouched when the camera is cancelled", async () => {
    const handlers = setup(null);
    fireEvent.click(await screen.findByRole("button", { name: "Log visit + photo" }));
    await waitFor(() => expect(handlers.getPhoto).toHaveBeenCalledTimes(1));
    expect(handlers.getCurrentLocation).not.toHaveBeenCalled();
    expect(handlers.recommendClaim).not.toHaveBeenCalled();
    expect(handlers.createClaim).not.toHaveBeenCalled();
    expect(handlers.uploadPhoto).not.toHaveBeenCalled();
    expect(handlers.onClaimed).not.toHaveBeenCalled();
  });

  it("rechecks a fresh location for a no-photo visit and shows the explicit success state", async () => {
    const handlers = setup(null);
    fireEvent.click(await screen.findByRole("button", { name: "Log without photo" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(confirmation));
    expect(handlers.getCurrentLocation).toHaveBeenCalledWith(expect.objectContaining({ maxAgeMs: 0, requirePrecise: true }));
    expect(handlers.recommendClaim).toHaveBeenCalledWith({ location });
    expect(handlers.createClaim).toHaveBeenCalledWith({ recommendationToken: "fresh", expectedPlaceId: place.id });
    expect(handlers.uploadPhoto).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "You were here." })).toBeTruthy();
    expect(handlers.onCompleted).toHaveBeenCalledWith(confirmation);
    expect(handlers.onClearRecommendation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to map" }));
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
    expect(handlers.onClearRecommendation).toHaveBeenCalledTimes(1);
  });

  it("reconciles a failed no-photo retry before requesting another location", async () => {
    const handlers = setup(null);
    handlers.getCurrentLocation.mockRejectedValueOnce(new Error("gps offline"));
    handlers.reconcileClaim.mockResolvedValueOnce(confirmation);
    fireEvent.click(await screen.findByRole("button", { name: "Log without photo" }));
    expect(await screen.findByRole("button", { name: "Retry saved visit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved visit" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(confirmation));
    expect(handlers.reconcileClaim).toHaveBeenCalledWith(place.id);
    expect(handlers.getCurrentLocation).toHaveBeenCalledTimes(1);
    expect(handlers.createClaim).not.toHaveBeenCalled();
  });

  it("keeps the durable photo when retake is cancelled", async () => {
    const first = new File(["first"], "first.jpg", { type: "image/jpeg" });
    const handlers = setup(first);
    handlers.getPhoto.mockResolvedValueOnce({ file: first, mimeType: first.type }).mockResolvedValueOnce(null);
    await openPhotoReview();
    fireEvent.click(screen.getByRole("button", { name: "Retake photo" }));
    await waitFor(() => expect(handlers.getPhoto).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Save my visit" })).toBeTruthy();
    expect(handlers.retry.save).toHaveBeenCalledTimes(1);
    expect(handlers.retry.remove).not.toHaveBeenCalled();
  });

  it("uploads a retaken hydrated photo even when reconciliation reports an older server photo", async () => {
    const oldPhoto = new File(["old"], "old.jpg", { type: "image/jpeg" });
    const replacement = new File(["replacement"], "replacement.jpg", { type: "image/jpeg" });
    const handlers = setup(null, undefined, { load: vi.fn().mockResolvedValue({ file: oldPhoto, mimeType: oldPhoto.type, processingState: "prepared" }) });
    handlers.getPhoto.mockResolvedValueOnce({ file: replacement, mimeType: replacement.type });
    handlers.reconcileClaim.mockResolvedValueOnce({ ...confirmation, claim: { ...confirmation.claim, hasPhoto: true } });
    expect(await screen.findByRole("button", { name: "Save my visit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retake photo" }));
    await waitFor(() => expect(handlers.getPhoto).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save my visit" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(expect.objectContaining({ claim: expect.objectContaining({ hasPhoto: true }) })));
    expect(handlers.uploadPhoto).toHaveBeenCalledWith(place.id, replacement);
  });

  it("prompts before adopting the exact restored camera attempt", async () => {
    const photo = new File(["restored"], "restored.jpg", { type: "image/jpeg" });
    const handlers = setup(photo);
    handlers.getPhoto
      .mockRejectedValueOnce(new RestoredPhotoAwaitingAdoptionError("restored-attempt-a"))
      .mockResolvedValueOnce({ file: photo, mimeType: photo.type });

    fireEvent.click(await screen.findByRole("button", { name: "Log visit + photo" }));
    expect(await screen.findByText(/recovered camera photo is waiting/i)).toBeTruthy();
    expect(handlers.createClaim).not.toHaveBeenCalled();

    await waitFor(() => expect((screen.getByRole("button", { name: "Log visit + photo" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Log visit + photo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save my visit" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(photoConfirmation));
    expect(handlers.getPhoto).toHaveBeenNthCalledWith(2, expect.objectContaining({ captureAttemptId: "restored-attempt-a" }));
  });

  it("persists the accepted photo, revalidates location, claims, uploads, then reports the postcard", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const handlers = setup(photo);
    await savePhotoReview();
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(photoConfirmation));
    expect(handlers.getPhoto).toHaveBeenCalledWith(expect.objectContaining({ ownerKey: "account:user-1", placeId: place.id, captureAttemptId: expect.any(String) }));
    expect(handlers.retry.save).toHaveBeenNthCalledWith(1, "account:user-1", place.id, { file: photo, mimeType: photo.type }, { rawStaging: true });
    expect(handlers.retry.save).toHaveBeenNthCalledWith(2, "account:user-1", place.id, { file: photo, mimeType: photo.type });
    expect(handlers.getCurrentLocation).toHaveBeenCalledWith(expect.objectContaining({ requirePrecise: true }));
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
    await savePhotoReview();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Your visit is saved/);
    expect(handlers.onClaimed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry photo" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(photoConfirmation));
    expect(uploadPhoto).toHaveBeenCalledTimes(2);
  });

  it("shows the active upload stage and reconciles before retrying an ambiguous upload", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const uploadResult = Promise.withResolvers<void>();
    const uploadPhoto = vi.fn().mockReturnValueOnce(uploadResult.promise).mockResolvedValue(undefined);
    const handlers = setup(photo, uploadPhoto);
    await savePhotoReview();
    expect((await screen.findByRole("status")).textContent).toMatch(/Uploading photo/);
    uploadResult.reject(new Error("Photo upload paused after 30 seconds."));
    expect((await screen.findByRole("alert")).textContent).toMatch(/retry photo is saved/i);
    handlers.reconcileClaim.mockResolvedValueOnce({ ...confirmation, claim: { ...confirmation.claim, hasPhoto: true } });
    fireEvent.click(screen.getByRole("button", { name: "Retry photo" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(expect.objectContaining({ claim: expect.objectContaining({ hasPhoto: true }) })));
    expect(handlers.reconcileClaim).toHaveBeenCalledWith(place.id);
    expect(uploadPhoto).toHaveBeenCalledTimes(2);
  });

  it("keeps an accepted photo and retries a failed pre-claim check without reopening the camera", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const handlers = setup(photo);
    handlers.recommendClaim.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ...recommendation, recommendationToken: "fresh" });
    await savePhotoReview();
    expect(await screen.findByRole("button", { name: "Retry saved visit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved visit" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(photoConfirmation));
    expect(handlers.getPhoto).toHaveBeenCalledTimes(1);
    expect(handlers.getCurrentLocation).toHaveBeenCalledTimes(2);
    expect(handlers.retry.save).toHaveBeenCalledTimes(2);
  });

  it("pauses after persisting the photo when an account transition starts", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const locationResult = Promise.withResolvers<typeof location>();
    const handlers = setup(photo);
    handlers.getCurrentLocation.mockReturnValueOnce(locationResult.promise);
    await openPhotoReview();
    fireEvent.click(screen.getByRole("button", { name: "Save my visit" }));
    await waitFor(() => expect(handlers.retry.save.mock.calls.length).toBeGreaterThanOrEqual(1));
    handlers.rerenderBusy(true);
    locationResult.resolve(location);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Your photo is saved.*account change completes/);
    expect(handlers.recommendClaim).not.toHaveBeenCalled();
    expect(handlers.createClaim).not.toHaveBeenCalled();
    expect(handlers.uploadPhoto).not.toHaveBeenCalled();
  });

  it("restores a persisted pre-claim photo after remount without reopening the camera", async () => {
    const photo = new File(["saved-photo"], "bell-park.jpg", { type: "image/jpeg" });
    const handlers = setup(null, undefined, { load: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }) });
    expect(await screen.findByRole("button", { name: "Save my visit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save my visit" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(photoConfirmation));
    expect(handlers.getPhoto).not.toHaveBeenCalled();
    expect(handlers.retry.save).toHaveBeenCalledWith("account:user-1", place.id, { file: photo, mimeType: photo.type });
    expect(handlers.reconcileClaim).toHaveBeenCalledWith(place.id);
    expect(handlers.uploadPhoto).toHaveBeenCalledWith(place.id, photo);
  });

  it("invalidates a hydrated retry flow when the account reset completes", async () => {
    const photo = new File(["saved-photo"], "bell-park.jpg", { type: "image/jpeg" });
    const load = vi.fn().mockResolvedValueOnce({ file: photo, mimeType: photo.type }).mockResolvedValueOnce(null);
    const handlers = setup(null, undefined, { load });
    expect(await screen.findByRole("button", { name: "Save my visit" })).toBeTruthy();
    handlers.rerenderReset(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save my visit" })).toBeNull());
    expect(handlers.onFlowActiveChange).toHaveBeenCalledWith(null);
    expect(handlers.onClearRecommendation).toHaveBeenCalled();
  });

  it("does not rehydrate a retry photo whose storage read finishes after reset", async () => {
    const photo = new File(["saved-photo"], "bell-park.jpg", { type: "image/jpeg" });
    let resolveOldLoad!: (value: { file: File; mimeType: string }) => void;
    const oldLoad = new Promise<{ file: File; mimeType: string }>((resolve) => { resolveOldLoad = resolve; });
    const load = vi.fn().mockReturnValueOnce(oldLoad).mockResolvedValueOnce(null);
    const save = vi.fn();
    const handlers = setup(null, undefined, { load, save });

    handlers.rerenderReset(1);
    await act(async () => { resolveOldLoad({ file: photo, mimeType: photo.type }); });

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Save my visit" })).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(handlers.onFlowActiveChange).toHaveBeenLastCalledWith(null);
  });

  it("marks a durable retry read active until storage proves there is no saved photo", async () => {
    let resolveLoad!: (value: null) => void;
    const load = vi.fn(() => new Promise<null>((resolve) => { resolveLoad = resolve; }));
    const handlers = setup(null, undefined, { load });

    await waitFor(() => expect(handlers.onFlowActiveChange).toHaveBeenCalledWith(place.id));
    await act(async () => { resolveLoad(null); });
    await waitFor(() => expect(handlers.onFlowActiveChange).toHaveBeenLastCalledWith(null));
  });

  it("re-enables account recovery when a durable retry read hangs", async () => {
    vi.useFakeTimers();
    try {
      const handlers = setup(null, undefined, { load: vi.fn(() => new Promise(() => undefined)) });
      expect(handlers.onFlowActiveChange).toHaveBeenCalledWith(place.id);
      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
      expect(screen.getByText(/could not safely check for an existing photo/i)).toBeTruthy();
      expect(handlers.onFlowActiveChange).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uploads a prepared persisted JPEG byte-identically without recompressing on hydration or claim retry", async () => {
    const photo = new File(["already-prepared-jpeg"], "bell-park.jpg", { type: "image/jpeg" });
    const handlers = setup(null, undefined, {
      load: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type, processingState: "prepared" }),
    });
    expect(await screen.findByRole("button", { name: "Save my visit" })).toBeTruthy();
    expect(normalizeVisitPhoto).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save my visit" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(photoConfirmation));

    expect(normalizeVisitPhoto).not.toHaveBeenCalled();
    expect(handlers.uploadPhoto).toHaveBeenCalledWith(place.id, photo);
    expect(handlers.retry.save).toHaveBeenCalledWith("account:user-1", place.id, { file: photo, mimeType: photo.type, processingState: "prepared" });
  });

  it("blocks camera capture while durable-photo recovery is still pending", async () => {
    const pending = Promise.withResolvers<null>();
    const handlers = setup(null, undefined, { load: vi.fn().mockReturnValue(pending.promise) });
    const checking = screen.getByRole("button", { name: "Checking saved photos…" });
    expect((checking as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(checking);
    expect(handlers.getPhoto).not.toHaveBeenCalled();
    pending.resolve(null);
    expect((await screen.findByRole("button", { name: "Log visit + photo" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("retries failed durable-photo recovery instead of allowing an overwrite", async () => {
    const saved = new File(["original"], "original.jpg", { type: "image/jpeg" });
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("storage busy"))
      .mockResolvedValueOnce({ file: saved, mimeType: saved.type });
    const handlers = setup(null, undefined, { load });
    expect(await screen.findByRole("button", { name: "Retry saved photo check" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log visit + photo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved photo check" }));
    expect(await screen.findByRole("button", { name: "Save my visit" })).toBeTruthy();
    expect(handlers.getPhoto).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not delete an existing retry entry when saving a replacement fails", async () => {
    const photo = new File(["replacement"], "replacement.jpg", { type: "image/jpeg" });
    const handlers = setup(photo, undefined, { save: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("storage full")) });
    await openPhotoReview();
    fireEvent.click(screen.getByRole("button", { name: "Save my visit" }));
    expect(await screen.findByText(/storage full/)).toBeTruthy();
    expect(handlers.retry.remove).not.toHaveBeenCalled();
  });

  it("durably saves accepted camera bytes before normalization and retries normalization without reopening the camera", async () => {
    const original = new File(["original-camera-bytes"], "original.jpg", { type: "image/jpeg" });
    vi.mocked(normalizeVisitPhoto).mockRejectedValueOnce(new Error("decoder unavailable"));
    const handlers = setup(original);

    await openPhotoReview();

    expect(await screen.findByRole("button", { name: "Save my visit" })).toBeTruthy();
    expect(handlers.retry.save).toHaveBeenCalledTimes(1);
    expect(handlers.retry.save).toHaveBeenCalledWith("account:user-1", place.id, { file: original, mimeType: "image/jpeg" }, { rawStaging: true });
    expect(handlers.createClaim).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save my visit" }));
    expect(await screen.findByText(/decoder unavailable/i)).toBeTruthy();
    vi.mocked(normalizeVisitPhoto).mockResolvedValueOnce({ file: original, mimeType: "image/jpeg", processingState: "prepared" });
    fireEvent.click(screen.getByRole("button", { name: "Save my visit" }));
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(photoConfirmation));
    expect(handlers.getPhoto).toHaveBeenCalledTimes(1);
    expect(handlers.retry.save).toHaveBeenCalledTimes(2);
  });

  it("stages a camera capture larger than 8 MiB before replacing it with the bounded JPEG", async () => {
    const raw = new File([new Uint8Array(9 * 1024 * 1024)], "large-camera.jpg", { type: "image/jpeg" });
    const normalized = new File(["bounded"], "large-camera.jpg", { type: "image/jpeg" });
    vi.mocked(normalizeVisitPhoto).mockResolvedValueOnce({ file: normalized, mimeType: "image/jpeg" });
    const handlers = setup(raw);

    await savePhotoReview();
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(photoConfirmation));

    expect(handlers.retry.save).toHaveBeenNthCalledWith(1, "account:user-1", place.id, { file: raw, mimeType: "image/jpeg" }, { rawStaging: true });
    expect(handlers.retry.save).toHaveBeenNthCalledWith(2, "account:user-1", place.id, { file: normalized, mimeType: "image/jpeg" });
    expect(handlers.uploadPhoto).toHaveBeenCalledWith(place.id, normalized);
  });

  it("reconciles a committed claim whose response was lost before uploading the saved photo", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const reconcileClaim = vi.fn().mockResolvedValue(confirmation);
    const handlers = setup(photo, undefined, {}, reconcileClaim);
    handlers.createClaim.mockRejectedValueOnce(new Error("connection closed"));
    await savePhotoReview();
    await waitFor(() => expect(handlers.onClaimed).toHaveBeenCalledWith(photoConfirmation));
    expect(reconcileClaim).toHaveBeenCalledWith(place.id);
    expect(handlers.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(handlers.retry.remove).toHaveBeenCalledWith("account:user-1", place.id);
  });

  it("retries only private-copy cleanup after the photo upload has succeeded", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const remove = vi.fn().mockRejectedValueOnce(new Error("storage busy")).mockResolvedValueOnce(undefined);
    const handlers = setup(photo, undefined, { remove });
    await savePhotoReview();
    expect(await screen.findByRole("button", { name: "Retry private photo cleanup" })).toBeTruthy();
    expect(handlers.onClaimed).toHaveBeenCalledWith(photoConfirmation);
    fireEvent.click(screen.getByRole("button", { name: "Retry private photo cleanup" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry private photo cleanup" })).toBeNull());
    expect(handlers.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(handlers.onClaimed).toHaveBeenCalledTimes(1);
  });

  it("retains the accepted photo when the fresh post-camera check is outside the park", async () => {
    const photo = new File(["photo"], "bell-park.jpg", { type: "image/jpeg" });
    const handlers = setup(photo);
    handlers.recommendClaim.mockResolvedValueOnce({ status: "no_candidate" });
    await savePhotoReview();
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not confirm that you are still in this park/);
    expect(screen.getByRole("button", { name: "Retry saved visit" })).toBeTruthy();
    expect(handlers.createClaim).not.toHaveBeenCalled();
    expect(handlers.retry.remove).not.toHaveBeenCalled();
    expect(handlers.onClearRecommendation).toHaveBeenCalledTimes(1);
    expect(handlers.onFlowActiveChange).toHaveBeenLastCalledWith(place.id);
  });
});
