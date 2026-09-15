// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VisitPostcard } from "./visit-postcard";

const place = { id: "park-1", name: "Forest Park", category: "provincial" as const, latitude: 49, longitude: -124, region: "South", description: "Forest", sourceUrl: "https://example.test", sourceName: "BC Parks" };
const visit = { placeId: place.id, visitedAt: "2026-09-08T12:00:00Z", claim: { claimedAt: "2026-09-08T12:00:00Z", capturedAt: "2026-09-08T12:00:00Z", coordinates: { latitude: 49, longitude: -124 }, accuracyMeters: 8, boundaryVersion: "v1", matchKind: "exact" as const, distanceMeters: 0, hasPhoto: true } };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function objectUrls() {
  const create = vi.fn(() => "blob:private-photo"), revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  return { create, revoke };
}

it("loads a private photo into a temporary object URL and revokes it", async () => {
  const { create, revoke } = objectUrls();
  const loadPhoto = vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" }));
  const view = render(<VisitPostcard place={place} visit={visit} loadPhoto={loadPhoto} />);
  expect((await screen.findByAltText("Private visit photo from Forest Park")).getAttribute("src")).toBe("blob:private-photo");
  expect(loadPhoto).toHaveBeenCalledWith(place.id); expect(create).toHaveBeenCalled();
  view.unmount(); await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:private-photo"));
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

it("lets keyboard users inspect and settle the postcard tilt", () => {
  const noPhoto = { ...visit, claim: { ...visit.claim, hasPhoto: false } };
  render(<VisitPostcard place={place} visit={noPhoto} loadPhoto={vi.fn()} />);
  const postcard = screen.getByRole("article", { name: /Inspect postcard from Forest Park/ });
  fireEvent.keyDown(postcard, { key: "ArrowRight" });
  expect(postcard.style.getPropertyValue("--postcard-y")).toBe("2deg");
  fireEvent.keyDown(postcard, { key: "Escape" });
  expect(postcard.style.getPropertyValue("--postcard-y")).toBe("0deg");
  expect(postcard.querySelector(".postcard-gloss")).toBeTruthy();
});
