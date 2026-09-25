import { describe, expect, it } from "vitest";

import {
  boundaryFilter,
  boundaryFeatureStateUpdates,
  geometryBounds,
  parseBoundaryCollection,
  parseBoundaryIndex,
  pickBoundaryPlace,
  selectedBoundaryFilter,
  settleBoundaryLoadStatus,
} from "./boundaries";
import type { Place } from "./places";

describe("boundary geometry", () => {
  it("fits every polygon and hole across a multipart reserve", () => {
    const bounds = geometryBounds({
      type: "MultiPolygon",
      coordinates: [
        [[[-126, 49], [-125, 49], [-125, 50], [-126, 49]], [[-125.8, 49.2], [-125.7, 49.2], [-125.8, 49.2]]],
        [[[-124, 48], [-123, 48], [-123, 48.5], [-124, 48]]],
      ],
    });
    expect(bounds).toEqual([[-126, 48], [-123, 50]]);
  });

  it("rejects points and malformed collections", () => {
    expect(() => parseBoundaryCollection({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { id: "x" } }] })).toThrow();
  });

  it("accepts finite fit bounds and rejects a malformed index", () => {
    expect(parseBoundaryIndex({ version: 1, boundsById: { park: [[-126, 48], [-123, 50]] } }).boundsById.park).toEqual([[-126, 48], [-123, 50]]);
    expect(() => parseBoundaryIndex({ version: 1, boundsById: { park: [[-126, 48], ["east", 50]] } })).toThrow();
  });
});

describe("boundary map filters", () => {
  it("uses stable category filters for the viewport-scoped boundary source", () => {
    expect(boundaryFilter(["park-a"], "park")).toEqual([
      "all",
      ["has", "id"],
      ["!=", ["get", "category"], "island"],
    ]);
    expect(boundaryFilter(["park-a"])).toEqual(["has", "id"]);
    expect(selectedBoundaryFilter("park-b", ["park-a"])).toEqual(["has", "id"]);
    expect(boundaryFilter([])).toBe(boundaryFilter(Array.from({ length: 1_030 }, (_, index) => `park-${index}`)));
  });

  it("keeps the first terminal source result when events arrive out of order", () => {
    expect(settleBoundaryLoadStatus("failed", "ready")).toBe("failed");
    expect(settleBoundaryLoadStatus("ready", "failed")).toBe("ready");
    expect(settleBoundaryLoadStatus("loading", "ready")).toBe("ready");
  });
});

describe("boundary feature state refresh", () => {
  it("clears a deselected and unvisited polygon when it returns after an offscreen wave", () => {
    const polygonId = "regional-returning-park";
    const mapState = new Map<string, { visited: boolean; selected: boolean }>();
    const firstWave = boundaryFeatureStateUpdates(new Set([polygonId]), new Set([polygonId]), new Set([polygonId]));
    firstWave.forEach(({ id, state }) => mapState.set(id, state));
    expect(mapState.get(polygonId)).toEqual({ visited: true, selected: true });

    boundaryFeatureStateUpdates(new Set(), new Set(), new Set()).forEach(({ id, state }) => mapState.set(id, state));
    expect(mapState.get(polygonId)).toEqual({ visited: true, selected: true });

    const returnedWave = boundaryFeatureStateUpdates(new Set([polygonId]), new Set(), new Set());
    returnedWave.forEach(({ id, state }) => mapState.set(id, state));
    expect(mapState.get(polygonId)).toEqual({ visited: false, selected: false });
  });
});

describe("overlapping boundary selection", () => {
  const place = (id: string, category: Place["category"], longitude: number): Place => ({
    id,
    name: id,
    category,
    longitude,
    latitude: 49,
    region: "Test",
    description: "Test",
    sourceUrl: "https://example.com",
    sourceName: "Test",
  });

  it("prefers the closest contained park over a surrounding island", () => {
    const places = [place("island", "island", -125), place("park-far", "regional", -124), place("park-near", "provincial", -125.1)];
    const features = places.map((candidate) => ({ properties: { id: candidate.id } }));
    expect(pickBoundaryPlace(features, places, { lng: -125, lat: 49 })).toBe("park-near");
  });

  it("opens an unsampled park hit by its boundary feature ID", () => {
    const polygon = (west: number, south: number, east: number, north: number) => ({
      type: "Polygon" as const,
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    });
    const features = [
      { properties: { id: "island-unsampled", category: "island" }, geometry: polygon(-125.02, 48.98, -124.98, 49.02) },
      { properties: { id: "park-unsampled", category: "regional" }, geometry: polygon(-125.3, 48.8, -124.7, 49.2) },
    ];

    expect(pickBoundaryPlace(features, [], { lng: -125, lat: 49 })).toBe("park-unsampled");
  });
});
