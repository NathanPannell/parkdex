import { describe, expect, it } from "vitest";

import { buildExplorationCoverage, distanceKm, type ExplorationPoint } from "./exploration-geometry";

const point = (id: string, longitude: number, latitude = 49): ExplorationPoint => ({ id, longitude, latitude });
const polygons = (coverage: ReturnType<typeof buildExplorationCoverage>): GeoJSON.Position[][][] => {
  const geometry = coverage.features[0]?.geometry;
  if (!geometry) return [];
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
};

describe("exploration coverage", () => {
  it("handles zero and one visit with a closed, rounded footprint", () => {
    expect(buildExplorationCoverage([]).features).toEqual([]);
    const coverage = buildExplorationCoverage([point("solo", -124)], { circleSteps: 16 });
    expect(coverage.features).toHaveLength(1);
    expect(coverage.features[0].properties).toEqual({ kind: "estimated-exploration", visitedCount: 1 });
    const outerRing = polygons(coverage)[0][0];
    expect(outerRing[0]).toEqual(outerRing.at(-1));
    expect(outerRing.length).toBeGreaterThanOrEqual(17);
  });

  it("joins two nearby visits into one shape and keeps distant visits disconnected", () => {
    const near = buildExplorationCoverage([point("a", -124), point("b", -123.8)]);
    const far = buildExplorationCoverage([point("a", -125), point("b", -123)]);
    expect(polygons(near)).toHaveLength(1);
    expect(polygons(far)).toHaveLength(2);
  });

  it("honors a caller's strict link limit", () => {
    const places = [point("a", -124), point("b", -123.8)];
    expect(polygons(buildExplorationCoverage(places, { maxLinkKm: 0 }))).toHaveLength(2);
  });

  it("uses one unioned feature without overlapping feature seams", () => {
    const coverage = buildExplorationCoverage(
      [point("a", -124), point("b", -123.9), point("c", -123.8)],
      { maxLinkKm: 50 },
    );
    expect(coverage.features).toHaveLength(1);
    expect(polygons(coverage)).toHaveLength(1);
  });

  it("deduplicates repeated ids and identical coordinates", () => {
    const coverage = buildExplorationCoverage([
      point("same", -124),
      point("same", -123.9),
      point("duplicate-position", -124),
    ]);
    expect(coverage.features[0].properties.visitedCount).toBe(1);
    expect(polygons(coverage)).toHaveLength(1);
  });

  it("cuts a small target gap around an explicit unseen place inside explored coverage", () => {
    const coverage = buildExplorationCoverage(
      [point("west", -124.1), point("east", -123.9)],
      { gapPoints: [point("unseen", -124)], gapRadiusKm: 1 },
    );
    expect(polygons(coverage)[0].length).toBeGreaterThan(1);
  });

  it("rejects invalid coordinates and emits finite, bounded rings", () => {
    const coverage = buildExplorationCoverage([
      point("valid", -124),
      point("invalid", Number.NaN),
      point("polar", 0, 95),
    ], { footprintRadiusKm: 4, circleSteps: 16 });
    expect(coverage.features[0].properties.visitedCount).toBe(1);
    const coordinates = polygons(coverage)[0][0];
    expect(coordinates.flat().every(Number.isFinite)).toBe(true);
    expect(Math.max(...coordinates.map(([longitude]) => Math.abs(longitude + 124)))).toBeLessThan(0.1);
  });

  it("calculates Vancouver Island scale distances", () => {
    expect(distanceKm(point("a", -123.3656, 48.4284), point("b", -123.9401, 49.1659))).toBeCloseTo(92.4, 0);
  });
});
