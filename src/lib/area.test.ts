import { describe, expect, it } from "vitest";
import { boundaryAreaKm2, formatArea } from "./area";
import type { Boundary, LngLat } from "./geo";

// A square of side `deg` degrees anchored at Victoria's latitude.
function square(lng: number, lat: number, deg: number): LngLat[] {
  return [[lng, lat], [lng + deg, lat], [lng + deg, lat + deg], [lng, lat + deg], [lng, lat]];
}

describe("boundaryAreaKm2", () => {
  it("matches the planar estimate for a small square", () => {
    const boundary: Boundary = { type: "MultiPolygon", coordinates: [[square(-123.4, 48.4, 0.01)]] };
    const expected = 1.111 * (1.111 * Math.cos((48.405 * Math.PI) / 180));
    expect(boundaryAreaKm2(boundary)).toBeCloseTo(expected, 1);
  });

  it("adds every region and removes holes", () => {
    const outer = square(-123.4, 48.4, 0.01);
    const single = boundaryAreaKm2({ type: "MultiPolygon", coordinates: [[outer]] });
    const hole = square(-123.398, 48.402, 0.005);
    const holeArea = boundaryAreaKm2({ type: "MultiPolygon", coordinates: [[hole]] });
    const withHole = boundaryAreaKm2({ type: "MultiPolygon", coordinates: [[outer, hole], [square(-123.3, 48.4, 0.01)]] });
    expect(withHole).toBeCloseTo(2 * single - holeArea, 6);
  });
});

describe("formatArea", () => {
  it("keeps two decimals under one square kilometre", () => {
    expect(formatArea(0.2)).toBe("0.20 km²");
    expect(formatArea(0.042)).toBe("0.04 km²");
    expect(formatArea(0.001)).toBe("0.01 km²");
  });

  it("uses square kilometres from one upward", () => {
    expect(formatArea(3.27)).toBe("3.3 km²");
    expect(formatArea(1234.4)).toBe("1,234 km²");
  });
});
