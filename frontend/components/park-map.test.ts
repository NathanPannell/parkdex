import { describe, expect, it } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { BoundaryIndex } from "@/lib/boundaries";
import { cameraPaddingWithContentMargin } from "@/lib/map-fit";
import { cameraViewDiffers, fitBoundary, type MapCameraSnapshot } from "./park-map";

const overview: MapCameraSnapshot = {
  longitude: -125.25,
  latitude: 49.65,
  zoom: 5.55,
  bearing: 0,
  pitch: 0,
};

describe("map reset visibility state", () => {
  it("treats meaningful pan, zoom, rotation, and pitch changes as moved away", () => {
    expect(cameraViewDiffers({ ...overview, longitude: -125.2 }, overview)).toBe(true);
    expect(cameraViewDiffers({ ...overview, zoom: 6 }, overview)).toBe(true);
    expect(cameraViewDiffers({ ...overview, bearing: 2 }, overview)).toBe(true);
    expect(cameraViewDiffers({ ...overview, pitch: 2 }, overview)).toBe(true);
  });

  it("ignores sub-pixel camera settling around the overview", () => {
    expect(cameraViewDiffers({
      ...overview,
      longitude: overview.longitude + 0.001,
      latitude: overview.latitude - 0.001,
      zoom: overview.zoom + 0.01,
    }, overview)).toBe(false);
  });

  it("adds ten percent breathing room on every side of the visible map area", () => {
    expect(cameraPaddingWithContentMargin(
      { width: 400, height: 600 },
      { top: 100, right: 20, bottom: 200, left: 20 },
      0.1,
    )).toEqual({ top: 130, right: 56, bottom: 230, left: 56 });
  });
});

describe("selected boundary fit", () => {
  it("uses the map's full zoom range for genuinely small park boundaries", () => {
    const calls: Array<{ bounds: unknown; options: { maxZoom?: number } }> = [];
    const map = {
      getMaxZoom: () => 15,
      fitBounds: (bounds: unknown, options: { maxZoom?: number }) => calls.push({ bounds, options }),
    } as unknown as MapLibreMap;
    const index: BoundaryIndex = {
      version: 1,
      boundsById: {
        "regional-wrigglesworth-lake-regional-park": [[-123.5766, 48.51766], [-123.56986, 48.52289]],
      },
    };

    expect(fitBoundary(
      map,
      index,
      "regional-wrigglesworth-lake-regional-park",
      false,
      { top: 38, right: 39, bottom: 38, left: 39 },
    )).toBe(true);
    expect(calls).toEqual([{
      bounds: index.boundsById["regional-wrigglesworth-lake-regional-park"],
      options: {
        padding: { top: 38, right: 39, bottom: 38, left: 39 },
        maxZoom: 15,
        duration: 0,
      },
    }]);
  });
});
