import { describe, expect, it } from "vitest";

import { cameraPaddingWithContentMargin } from "@/lib/map-fit";
import { cameraViewDiffers, type MapCameraSnapshot } from "./park-map";

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
