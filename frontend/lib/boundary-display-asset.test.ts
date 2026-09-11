import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import booleanValid from "@turf/boolean-valid";
import { describe, expect, it } from "vitest";

import { geometryBounds, parseBoundaryCollection } from "./boundaries";

const publicDirectory = resolve(process.cwd(), "public/data");
const displayText = readFileSync(resolve(publicDirectory, "boundaries-display.v1.geojson"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(publicDirectory, "boundaries-display.v1.manifest.json"), "utf8"));
const display = parseBoundaryCollection(JSON.parse(displayText));
const canonical = parseBoundaryCollection(JSON.parse(readFileSync(resolve(publicDirectory, "boundaries.v1.geojson"), "utf8")));
const canonicalInputText = readFileSync(resolve(process.cwd(), "../data/boundaries.geojson"), "utf8");
const coordinateCache = new WeakMap<object, GeoJSON.Position[][][]>();
const sampleCache = new WeakMap<object, GeoJSON.Position[]>();
const DISPLAY_PRECISION_EPSILON = 1e-6;

function polygonParts(feature: (typeof display.features)[number]) {
  if (feature.geometry.type === "Polygon") return [feature];
  return feature.geometry.coordinates.map((coordinates) => ({
    type: "Feature" as const,
    properties: feature.properties,
    geometry: { type: "Polygon" as const, coordinates },
  }));
}

function polygonCoordinates(feature: (typeof display.features)[number]) {
  const cached = coordinateCache.get(feature);
  if (cached) return cached;
  const round = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      return [Number(value[0].toFixed(6)), Number(value[1].toFixed(6))];
    }
    return value.map((child) => round(child));
  };
  const coordinates = round(feature.geometry.coordinates) as GeoJSON.Position[][][];
  const result = feature.geometry.type === "Polygon" ? [coordinates] : coordinates;
  coordinateCache.set(feature, result as GeoJSON.Position[][][]);
  return result as GeoJSON.Position[][][];
}

function featureBounds(feature: (typeof display.features)[number]) {
  const coordinates = polygonCoordinates(feature).flat(2);
  return [
    Math.min(...coordinates.map(([longitude]) => longitude)),
    Math.min(...coordinates.map(([, latitude]) => latitude)),
    Math.max(...coordinates.map(([longitude]) => longitude)),
    Math.max(...coordinates.map(([, latitude]) => latitude)),
  ] as const;
}

function exteriorRings(feature: (typeof display.features)[number]) {
  return polygonCoordinates(feature).map((polygon) => polygon[0]);
}

function pointOnSegment(point: GeoJSON.Position, start: GeoJSON.Position, end: GeoJSON.Position) {
  const [px, py] = point;
  const [sx, sy] = start;
  const [ex, ey] = end;
  const cross = (px - sx) * (ey - sy) - (py - sy) * (ex - sx);
  if (Math.abs(cross) > DISPLAY_PRECISION_EPSILON) return false;
  return px >= Math.min(sx, ex) - DISPLAY_PRECISION_EPSILON && px <= Math.max(sx, ex) + DISPLAY_PRECISION_EPSILON
    && py >= Math.min(sy, ey) - DISPLAY_PRECISION_EPSILON && py <= Math.max(sy, ey) + DISPLAY_PRECISION_EPSILON;
}

function pointInRing(point: GeoJSON.Position, ring: GeoJSON.Position[], strict = false) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
    const currentPoint = ring[current];
    const previousPoint = ring[previous];
    if (pointOnSegment(point, previousPoint, currentPoint)) return !strict;
    if ((currentPoint[1] > point[1]) !== (previousPoint[1] > point[1])
      && point[0] < (previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])
        / (previousPoint[1] - currentPoint[1]) + currentPoint[0]) inside = !inside;
  }
  return inside;
}

function pointInFeature(point: GeoJSON.Position, feature: (typeof display.features)[number], strict = false) {
  return polygonCoordinates(feature).some((polygon) => (
    pointInRing(point, polygon[0], strict) && !polygon.slice(1).some((hole) => pointInRing(point, hole, false))
  ));
}

function sampledExteriorPoints(feature: (typeof display.features)[number]) {
  const cached = sampleCache.get(feature);
  if (cached) return cached;
  const result = exteriorRings(feature).flatMap((ring) => ring.flatMap((point, index) => {
    const next = ring[(index + 1) % ring.length];
    return [
      point,
      [point[0] * 0.75 + next[0] * 0.25, point[1] * 0.75 + next[1] * 0.25],
      [point[0] * 0.5 + next[0] * 0.5, point[1] * 0.5 + next[1] * 0.5],
      [point[0] * 0.25 + next[0] * 0.75, point[1] * 0.25 + next[1] * 0.75],
    ];
  }));
  sampleCache.set(feature, result);
  return result;
}

