import { describe, expect, it } from "vitest";
import {
  CONTENT_BOUNDS,
  contentBoundsEnvelope,
  isMapChunkPath,
  isMapLayoutPath,
  isPointInsideContentBounds,
  mapChunkIndex,
  mapChunkPath,
  mapFolder,
  requiresContentWifi,
  tileIntersectsContentBounds,
  type MapPoint,
} from "./contracts";

const VICTORIA: MapPoint = [-123.3656, 48.4284];
const HALIFAX: MapPoint = [-63.5752, 44.6488];

describe("content areas", () => {
  it("covers BC and Nova Scotia and nothing between them", () => {
    expect(CONTENT_BOUNDS).toHaveLength(2);
    for (const point of [VICTORIA, HALIFAX, [-60.65, 46.73], [-130.32, 54.31]] as MapPoint[]) {
      expect(isPointInsideContentBounds(point)).toBe(true);
    }
    // Toronto, Edmonton, Fredericton, Seattle and Anchorage.
    for (const point of [
      [-79.38, 43.65],
      [-113.49, 53.55],
      [-66.64, 45.96],
      [-122.33, 47.61],
      [-149.9, 61.22],
    ] as MapPoint[]) {
      expect(isPointInsideContentBounds(point)).toBe(false);
    }
    expect(isPointInsideContentBounds([Number.NaN, 48.4])).toBe(false);
  });

  it("checks points against any list of boxes, edges included", () => {
    const boxes = [
      [0, 0, 1, 1],
      [10, 10, 11, 11],
    ] as const;
    expect(isPointInsideContentBounds([1, 1], boxes)).toBe(true);
    expect(isPointInsideContentBounds([10.5, 10.5], boxes)).toBe(true);
    expect(isPointInsideContentBounds([5, 5], boxes)).toBe(false);
    expect(isPointInsideContentBounds([0.5, 0.5], [])).toBe(false);
  });

  it("spans every area with one envelope for single-box consumers", () => {
    expect(contentBoundsEnvelope()).toEqual([-139.1, 43.3, -59.6, 60.0]);
    expect(contentBoundsEnvelope([[0, 0, 1, 1]])).toEqual([0, 0, 1, 1]);
    expect(() => contentBoundsEnvelope([])).toThrow(RangeError);
  });

  it("keeps detailed tiles that overlap an area and skips tiles between them", () => {
    expect(tileIntersectsContentBounds(0, 0, 0)).toBe(true);
    // Zoom-9 squares around Victoria and Halifax.
    expect(tileIntersectsContentBounds(9, 80, 177)).toBe(true);
    expect(tileIntersectsContentBounds(9, 165, 184)).toBe(true);
    // Zoom-9 Toronto and a zoom-7 tile over the prairies.
    expect(tileIntersectsContentBounds(9, 143, 186)).toBe(false);
    expect(tileIntersectsContentBounds(7, 25, 41)).toBe(false);
    // A tile that only touches an area's edge holds none of it.
    expect(tileIntersectsContentBounds(1, 1, 0, [[0, 0, 10, 10]])).toBe(true);
    expect(tileIntersectsContentBounds(1, 0, 0, [[0, 0, 10, 10]])).toBe(false);
  });
});

describe("map chunk paths", () => {
  it("reads chunks and layouts in the island folder and in newer folders", () => {
    expect(isMapChunkPath("map/island/000.bin")).toBe(true);
    expect(isMapChunkPath("map/detail/2753.bin")).toBe(true);
    expect(isMapChunkPath("map/fonts/000.bin")).toBe(false);
    expect(isMapChunkPath("map/detail/00.bin")).toBe(false);
    expect(isMapChunkPath("map/detail/sub/000.bin")).toBe(false);
    expect(isMapChunkPath("map/Detail/000.bin")).toBe(false);
    expect(isMapLayoutPath("map/island/manifest.json")).toBe(true);
    expect(isMapLayoutPath("map/detail/manifest.json")).toBe(true);
    expect(isMapLayoutPath("map/manifest.json")).toBe(false);
    expect(isMapLayoutPath("map/fonts/manifest.json")).toBe(false);
    expect(mapChunkIndex("map/detail/0042.bin")).toBe(42);
    expect(mapChunkIndex("map/island/1999.bin")).toBe(1999);
    expect(mapChunkIndex("map/fonts/Noto Sans Regular/0-255.pbf")).toBeNull();
    expect(mapChunkIndex("art/badges/scenes/a.webp")).toBeNull();
  });

  it("names chunks in the folder of their release", () => {
    expect(mapChunkPath(7, "detail")).toBe("map/detail/007.bin");
    expect(mapChunkPath(2753, "island")).toBe("map/island/2753.bin");
    expect(() => mapChunkPath(-1, "detail")).toThrow(RangeError);
    expect(mapFolder([{ path: "data/parks.json" }, { path: "map/detail/000.bin" }, { path: "map/detail/manifest.json" }])).toBe("detail");
    expect(mapFolder([{ path: "map/island/manifest.json" }])).toBe("island");
    // Releases without a map keep the original folder name.
    expect(mapFolder([{ path: "data/parks.json" }])).toBe("island");
  });

  it("waits for Wi-Fi for map chunks in any folder but not for glyphs", () => {
    expect(requiresContentWifi("/releases/abc/map/island/000.bin")).toBe(true);
    expect(requiresContentWifi("/releases/abc/map/detail/000.bin")).toBe(true);
    expect(requiresContentWifi("/releases/abc/map%2Fdetail%2F000.bin")).toBe(true);
    expect(requiresContentWifi("/releases/abc/map/fonts/Noto%20Sans/0-255.pbf")).toBe(false);
    expect(requiresContentWifi("/releases/abc/map/detail/manifest.json")).toBe(false);
  });
});
