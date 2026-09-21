// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerNativeCapabilities, type PhotoAsset } from "@/lib/native-capabilities";
import type { PhotoRetryStore } from "@/lib/photo-retry";
import { resetParkSealBoundaryCache } from "./park-seal";
import { VisitPostcard } from "./visit-postcard";

const place = { id: "park-1", name: "Forest Park", category: "provincial" as const, latitude: 49, longitude: -124, region: "South", description: "Forest", sourceUrl: "https://example.test", sourceName: "BC Parks" };
const visit = { placeId: place.id, visitedAt: "2026-09-08T12:00:00Z", claim: { claimedAt: "2026-09-08T12:00:00Z", capturedAt: "2026-09-08T12:00:00Z", coordinates: { latitude: 49, longitude: -124 }, accuracyMeters: 8, boundaryVersion: "v1", matchKind: "exact" as const, distanceMeters: 0, hasPhoto: true } };

let restoreNative: (() => void) | undefined;

afterEach(() => { restoreNative?.(); restoreNative = undefined; cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetParkSealBoundaryCache(); });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
});

function objectUrls() {
  const create = vi.fn(() => "blob:private-photo");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  return { create, revoke };
}

const savedPhoto: PhotoAsset = { file: new File(["saved-local-photo"], "visit.jpg", { type: "image/jpeg" }), mimeType: "image/jpeg", processingState: "prepared" };

function installPhotoRetry(store: PhotoRetryStore) {
  restoreNative = registerNativeCapabilities({
    getCurrentLocation: vi.fn().mockResolvedValue({ latitude: place.latitude, longitude: place.longitude, accuracyMeters: 8, capturedAtEpochMs: Date.now() }),
    getPhoto: vi.fn().mockResolvedValue(null),
    photoRetry: store,
  });
}

it("loads a private photo into a temporary object URL and revokes it", async () => {
  const { create, revoke } = objectUrls();
  const loadPhoto = vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" }));
  const view = render(<VisitPostcard place={place} visit={visit} loadPhoto={loadPhoto} />);
  expect((await screen.findByAltText("Private visit photo from Forest Park")).getAttribute("src")).toBe("blob:private-photo");
  expect(loadPhoto).toHaveBeenCalledWith(place.id);
  expect(create).toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:private-photo"));
});

it("revokes an object URL when the authenticated owner changes", async () => {
  const { revoke } = objectUrls();
  const loadPhoto = vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" }));
  const view = render(<VisitPostcard place={place} visit={visit} loadPhoto={loadPhoto} ownerKey="account:first" />);
  await screen.findByAltText("Private visit photo from Forest Park");
  view.rerender(<VisitPostcard place={place} visit={visit} loadPhoto={loadPhoto} ownerKey="account:second" />);
  await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:private-photo"));
  expect(loadPhoto).toHaveBeenCalledTimes(2);
});

it("offers a real retry after a private photo load fails", async () => {
  objectUrls();
  const loadPhoto = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Blob(["photo"], { type: "image/jpeg" }));
  render(<VisitPostcard place={place} visit={visit} loadPhoto={loadPhoto} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry private photo" }));
  expect(await screen.findByAltText("Private visit photo from Forest Park")).toBeTruthy();
  expect(loadPhoto).toHaveBeenCalledTimes(2);
});

it("confirms before deleting a photo and reflects successful removal", async () => {
  objectUrls();
  const removePhoto = vi.fn().mockResolvedValue(undefined);
  render(<VisitPostcard place={place} visit={visit} loadPhoto={vi.fn().mockResolvedValue(new Blob(["photo"]))} removePhoto={removePhoto} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove photo from Forest Park" }));
  expect(removePhoto).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /^Remove photo$/ }));
  await waitFor(() => expect(removePhoto).toHaveBeenCalledWith(place.id));
  expect(screen.getByText("Visit recorded")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove photo from Forest Park" })).toBeNull();
});

