// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Visit } from "@/lib/account";
import { registerNativeCapabilities } from "@/lib/native-capabilities";
import { createBrowserPhotoRetryStore } from "@/lib/photo-retry";
import { markUnresolvedClaim } from "@/lib/claim-recovery";
import { ClaimVisitPanel } from "./claim-visit-panel";

const place = { id: "provincial-juan-de-fuca-park", name: "Forest Park", category: "provincial" as const, latitude: 49, longitude: -124, region: "South Island", description: "Forest", sourceUrl: "https://example.test", sourceName: "BC Parks" };
const location = { latitude: 49, longitude: -124, accuracyMeters: 8, capturedAtEpochMs: Date.now() };
const recommendation = { status: "recommended" as const, recommendationToken: "token", expiresAt: new Date(Date.now() + 60_000).toISOString(), candidate: { placeId: place.id, matchKind: "exact" as const, distanceMeters: 0 } };
const confirmation = { placeId: place.id, visited: true as const, visitedCount: 1, visitedAt: "2026-09-08T12:00:00Z", claim: { claimedAt: "2026-09-08T12:00:00Z", capturedAt: "2026-09-08T12:00:00Z", coordinates: { latitude: 49, longitude: -124 }, accuracyMeters: 8, boundaryVersion: "v1", matchKind: "exact" as const, distanceMeters: 0, hasPhoto: false } };

let restore: () => void = () => undefined;

afterEach(() => { cleanup(); window.localStorage.clear(); restore(); vi.restoreAllMocks(); });

