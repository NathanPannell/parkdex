import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import booleanValid from "@turf/boolean-valid";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
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
const boundsCache = new WeakMap<object, readonly [number, number, number, number]>();
const polygonBoundsCache = new WeakMap<object, readonly (readonly [number, number, number, number])[]>();
const DISPLAY_PRECISION_EPSILON = 1e-6;
const DISPLAY_TOLERANCE_METERS = 0.25;

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
  const cached = boundsCache.get(feature);
  if (cached) return cached;
  const coordinates = polygonCoordinates(feature).flat(2);
  const bounds = [
    Math.min(...coordinates.map(([longitude]) => longitude)),
    Math.min(...coordinates.map(([, latitude]) => latitude)),
    Math.max(...coordinates.map(([longitude]) => longitude)),
    Math.max(...coordinates.map(([, latitude]) => latitude)),
  ] as const;
  boundsCache.set(feature, bounds);
  return bounds;
}

function polygonBounds(feature: (typeof display.features)[number]) {
  const cached = polygonBoundsCache.get(feature);
  if (cached) return cached;
  const bounds = polygonCoordinates(feature).map((polygon) => {
    const coordinates = polygon.flat();
    return [
      Math.min(...coordinates.map(([longitude]) => longitude)),
      Math.min(...coordinates.map(([, latitude]) => latitude)),
      Math.max(...coordinates.map(([longitude]) => longitude)),
      Math.max(...coordinates.map(([, latitude]) => latitude)),
    ] as const;
  });
  polygonBoundsCache.set(feature, bounds);
  return bounds;
}

function insideBounds(point: GeoJSON.Position, bounds: readonly [number, number, number, number]) {
  return point[0] >= bounds[0] && point[0] <= bounds[2]
    && point[1] >= bounds[1] && point[1] <= bounds[3];
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
  if (!insideBounds(point, featureBounds(feature))) return false;
  const bounds = polygonBounds(feature);
  return polygonCoordinates(feature).some((polygon, index) => insideBounds(point, bounds[index]) && (
    pointInRing(point, polygon[0], strict) && !polygon.slice(1).some((hole) => pointInRing(point, hole, false))
  ));
}

function pointNearBoundary(point: GeoJSON.Position, feature: (typeof display.features)[number]) {
  const longitudeScale = 111_320 * Math.cos(point[1] * Math.PI / 180);
  const latitudeScale = 111_320;
  return polygonCoordinates(feature).some((polygon) => polygon.some((ring) => ring.some((start, index) => {
    const end = ring[(index + 1) % ring.length];
    const x = (point[0] - start[0]) * longitudeScale;
    const y = (point[1] - start[1]) * latitudeScale;
    const dx = (end[0] - start[0]) * longitudeScale;
    const dy = (end[1] - start[1]) * latitudeScale;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared ? Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared)) : 0;
    return Math.hypot(x - fraction * dx, y - fraction * dy) <= DISPLAY_TOLERANCE_METERS;
  })));
}

function sampledExteriorPoints(feature: (typeof display.features)[number]) {
  const cached = sampleCache.get(feature);
  if (cached) return cached;
  // BC has more than a thousand outlines, including very detailed alpine
  // parks. Sample evenly across each feature's perimeter with a fixed cap so
  // this test stays bounded while still covering every polygon component.
  const rings = exteriorRings(feature);
  const totalVertices = rings.reduce((count, ring) => count + ring.length, 0);
  const stride = Math.max(1, Math.ceil(totalVertices / 32));
  const result = rings.flatMap((ring) => ring.flatMap((point, index) => {
    if (index % stride !== 0) return [];
    const next = ring[(index + 1) % ring.length];
    return [point, [(point[0] + next[0]) / 2, (point[1] + next[1]) / 2]];
  }));
  sampleCache.set(feature, result);
  return result;
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
  }, 30_000);

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

  it("contains every park display within the canonical boundary", () => {
    const parks = canonical.features.filter((feature) => feature.properties.category !== "island");
    const displayById = new Map(display.features.map((feature) => [feature.properties.id, feature]));
    const spills: string[] = [];

    parks.forEach((canonicalFeature) => {
      const displayFeature = displayById.get(canonicalFeature.properties.id)!;
      if (sampledExteriorPoints(displayFeature).some((point) => (
        !pointInFeature(point, canonicalFeature)
        && !booleanPointInPolygon(point, canonicalFeature)
        && !pointNearBoundary(point, canonicalFeature)
      ))) {
        spills.push(canonicalFeature.properties.id);
      }
    });

    // The generator intersects each park display with its canonical polygon.
    // This sample checks that final coordinate rounding adds no visible spill;
    // the same construction prevents new overlap between separate parks.
    expect(spills).toEqual([]);
  }, 30_000);
});
