// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BoundaryCollection } from "@/lib/boundaries";
import { boundaryGeometryToPath, boundaryPathForPlace, ParkSeal, resetParkSealBoundaryCache } from "./park-seal";

const place = { id: "park-1", name: "Forest Park", category: "provincial" as const, latitude: 49, longitude: -124, region: "South", description: "Forest", sourceUrl: "https://example.test", sourceName: "BC Parks" };

const boundaries: BoundaryCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { id: place.id, name: place.name, category: place.category, sourceName: place.sourceName, sourceUrl: place.sourceUrl, sourceId: null },
    geometry: { type: "Polygon", coordinates: [[[-124, 49], [-123.99, 49], [-123.99, 49.01], [-124, 49.01], [-124, 49]]] },
  }],
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetParkSealBoundaryCache(); });

it("projects a real polygon boundary into a seal path", () => {
  const path = boundaryGeometryToPath(boundaries.features[0].geometry);
  expect(path).toMatch(/^M/);
  expect(path).toContain("Z");
  expect(boundaryPathForPlace(boundaries, place.id)).toBe(path);
});

it("loads the matching park geometry dynamically and caches the boundary request", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => boundaries });
  vi.stubGlobal("fetch", fetchMock);
  render(<><ParkSeal place={place} sealed visitedAt="2026-09-08T12:00:00Z" /><ParkSeal place={place} sealed /></>);
  await waitFor(() => expect(screen.getAllByRole("img", { name: "Forest Park park boundary seal" })).toHaveLength(2));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("img", { name: "Forest Park park boundary seal" })).toHaveLength(2);
  expect(document.querySelectorAll(".impression-seal-geometry path")).toHaveLength(2);
});

it("uses a generic park icon when boundary data is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  render(<ParkSeal place={place} />);
  await waitFor(() => expect(screen.getByRole("img", { name: "Forest Park park seal icon" })).toBeTruthy());
  const seal = screen.getByRole("img", { name: "Forest Park park seal icon" });
  expect(seal.getAttribute("data-boundary-state")).toBe("fallback");
  expect(seal.querySelector(".impression-seal-fallback")).toBeTruthy();
  expect(seal.querySelector(".impression-seal-geometry")).toBeNull();
});
