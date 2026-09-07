import { describe, expect, it } from "vitest";

import {
  boundaryFilter,
  geometryBounds,
  parseBoundaryCollection,
  parseBoundaryIndex,
  pickBoundaryPlace,
  selectedBoundaryFilter,
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
  it("keeps boundaries in lockstep with visible place ids", () => {
    expect(boundaryFilter(["park-a"], "park")).toEqual([
      "all",
      ["in", ["get", "id"], ["literal", ["park-a"]]],
      ["!=", ["get", "category"], "island"],
    ]);
    expect(selectedBoundaryFilter("park-b", ["park-a"])).toEqual(["==", ["get", "id"], ""]);
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
});
