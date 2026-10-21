import { describe, expect, it } from "vitest";
import pkolsFeature from "./__fixtures__/pkols-legacy-boundary.v1.json";
import { arrivalPoint, insideBoundary, type Boundary, type LngLat } from "./geo";

function ring(minLng: number, minLat: number, maxLng: number, maxLat: number): LngLat[] {
  return [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ];
}

function boundary(...polygons: LngLat[][][]): Boundary {
  return { type: "MultiPolygon", coordinates: polygons };
}

describe("insideBoundary", () => {
  it("checks every polygon region in a multipolygon", () => {
    const park = boundary([ring(0, 0, 1, 1)], [ring(3, 0, 4, 1)], [ring(6, 0, 7, 1)]);

    expect(insideBoundary([3.5, 0.5], park)).toBe(true);
    expect(insideBoundary([6.5, 0.5], park)).toBe(true);
    expect(insideBoundary([5, 0.5], park)).toBe(false);
  });

  it("excludes hole interiors and hole edges while including outer edges", () => {
    const park = boundary([ring(0, 0, 10, 10), ring(4, 4, 6, 6)]);

    expect(insideBoundary([1, 1], park)).toBe(true);
    expect(insideBoundary([0, 5], park)).toBe(true);
    expect(insideBoundary([5, 5], park)).toBe(false);
    expect(insideBoundary([4, 5], park)).toBe(false);
  });

  it("contains probes inside all three legacy PKOLS regions", () => {
    const park = pkolsFeature.geometry as Boundary;
    const regionProbes: LngLat[] = [
      [-123.34586368054576, 48.49209933274474],
      [-123.33708506650709, 48.49809742468657],
      [-123.33497008635318, 48.492057570854406],
    ];

    expect(park.coordinates).toHaveLength(3);
    for (const probe of regionProbes) expect(insideBoundary(probe, park)).toBe(true);
  });
});

describe("arrivalPoint", () => {
  it("uses the nearest secondary region and returns a point outside its holes", () => {
    const park = boundary([ring(-10, -10, 10, 10)], [ring(20, 0, 24, 4), ring(20.5, 0.5, 23.5, 3.5)]);
    const from: LngLat = [19.99, 2];

    const arrival = arrivalPoint(park, from);

    expect(arrival[0]).toBeGreaterThan(20);
    expect(arrival[0]).toBeLessThan(20.5);
    expect(insideBoundary(arrival, park)).toBe(true);
  });

  it("finds a valid point when the origin is inside the nearest region's hole", () => {
    const park = boundary([ring(-10, -10, 10, 10)], [ring(20, 0, 24, 4), ring(20.5, 0.5, 23.5, 3.5)]);

    const arrival = arrivalPoint(park, [22, 2]);

    expect(insideBoundary(arrival, park)).toBe(true);
    expect(arrival[0]).toBeGreaterThanOrEqual(20);
    expect(arrival[0]).toBeLessThanOrEqual(24);
  });

  it("finds an interior point near a concave notch", () => {
    const concave: LngLat[] = [
      [0, 0],
      [4, 0],
      [4, 1],
      [1, 1],
      [1, 4],
      [0, 4],
      [0, 0],
    ];
    const park = boundary([concave]);

    const arrival = arrivalPoint(park, [2, 2]);

    expect(insideBoundary(arrival, park)).toBe(true);
    const inHorizontalArm = arrival[0] > 1 && arrival[0] < 4 && arrival[1] >= 0 && arrival[1] < 1;
    const inVerticalArm = arrival[0] >= 0 && arrival[0] < 1 && arrival[1] > 1 && arrival[1] < 4;
    expect(inHorizontalArm || inVerticalArm).toBe(true);
  });
});
