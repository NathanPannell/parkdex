import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import type { BoundaryFeature } from "./boundaries";
import {
  isPointInBoundary,
  OFFLINE_LOCATION_MAX_AGE_MS,
  validateOfflineLocation,
  type OfflineLocation,
} from "./offline-geometry";

function feature(coordinates: unknown, type: "Polygon" | "MultiPolygon" = "Polygon"): BoundaryFeature {
  return {
    type: "Feature",
    properties: {
      id: "park",
      name: "Park",
      category: "provincial",
      sourceName: "Source",
      sourceUrl: "https://example.test",
      sourceId: null,
    },
    geometry: { type, coordinates } as BoundaryFeature["geometry"],
  };
}

const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
const parkWithHole = feature([outer, hole]);

function location(overrides: Partial<OfflineLocation> = {}): OfflineLocation {
  return {
    longitude: 1,
    latitude: 1,
    accuracy: 25,
    timestamp: 1_000,
    ...overrides,
  };
}

describe("isPointInBoundary", () => {
  it("checks the original polygon and excludes its hole", () => {
    expect(isPointInBoundary({ longitude: 1, latitude: 1 }, parkWithHole)).toBe(true);
    expect(isPointInBoundary({ longitude: 3, latitude: 3 }, parkWithHole)).toBe(false);
    expect(isPointInBoundary({ longitude: 11, latitude: 1 }, parkWithHole)).toBe(false);
  });

  it("includes exterior edges and excludes a hole's interior and edge", () => {
    expect(isPointInBoundary({ longitude: 0, latitude: 5 }, parkWithHole)).toBe(true);
    expect(isPointInBoundary({ longitude: 2, latitude: 3 }, parkWithHole)).toBe(false);
    expect(isPointInBoundary({ longitude: 4, latitude: 4 }, parkWithHole)).toBe(false);
    expect(isPointInBoundary({ longitude: 3, latitude: 3 }, parkWithHole)).toBe(false);
  });

  it("accepts a hole touching the exterior at one point", () => {
    const touchingHole = feature([outer, [[0, 5], [2, 4], [2, 6], [0, 5]]]);
    expect(isPointInBoundary({ longitude: 1, latitude: 5 }, touchingHole)).toBe(false);
    expect(isPointInBoundary({ longitude: 5, latitude: 5 }, touchingHole)).toBe(true);
    expect(isPointInBoundary({ longitude: 0, latitude: 5 }, touchingHole)).toBe(false);
  });

  it("checks each polygon part in a MultiPolygon", () => {
    const second = [[20, 20], [22, 20], [22, 22], [20, 22], [20, 20]];
    const multi = feature([[outer], [second]], "MultiPolygon");
    expect(isPointInBoundary({ longitude: 1, latitude: 1 }, multi)).toBe(true);
    expect(isPointInBoundary({ longitude: 21, latitude: 21 }, multi)).toBe(true);
    expect(isPointInBoundary({ longitude: 15, latitude: 15 }, multi)).toBe(false);
  });

  it("keeps exact geometry when source rings contain repeated consecutive vertices", () => {
    const repeated = feature([[[0, 0], [10, 0], [10, 10], [10, 10], [0, 10], [0, 0]]]);
    expect(isPointInBoundary({ longitude: 5, latitude: 5 }, repeated)).toBe(true);
    expect(isPointInBoundary({ longitude: 11, latitude: 5 }, repeated)).toBe(false);
  });

  it("fails closed for open and self-intersecting rings", () => {
    const open = feature([outer.slice(0, -1)]);
    const bowTie = feature([[[0, 0], [10, 10], [0, 10], [10, 0], [0, 0]]]);
    expect(isPointInBoundary({ longitude: 1, latitude: 1 }, open)).toBe(false);
    expect(isPointInBoundary({ longitude: 1, latitude: 1 }, bowTie)).toBe(false);
    expect(validateOfflineLocation(location(), open, 1_000)).toEqual({ status: "invalid-boundary" });
  });

  it("fails closed for invalid coordinates and absent boundaries", () => {
    const invalid = feature([[[0, 0], [Number.NaN, 1], [1, 2], [0, 0]]]);
    expect(isPointInBoundary({ longitude: 1, latitude: 1 }, invalid)).toBe(false);
    expect(isPointInBoundary({ longitude: 1, latitude: 1 }, null)).toBe(false);
    expect(isPointInBoundary({ longitude: 181, latitude: 1 }, parkWithHole)).toBe(false);
  });

  it("checks a large real canonical park ring without simplifying it", () => {
    const catalogue = JSON.parse(readFileSync(new URL("../../data/boundaries.geojson", import.meta.url), "utf8")) as {
      features: BoundaryFeature[];
    };
    const park = catalogue.features.find((entry) => entry.properties.id === "national-gwaii-haanas-national-park-reserve");
    expect(park).toBeDefined();
    const firstPosition = park!.geometry.type === "Polygon"
      ? park!.geometry.coordinates[0][0]
      : park!.geometry.coordinates[0][0][0];
    expect(isPointInBoundary({ longitude: firstPosition[0], latitude: firstPosition[1] }, park!)).toBe(true);
    expect(isPointInBoundary({ longitude: -100, latitude: 20 }, park!)).toBe(false);
  });
});

describe("validateOfflineLocation", () => {
  it("accepts a fresh accurate point only after exact containment", () => {
    expect(validateOfflineLocation(location({ timestamp: 10_000 }), parkWithHole, 10_000)).toEqual({ status: "inside" });
    expect(validateOfflineLocation(location({ longitude: 3, latitude: 3, timestamp: 10_000 }), parkWithHole, 10_000)).toEqual({ status: "outside" });
  });

  it("rejects stale and future fixes", () => {
    expect(validateOfflineLocation(location({ timestamp: 10_000 - OFFLINE_LOCATION_MAX_AGE_MS - 1 }), parkWithHole, 10_000)).toEqual({ status: "stale" });
    expect(validateOfflineLocation(location({ timestamp: 10_001 }), parkWithHole, 10_000)).toEqual({ status: "stale" });
  });

  it("rejects GPS accuracy above 50 metres and malformed fixes", () => {
    expect(validateOfflineLocation(location({ accuracy: 50.01 }), parkWithHole, 1_000)).toEqual({ status: "inaccurate" });
    expect(validateOfflineLocation(location({ accuracy: 0 }), parkWithHole, 1_000)).toEqual({ status: "invalid-location" });
    expect(validateOfflineLocation(location({ latitude: 91 }), parkWithHole, 1_000)).toEqual({ status: "invalid-location" });
  });

  it("distinguishes missing and malformed boundaries", () => {
    expect(validateOfflineLocation(location(), null, 1_000)).toEqual({ status: "missing-boundary" });
    expect(validateOfflineLocation(location(), feature([outer.slice(1)]), 1_000)).toEqual({ status: "invalid-boundary" });
  });
});