function hasPositiveOverlap(first: (typeof display.features)[number], second: (typeof display.features)[number]) {
  // Every vertex and quarter-point of each display perimeter must stay out
  // of the other filled polygon. With the canonical source's non-overlapping
  // topology, this catches both containment and crossed perimeters without
  // making the test depend on a heavyweight boolean operation for every pair.
  return sampledExteriorPoints(first).some((point) => pointInFeature(point, second, true))
    || sampledExteriorPoints(second).some((point) => pointInFeature(point, first, true));
}

describe("softened boundary display asset", () => {
  it("matches the reproducible checksum manifest and canonical feature ids", () => {
    expect(createHash("sha256").update(displayText).digest("hex")).toBe(manifest.outputSha256);
    expect(createHash("sha256").update(canonicalInputText.replace(/\r\n/g, "\n")).digest("hex")).toBe(manifest.inputSha256);
    expect(display.features).toHaveLength(manifest.featureCount);
    expect(display.features.map((feature) => feature.properties.id).sort())
      .toEqual(canonical.features.map((feature) => feature.properties.id).sort());
  });

  it("normalizes canonical line endings before hashing for Windows and CI parity", () => {
    const normalized = canonicalInputText.replace(/\r\n/g, "\n");
    const simulatedWindowsCheckout = normalized.replace(/\n/g, "\r\n");
    expect(createHash("sha256").update(simulatedWindowsCheckout.replace(/\r\n/g, "\n")).digest("hex"))
      .toBe(createHash("sha256").update(normalized).digest("hex"));
  });

  it("has valid topology in every polygon part", () => {
    const invalidIds = display.features
      .filter((feature) => !polygonParts(feature).every((part) => booleanValid(part)))
      .map((feature) => feature.properties.id);
    expect(invalidIds).toEqual([]);
  });

  it("keeps representative park extents within the canonical boundary while retaining rounded geometry", () => {
    const canonicalFeature = canonical.features.find((feature) => feature.properties.id === "provincial-strathcona-park");
    const displayFeature = display.features.find((feature) => feature.properties.id === "provincial-strathcona-park");
    expect(canonicalFeature).toBeDefined();
    expect(displayFeature).toBeDefined();
    const canonicalBounds = geometryBounds(canonicalFeature!.geometry)!;
    const displayBounds = geometryBounds(displayFeature!.geometry)!;
    expect(displayBounds[0][0]).toBeGreaterThanOrEqual(canonicalBounds[0][0]);
    expect(displayBounds[0][1]).toBeGreaterThanOrEqual(canonicalBounds[0][1]);
    expect(displayBounds[1][0]).toBeLessThanOrEqual(canonicalBounds[1][0]);
    expect(displayBounds[1][1]).toBeLessThanOrEqual(canonicalBounds[1][1]);
    expect(["Polygon", "MultiPolygon"]).toContain(displayFeature!.geometry.type);
  });

  it("retains the expanded display treatment for island context", () => {
    const canonicalFeature = canonical.features.find((feature) => feature.properties.id === "island-cormorant-island");
    const displayFeature = display.features.find((feature) => feature.properties.id === "island-cormorant-island");
    expect(canonicalFeature).toBeDefined();
    expect(displayFeature).toBeDefined();
    const canonicalBounds = geometryBounds(canonicalFeature!.geometry)!;
    const displayBounds = geometryBounds(displayFeature!.geometry)!;
    expect(displayBounds[0][0]).toBeLessThan(canonicalBounds[0][0]);
    expect(displayBounds[0][1]).toBeLessThan(canonicalBounds[0][1]);
    expect(displayBounds[1][0]).toBeGreaterThan(canonicalBounds[1][0]);
    expect(displayBounds[1][1]).toBeGreaterThan(canonicalBounds[1][1]);
  });

  it("contains every park display and introduces no neighbouring park overlap", () => {
    const parks = canonical.features.filter((feature) => feature.properties.category !== "island");
    const spills: string[] = [];
    const overlaps: string[] = [];

    parks.forEach((canonicalFeature, index) => {
      const displayFeature = display.features.find((feature) => feature.properties.id === canonicalFeature.properties.id)!;
      if (sampledExteriorPoints(displayFeature).some((point) => !pointInFeature(point, canonicalFeature))) {
        spills.push(canonicalFeature.properties.id);
      }

      const canonicalBounds = featureBounds(canonicalFeature);
      for (const other of parks.slice(index + 1)) {
        const otherBounds = featureBounds(other);
        if (canonicalBounds[2] < otherBounds[0] || otherBounds[2] < canonicalBounds[0]
          || canonicalBounds[3] < otherBounds[1] || otherBounds[3] < canonicalBounds[1]) continue;
        const otherDisplay = display.features.find((feature) => feature.properties.id === other.properties.id)!;
        // Some source polygons intentionally overlap. The display pass must
        // never introduce an overlap where canonical polygons are separate.
        if (!hasPositiveOverlap(canonicalFeature, other) && hasPositiveOverlap(displayFeature, otherDisplay)) {
          overlaps.push(`${canonicalFeature.properties.id}|${other.properties.id}`);
        }
      }
    });

    expect(spills).toEqual([]);
    expect(overlaps).toEqual([]);
  }, 20_000);
});
