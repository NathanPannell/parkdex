// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetParkSealBoundaryCache } from "./park-seal";
import { PostcardCollection } from "./postcard-collection";

const place = (id: string, name = id) => ({ id, name, category: "provincial" as const, latitude: 49, longitude: -124, region: "South", description: "Forest", sourceUrl: "https://example.test", sourceName: "BC Parks" });
const claim = (placeId: string, visitedAt: string) => ({ placeId, visitedAt, claim: { claimedAt: visitedAt, capturedAt: visitedAt, coordinates: { latitude: 49, longitude: -124 }, accuracyMeters: 8, boundaryVersion: "v1", matchKind: "exact" as const, distanceMeters: 0, hasPhoto: true } });

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetParkSealBoundaryCache(); });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
});

it("renders a useful empty state when there are no claimed visits", () => {
  render(<PostcardCollection places={[]} visits={{}} loadPhoto={vi.fn()} />);
  expect(screen.getByText("Log a visit")).toBeTruthy();
  expect(screen.getByText("Confirm a visit while you’re there to start your postcards.")).toBeTruthy();
  expect(screen.getByLabelText("0 postcards")).toBeTruthy();
});

it("renders one claimed park as the latest postcard", () => {
  const onlyPlace = place("park-1", "Forest Park");
  render(<PostcardCollection places={[onlyPlace]} visits={{ [onlyPlace.id]: claim(onlyPlace.id, "2026-09-08T12:00:00Z") }} loadPhoto={vi.fn().mockResolvedValue(new Blob(["photo"]))} />);
  expect(screen.getByRole("heading", { name: "Postcards" })).toBeTruthy();
  expect(screen.getAllByRole("article", { name: "Postcard from Forest Park" })).toHaveLength(1);
  expect(document.querySelector(".impression-collection-grid")).toBeNull();
  expect(document.querySelector(".postcard-shelf__track")).toBeTruthy();
});

it("orders newest first, keeps one postcard per place, and loads more in batches", () => {
  const places = Array.from({ length: 13 }, (_, index) => place(`park-${index}`, `Park ${index}`));
  const visits = Object.fromEntries(places.map((current, index) => [current.id, claim(current.id, `2026-09-${String(21 - index).padStart(2, "0")}T12:00:00Z`)]));
  const duplicateOlder = claim("park-0", "2026-01-01T12:00:00Z");
  const loadPhoto = vi.fn().mockResolvedValue(new Blob(["photo"]));
  render(<PostcardCollection places={[...places, places[0]]} visits={[...Object.values(visits), duplicateOlder]} loadPhoto={loadPhoto} />);
  const firstBatch = screen.getAllByRole("article");
  expect(firstBatch).toHaveLength(12);
  expect(firstBatch[0].getAttribute("data-place-id")).toBe("park-0");
  expect(new Set(firstBatch.map((article) => article.getAttribute("data-place-id"))).size).toBe(12);
  expect(loadPhoto).toHaveBeenCalledTimes(12);
  fireEvent.click(screen.getByRole("button", { name: "Load more postcards" }));
  expect(screen.getAllByRole("article")).toHaveLength(13);
  expect(screen.getAllByRole("article")[12].getAttribute("data-place-id")).toBe("park-12");
});

it("expands the swipeable shelf into a keyboard reachable postcard list", () => {
  const places = [place("park-1", "Forest Park"), place("park-2", "Cedar Park")];
  const visits = Object.fromEntries(places.map((current, index) => [current.id, claim(current.id, `2026-09-${String(8 - index).padStart(2, "0")}T12:00:00Z`)]));
  render(<PostcardCollection places={places} visits={visits} loadPhoto={vi.fn().mockResolvedValue(new Blob(["photo"]))} />);

  const toggle = screen.getByRole("button", { name: "View all postcards" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(screen.getByRole("list", { name: "All postcards" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Back to shelf" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Back to shelf" }));
  expect(screen.getByRole("group", { name: "Swipe through your postcards" })).toBeTruthy();
});

it("rotates a postcard from touch and keyboard controls, then resets it", () => {
  const onlyPlace = place("park-1", "Forest Park");
  render(<PostcardCollection places={[onlyPlace]} visits={{ [onlyPlace.id]: claim(onlyPlace.id, "2026-09-08T12:00:00Z") }} loadPhoto={vi.fn().mockResolvedValue(new Blob(["photo"]))} />);
  const rotationState = document.querySelector(".postcard-shelf__rotation-state") as HTMLElement;
  const rotate = screen.getByRole("button", { name: "Rotate Forest Park postcard" });

  fireEvent.pointerDown(rotate, { pointerType: "touch" });
  fireEvent.pointerUp(rotate, { pointerType: "touch" });
  fireEvent.click(rotate);
  expect(rotate.getAttribute("aria-pressed")).toBe("true");
  expect(rotationState.style.getPropertyValue("--postcard-rotation-x")).toBe("-4deg");
  expect(rotationState.style.getPropertyValue("--postcard-rotation-y")).toBe("6deg");

  const reset = screen.getByRole("button", { name: "Reset Forest Park postcard rotation" });
  fireEvent.keyDown(reset, { key: "Enter" });
  expect(screen.getByRole("button", { name: "Rotate Forest Park postcard" }).getAttribute("aria-pressed")).toBe("false");
  expect(rotationState.style.getPropertyValue("--postcard-rotation-x")).toBe("0deg");
});

it("disables postcard rotation and pointer tilt when reduced motion is requested", async () => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const onlyPlace = place("park-1", "Forest Park");
  render(<PostcardCollection places={[onlyPlace]} visits={{ [onlyPlace.id]: claim(onlyPlace.id, "2026-09-08T12:00:00Z") }} loadPhoto={vi.fn().mockResolvedValue(new Blob(["photo"]))} />);
  const rotate = screen.getByRole("button", { name: "Rotate Forest Park postcard" }) as HTMLButtonElement;
  await waitFor(() => expect(rotate.disabled).toBe(true));

  const card = document.querySelector(".postcard-shelf__card") as HTMLElement;
  fireEvent.pointerMove(card, { pointerType: "mouse", clientX: 80, clientY: 40 });
  const rotationState = document.querySelector(".postcard-shelf__rotation-state") as HTMLElement;
  expect(rotationState.style.getPropertyValue("--postcard-rotation-x")).toBe("0deg");
  expect(rotationState.style.getPropertyValue("--postcard-rotation-y")).toBe("0deg");
});
