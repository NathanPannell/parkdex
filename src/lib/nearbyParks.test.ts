import { describe, expect, it } from "vitest";
import type { LngLat } from "./geo";
import { NEARBY_LIST_KM, NEARBY_LIST_SIZE, nearestParks } from "./nearbyParks";

// Victoria, and parks placed due north of it: 0.01 degrees of latitude is about 1.11 km.
const HERE: LngLat = [-123.3656, 48.4284];
const north = (id: string, km: number) => ({ id, lng: HERE[0], lat: HERE[1] + km / 111.195 });

describe("nearestParks", () => {
  it("caps the nearby list at 15 km", () => {
    expect(NEARBY_LIST_KM).toBe(15);
    const parks = [north("far", 40), north("edge-out", 15.2), north("near", 2), north("edge-in", 14.8)];
    const nearby = nearestParks(parks, HERE, { limit: NEARBY_LIST_SIZE, maxKm: NEARBY_LIST_KM });
    expect(nearby.map(({ p }) => p.id)).toEqual(["near", "edge-in"]);
    expect(nearby[1].km).toBeCloseTo(14.8, 1);
  });

  it("keeps the nearest parks first and stops at the limit", () => {
    const parks = Array.from({ length: 12 }, (_, i) => north(`p${11 - i}`, 11 - i));
    const nearby = nearestParks(parks, HERE, { limit: NEARBY_LIST_SIZE, maxKm: NEARBY_LIST_KM });
    expect(nearby.map(({ p }) => p.id)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
  });

  it("returns an empty list when no park is within the cap", () => {
    expect(nearestParks([north("far", 40)], HERE, { limit: NEARBY_LIST_SIZE, maxKm: NEARBY_LIST_KM })).toEqual([]);
  });

  it("has no distance cap unless one is given", () => {
    expect(nearestParks([north("far", 400), north("farther", 900)], HERE, { limit: 1 }).map(({ p }) => p.id)).toEqual(["far"]);
  });
});
