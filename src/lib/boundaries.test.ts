import { describe, expect, it } from "vitest";
import { distanceToBoundaryM, type Boundary } from "./geo";
import { insidePark, parkContaining } from "./boundaries";
import type { Park } from "./parks";

const park: Park = {
  id: "test-park",
  name: "Test Park",
  short: "Test",
  category: "municipal",
  region: "Test Region",
  lat: 0.005,
  lng: 0.005,
  biome: "forest",
  shape: "circle",
  rarity: "common",
  seed: 1,
  blurb: "",
  scene: "test-park",
};

const boundary: Boundary = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [0, 0],
        [0.01, 0],
        [0.01, 0.01],
        [0, 0.01],
        [0, 0],
      ],
      [
        [0.002, 0.002],
        [0.008, 0.002],
        [0.008, 0.008],
        [0.002, 0.008],
        [0.002, 0.002],
      ],
    ],
  ],
};

describe("parkContaining with multipolygon holes", () => {
  it("keeps the outer edge inside and allows the configured GPS tolerance just outside it", () => {
    const byId = new Map([[park.id, boundary]]);

    expect(parkContaining([0, 0.005], [park], byId)).toBe(park);
    expect(parkContaining([-0.00005, 0.005], [park], byId, 10)).toBe(park);
  });

  it("measures hole edges and does not let the GPS tolerance cover a deep hole", () => {
    const byId = new Map([[park.id, boundary]]);
    const holeCenter = [0.005, 0.005] as [number, number];

    expect(distanceToBoundaryM(holeCenter, boundary)).toBeGreaterThan(300);
    expect(distanceToBoundaryM(holeCenter, boundary)).toBeLessThan(400);
    expect(parkContaining(holeCenter, [park], byId, 35)).toBeNull();
    expect(parkContaining([0.00205, 0.005], [park], byId, 35)).toBe(park);
  });
});

describe("insidePark", () => {
  it("checks one park with the visit tolerance, capped at 35 m", () => {
    expect(insidePark([0.001, 0.001], boundary)).toBe(true);
    // About 5.5 m west of the edge.
    expect(insidePark([-0.00005, 0.005], boundary)).toBe(false);
    expect(insidePark([-0.00005, 0.005], boundary, 10)).toBe(true);
    // About 44 m outside: even a poor fix does not stretch past 35 m.
    expect(insidePark([-0.0004, 0.005], boundary, 80)).toBe(false);
    expect(insidePark([0.005, 0.005], boundary, 35)).toBe(false);
    expect(insidePark([0.001, 0.001], undefined, 35)).toBe(false);
  });
});
