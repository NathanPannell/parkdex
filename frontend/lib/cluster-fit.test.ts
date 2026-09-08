import { describe, expect, it, vi } from "vitest";

import { clusterFitForLeaves, fetchClusterLeaves } from "./cluster-fit";

const point = (longitude: number, latitude: number): GeoJSON.Feature<GeoJSON.Point> => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [longitude, latitude] },
});

describe("cluster camera fitting", () => {
  it("loads every leaf in bounded pages before fitting", async () => {
    const leaves = Array.from({ length: 205 }, (_, index) => point(-128 + index / 100, 48 + index / 200));
    const getClusterLeaves = vi.fn(async (_clusterId: number, limit: number, offset: number) => leaves.slice(offset, offset + limit));

    const loaded = await fetchClusterLeaves({ getClusterLeaves }, 42, leaves.length);

    expect(loaded).toHaveLength(205);
    expect(getClusterLeaves.mock.calls).toEqual([[42, 100, 0], [42, 100, 100], [42, 5, 200]]);
  });

  it("fits the complete extent of valid leaf points", () => {
    const fit = clusterFitForLeaves([
      point(-128.4, 50.8),
      point(-123.2, 48.3),
      point(-125.1, 49.4),
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
    ]);
    expect(fit).toMatchObject({
      bounds: [[-128.4, 48.3], [-123.2, 50.8]],
      coincident: false,
    });
    expect(fit?.center[0]).toBeCloseTo(-125.8);
    expect(fit?.center[1]).toBeCloseTo(49.55);
  });

  it("marks coincident leaves so the camera can cap its close-up zoom", () => {
    expect(clusterFitForLeaves([point(-124.5, 49.5), point(-124.5, 49.5)])).toEqual({
      bounds: [[-124.5, 49.5], [-124.5, 49.5]],
      center: [-124.5, 49.5],
      coincident: true,
    });
    expect(clusterFitForLeaves([])).toBeNull();
  });

  it("stops safely if a stale source returns no further leaves", async () => {
    const getClusterLeaves = vi.fn(async () => [] as GeoJSON.Feature[]);
    await expect(fetchClusterLeaves({ getClusterLeaves }, 7, 5)).resolves.toEqual([]);
    expect(getClusterLeaves).toHaveBeenCalledTimes(1);
  });
});
