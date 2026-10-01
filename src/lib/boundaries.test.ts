import { describe, expect, it } from "vitest";
import { distanceToBoundaryM, type Boundary } from "./geo";
import { parkContaining } from "./boundaries";
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
  coordinates: [[
    [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]],
    [[0.002, 0.002], [0.008, 0.002], [0.008, 0.008], [0.002, 0.008], [0.002, 0.002]],
  ]],
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