it("keeps the photo and recovery controls when deletion fails", async () => {
  objectUrls();
  const removePhoto = vi.fn().mockRejectedValue(new Error("offline"));
  render(<VisitPostcard place={place} visit={visit} loadPhoto={vi.fn().mockResolvedValue(new Blob(["photo"]))} removePhoto={removePhoto} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove photo from Forest Park" }));
  fireEvent.click(screen.getByRole("button", { name: /^Remove photo$/ }));
  expect(await screen.findByText(/could not be removed/i)).toBeTruthy();
  expect(screen.getByRole("group", { name: "Confirm removal of photo from Forest Park" })).toBeTruthy();
});

it("removes only the owner-scoped device copy after explicit confirmation", async () => {
  objectUrls();
  let copyPresent = true;
  const store: PhotoRetryStore = {
    save: vi.fn(),
    load: vi.fn().mockImplementation(async () => copyPresent ? savedPhoto : null),
    remove: vi.fn().mockImplementation(async (ownerKey, placeId) => {
      expect(ownerKey).toBe("account:first");
      expect(placeId).toBe(place.id);
      copyPresent = false;
    }),
    clearOwner: vi.fn(),
  };
  installPhotoRetry(store);
  const removePhoto = vi.fn().mockResolvedValue(undefined);
  render(<VisitPostcard place={place} visit={visit} loadPhoto={vi.fn().mockResolvedValue(new Blob(["server-photo"]))} removePhoto={removePhoto} ownerKey="account:first" />);
  expect(await screen.findByText("A photo copy is still saved on this device.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove device copy" }));
  expect(screen.getByText(/saved server photo stays unchanged/i)).toBeTruthy();
  expect(store.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove device copy" }));
  await waitFor(() => expect(store.remove).toHaveBeenCalledWith("account:first", place.id));
  expect(removePhoto).not.toHaveBeenCalled();
  expect(screen.queryByText("A photo copy is still saved on this device.")).toBeNull();
});

it("rechecks durable device-copy state after remount", async () => {
  objectUrls();
  let copyPresent = true;
  const store: PhotoRetryStore = {
    save: vi.fn(),
    load: vi.fn().mockImplementation(async () => copyPresent ? savedPhoto : null),
    remove: vi.fn().mockImplementation(async () => { copyPresent = false; }),
    clearOwner: vi.fn(),
  };
  installPhotoRetry(store);
  const props = { place, visit, loadPhoto: vi.fn().mockResolvedValue(new Blob(["server-photo"])), ownerKey: "account:first" };
  const view = render(<VisitPostcard {...props} />);
  expect(await screen.findByText("A photo copy is still saved on this device.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove device copy" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove device copy" }));
  await waitFor(() => expect(store.remove).toHaveBeenCalledTimes(1));
  view.unmount();
  render(<VisitPostcard {...props} />);
  await waitFor(() => expect(store.load).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("A photo copy is still saved on this device.")).toBeNull();
});

it("offers a scoped retry when the device-copy check fails", async () => {
  objectUrls();
  const store: PhotoRetryStore = {
    save: vi.fn(),
    load: vi.fn().mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValueOnce(null),
    remove: vi.fn(),
    clearOwner: vi.fn(),
  };
  installPhotoRetry(store);
  render(<VisitPostcard place={place} visit={visit} loadPhoto={vi.fn().mockResolvedValue(new Blob(["server-photo"]))} ownerKey="account:first" />);
  const retry = await screen.findByRole("button", { name: "Retry device copy check" });
  fireEvent.click(retry);
  await waitFor(() => expect(store.load).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "Retry device copy check" })).toBeNull();
});

it("ignores an old owner removal result after the card changes accounts", async () => {
  objectUrls();
  let resolveRemoval: (() => void) | undefined;
  const store: PhotoRetryStore = {
    save: vi.fn(),
    load: vi.fn().mockImplementation(async (ownerKey) => ownerKey === "account:first" ? savedPhoto : null),
    remove: vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveRemoval = resolve; })),
    clearOwner: vi.fn(),
  };
  installPhotoRetry(store);
  const view = render(<VisitPostcard place={place} visit={visit} loadPhoto={vi.fn().mockResolvedValue(new Blob(["server-photo"]))} ownerKey="account:first" />);
  expect(await screen.findByText("A photo copy is still saved on this device.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove device copy" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove device copy" }));
  await waitFor(() => expect(store.remove).toHaveBeenCalledWith("account:first", place.id));
  view.rerender(<VisitPostcard place={place} visit={visit} loadPhoto={vi.fn().mockResolvedValue(new Blob(["server-photo"]))} ownerKey="account:second" />);
  await waitFor(() => expect(store.load).toHaveBeenCalledWith("account:second", place.id));
  resolveRemoval?.();
  await waitFor(() => expect(screen.queryByText("A photo copy is still saved on this device.")).toBeNull());
  expect(screen.queryByText(/could not be removed/i)).toBeNull();
});

it("keeps collection recovery low-clutter and puts cleanup in the postcard dialog", async () => {
  objectUrls();
  const store: PhotoRetryStore = {
    save: vi.fn(),
    load: vi.fn().mockResolvedValue(savedPhoto),
    remove: vi.fn().mockResolvedValue(undefined),
    clearOwner: vi.fn(),
  };
  installPhotoRetry(store);
  render(<VisitPostcard place={place} visit={visit} compact expandable loadPhoto={vi.fn().mockResolvedValue(new Blob(["server-photo"]))} ownerKey="account:first" />);
  expect(await screen.findByLabelText("A photo copy is still saved on this device")).toBeTruthy();
  expect(screen.queryByText("A photo copy is still saved on this device.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View Forest Park postcard" }));
  expect(screen.getByText("A photo copy is still saved on this device.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove device copy" }));
  expect(screen.getByText(/saved server photo stays unchanged/i)).toBeTruthy();
});

it("opens compact postcards in a detail dialog and keeps place navigation separate", async () => {
  objectUrls();
  const onOpenPlace = vi.fn();
  const removePhoto = vi.fn().mockResolvedValue(undefined);
  render(<VisitPostcard place={place} visit={visit} compact loadPhoto={vi.fn().mockResolvedValue(new Blob(["photo"]))} removePhoto={removePhoto} onOpenPlace={onOpenPlace} />);
  await screen.findByAltText("Private visit photo from Forest Park");
  expect(screen.queryByRole("button", { name: "Remove photo from Forest Park" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View Forest Park postcard" }));
  expect(screen.getByRole("dialog", { name: "Private postcard from Forest Park" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open place" }));
  expect(onOpenPlace).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /^Remove photo$/ }));
  expect(screen.getByRole("group", { name: "Confirm removal of photo from Forest Park" })).toBeTruthy();
});

it("uses the impression markup without pointer or keyboard tilt machinery", () => {
  const noPhoto = { ...visit, claim: { ...visit.claim, hasPhoto: false } };
  render(<VisitPostcard place={place} visit={noPhoto} loadPhoto={vi.fn()} />);
  const postcard = screen.getByRole("article", { name: "Postcard from Forest Park" });
  expect(postcard.className).toContain("impression-postcard");
  expect(postcard.querySelector(".postcard-gloss")).toBeNull();
  expect(postcard.querySelector(".impression-print")).toBeTruthy();
});