async function clickCamera() {
  const button = screen.getByRole("button", { name: "Take an optional visit photo" }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

describe("ClaimVisitPanel durable photo retry", () => {
  it("saves a confirmed photo before creating the claim and stops when persistence reports false", async () => {
    const photo = new File(["private photo"], "visit.jpg", { type: "image/jpeg" });
    const save = vi.fn().mockResolvedValue(false);
    const store = { save, load: vi.fn().mockResolvedValue(null), remove: vi.fn().mockResolvedValue(undefined), clearOwner: vi.fn().mockResolvedValue(undefined) };
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim: vi.fn().mockResolvedValue(confirmation), uploadPhoto: vi.fn().mockResolvedValue(undefined), loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }), photoRetry: store });

    render(<ClaimVisitPanel {...handlers} />);
    await clickCamera();
    fireEvent.click(await screen.findByRole("button", { name: "Use photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm this visit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log this visit" }));

    expect(await screen.findByText(/could not be saved for retry/i)).toBeTruthy();
    expect(save).toHaveBeenCalledWith("account:first", place.id, { file: photo, mimeType: photo.type });
    expect(handlers.createClaim).not.toHaveBeenCalled();
    expect(handlers.uploadPhoto).not.toHaveBeenCalled();
  });

  it("keeps the saved photo when the claim response is lost, then retries after the claim appears", async () => {
    const store = createBrowserPhotoRetryStore();
    const photo = new File(["private photo"], "visit.jpg", { type: "image/jpeg" });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const createClaim = vi.fn().mockRejectedValueOnce(new Error("request lost"));
    const uploadPhoto = vi.fn().mockResolvedValue(undefined);
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim, uploadPhoto, loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined) };
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }), photoRetry: store });

    const first = render(<ClaimVisitPanel {...handlers} />);
    await clickCamera();
    fireEvent.click(await screen.findByRole("button", { name: "Use photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm this visit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log this visit" }));
    expect(await screen.findByText(/Parkdex could not confirm whether your visit saved.*Reconnect before retrying/i)).toBeTruthy();
    await expect(store.load("account:first", place.id).then((value) => value?.file.text())).resolves.toBe("private photo");

    first.unmount();
    render(<ClaimVisitPanel {...handlers} visit={confirmation as Visit} />);
    expect(await screen.findByRole("button", { name: "Retry photo upload" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry photo upload" }));
    await waitFor(() => expect(uploadPhoto).toHaveBeenCalledWith(place.id, photo));
    await expect(store.load("account:first", place.id)).resolves.toBeNull();
  });

  it("recovers a pre-claim photo as confirmed pending photo when no visit exists", async () => {
    const store = createBrowserPhotoRetryStore();
    const photo = new File(["private photo"], "visit.jpg", { type: "image/jpeg" });
    await store.save("account:first", place.id, { file: photo, mimeType: photo.type });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim: vi.fn().mockResolvedValue(confirmation), uploadPhoto: vi.fn().mockResolvedValue(undefined), loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined) };
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue(null), photoRetry: store });

    render(<ClaimVisitPanel {...handlers} />);
    expect(await screen.findByText("Photo ready for Forest Park")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry photo upload" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use photo" })).toBeNull();
    expect(screen.queryByText(/your visit is saved/i)).toBeNull();
    expect(handlers.createClaim).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm this visit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log this visit" }));
    await waitFor(() => expect(handlers.uploadPhoto).toHaveBeenCalledWith(place.id, photo));
    await expect(store.load("account:first", place.id)).resolves.toBeNull();
  });

  it("surfaces server-photo cleanup failures and retries without offering another upload", async () => {
    const store = createBrowserPhotoRetryStore();
    const remove = vi.fn().mockRejectedValueOnce(new Error("storage busy")).mockResolvedValueOnce(undefined);
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim: vi.fn().mockResolvedValue(confirmation), uploadPhoto: vi.fn().mockResolvedValue(undefined), loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined) };
    store.remove = remove;
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue(null), photoRetry: store });

    render(<ClaimVisitPanel {...handlers} visit={{ ...confirmation, claim: { ...confirmation.claim, hasPhoto: true } } as Visit} />);
    expect(await screen.findByRole("button", { name: "Retry private photo cleanup" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry photo upload" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry private photo cleanup" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry private photo cleanup" })).toBeNull());
  });

  it("preserves the previous owner's private photo across an account identity change", async () => {
    const store = createBrowserPhotoRetryStore();
    const photo = new File(["private photo"], "visit.jpg", { type: "image/jpeg" });
    await store.save("account:first", place.id, { file: photo, mimeType: photo.type });
    const clearOwner = vi.fn().mockResolvedValue(undefined);
    store.clearOwner = clearOwner;
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim: vi.fn().mockResolvedValue(confirmation), uploadPhoto: vi.fn().mockResolvedValue(undefined), loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined) };
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue(null), photoRetry: store });

    const { rerender } = render(<ClaimVisitPanel {...handlers} />);
    rerender(<ClaimVisitPanel {...handlers} ownerKey="account:second" />);
    await waitFor(async () => expect(await store.load("account:first", place.id)).not.toBeNull());
    expect(clearOwner).not.toHaveBeenCalled();
    expect(screen.queryByText("Photo ready for Forest Park")).toBeNull();
  });

  it("hydrates a no-photo ambiguous create and keeps retry reconciliation-first", async () => {
    const store = createBrowserPhotoRetryStore();
    await markUnresolvedClaim("account:first", place.id, false);
    const reconcileClaim = vi.fn().mockRejectedValue(new Error("offline"));
    const recommendClaim = vi.fn().mockResolvedValue(recommendation);
    const createClaim = vi.fn().mockResolvedValue(confirmation);
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim, createClaim, reconcileClaim, uploadPhoto: vi.fn().mockResolvedValue(undefined), loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined) };
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue(null), photoRetry: store });

    render(<ClaimVisitPanel {...handlers} />);
    expect(await screen.findByRole("button", { name: "Retry saved visit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved visit" }));
    expect(await screen.findByText(/Reconnect before retrying/)).toBeTruthy();
    expect(reconcileClaim).toHaveBeenCalledWith(place.id);
    expect(recommendClaim).not.toHaveBeenCalled();
    expect(createClaim).not.toHaveBeenCalled();
  });

  it("keeps an offline detail visit pending without reporting success or offering another check-in", async () => {
    const onClaimed = vi.fn();
    const createClaim = vi.fn().mockResolvedValue({ ...confirmation, pendingSync: true });
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim, uploadPhoto: vi.fn().mockResolvedValue(undefined), loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined), onClaimed };
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue(null) });

    render(<ClaimVisitPanel {...handlers} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm this visit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log this visit" }));

    expect(await screen.findByText("Saved on this device. Syncs when online.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm this visit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take an optional visit photo" })).toBeNull();
    expect(onClaimed).not.toHaveBeenCalled();
    expect(createClaim).toHaveBeenCalledTimes(1);
  });

  it("surfaces transient saved-photo load failures and blocks replacement until recovery", async () => {
    const store = createBrowserPhotoRetryStore();
    const photo = new File(["private photo"], "visit.jpg", { type: "image/jpeg" });
    const load = vi.fn().mockRejectedValueOnce(new Error("storage busy")).mockResolvedValueOnce({ file: photo, mimeType: photo.type });
    store.load = load;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim: vi.fn().mockResolvedValue(confirmation), uploadPhoto: vi.fn().mockResolvedValue(undefined), loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined) };
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue(null), photoRetry: store });

    render(<ClaimVisitPanel {...handlers} />);
    expect(await screen.findByRole("button", { name: "Retry saved photo recovery" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Take an optional visit photo" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Photo ready for Forest Park")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry saved photo recovery" }));
    expect(await screen.findByText("Photo ready for Forest Park")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry saved photo recovery" })).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("waits for initial saved-photo hydration before allowing a camera replacement or cancel", async () => {
    const store = createBrowserPhotoRetryStore();
    let resolveLoad: ((photo: null) => void) | undefined;
    const load = vi.fn(() => new Promise<null>((resolve) => { resolveLoad = resolve; }));
    store.load = load;
    const getPhoto = vi.fn().mockResolvedValue(null);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim: vi.fn().mockResolvedValue(confirmation), uploadPhoto: vi.fn().mockResolvedValue(undefined), loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined) };
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto, photoRetry: store });

    render(<ClaimVisitPanel {...handlers} />);
    const captureButton = screen.getByRole("button", { name: "Take an optional visit photo" }) as HTMLButtonElement;
    expect(captureButton.disabled).toBe(true);
    expect(getPhoto).not.toHaveBeenCalled();

    resolveLoad?.(null);
    await waitFor(() => expect(captureButton.disabled).toBe(false));
    fireEvent.click(captureButton);
    await waitFor(() => expect(getPhoto).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Photo ready for Forest Park")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry photo upload" })).toBeNull();
  });

  it("reloads a failed upload after the panel is remounted and removes it after success", async () => {
    const store = createBrowserPhotoRetryStore();
    const photo = new File(["private photo"], "visit.jpg", { type: "image/jpeg" });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const uploadPhoto = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim: vi.fn().mockResolvedValue(confirmation), uploadPhoto, loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined) };
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }), photoRetry: store });

    const first = render(<ClaimVisitPanel {...handlers} />);
    await clickCamera();
    fireEvent.click(await screen.findByRole("button", { name: "Use photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm this visit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log this visit" }));
    expect(await screen.findByText(/photo did not upload/i)).toBeTruthy();
    await expect(store.load("account:first", place.id).then((value) => value?.file.text())).resolves.toBe("private photo");

    first.unmount();
    render(<ClaimVisitPanel {...handlers} visit={confirmation as Visit} />);
    expect(await screen.findByRole("button", { name: "Retry photo upload" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry photo upload" }));
    await waitFor(() => expect(uploadPhoto).toHaveBeenCalledTimes(2));
    await expect(store.load("account:first", place.id)).resolves.toBeNull();
  });

  it("keeps a previous account's private photo fenced when ownership changes", async () => {
    const store = createBrowserPhotoRetryStore();
    const photo = new File(["private photo"], "visit.jpg", { type: "image/jpeg" });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const handlers = { authenticated: true, place, busy: false, ownerKey: "account:first", recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim: vi.fn().mockResolvedValue(confirmation), uploadPhoto: vi.fn().mockRejectedValue(new Error("offline")), loadPhoto: vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })), removePhoto: vi.fn().mockResolvedValue(undefined) };
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }), photoRetry: store });

    const { rerender } = render(<ClaimVisitPanel {...handlers} />);
    await clickCamera();
    fireEvent.click(await screen.findByRole("button", { name: "Use photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm this visit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log this visit" }));
    await waitFor(() => expect(handlers.createClaim).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handlers.uploadPhoto).toHaveBeenCalledTimes(1));
    await screen.findByText(/photo did not upload/i);

    rerender(<ClaimVisitPanel {...handlers} ownerKey="account:second" />);

    await waitFor(async () => expect(await store.load("account:first", place.id)).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Retry photo upload" })).toBeNull();
    expect(screen.queryByText("Photo ready for Forest Park")).toBeNull();
  });
});
