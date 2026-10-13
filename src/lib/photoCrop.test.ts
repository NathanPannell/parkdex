import { describe, expect, it } from "vitest";
import {
  clampCrop, cropImageStyle, cropPixels, cropZoom, isPhotoCrop, largestCrop, MAX_CROP_ZOOM, maxCropZoom, MIN_CROP_WIDTH_PX, panCrop, roundCrop, zoomCrop, type PhotoCrop,
} from "./photoCrop";
import { uprightSize } from "./photoOrientation";

/** The crop's shape in pixels of a photo this size. */
function pixelAspect(crop: PhotoCrop, width: number, height: number): number {
  return (crop.width * width) / (crop.height * height);
}

function expectInside(crop: PhotoCrop) {
  expect(crop.x).toBeGreaterThanOrEqual(0);
  expect(crop.y).toBeGreaterThanOrEqual(0);
  expect(crop.x + crop.width).toBeLessThanOrEqual(1 + 1e-9);
  expect(crop.y + crop.height).toBeLessThanOrEqual(1 + 1e-9);
}

describe("largestCrop", () => {
  it("takes the full height of a landscape photo and centres it", () => {
    const crop = largestCrop(2048, 1536);
    expect(crop.height).toBe(1);
    expect(crop.y).toBe(0);
    expect(crop.width).toBeCloseTo(0.5625, 10);
    expect(crop.x).toBeCloseTo(0.21875, 10);
    expect(pixelAspect(crop, 2048, 1536)).toBeCloseTo(3 / 4, 10);
  });

  it("takes the full width of a portrait photo taller than 3:4", () => {
    const crop = largestCrop(1152, 2048);
    expect(crop.width).toBe(1);
    expect(crop.x).toBe(0);
    expect(crop.height).toBeCloseTo(0.75, 10);
    expect(crop.y).toBeCloseTo(0.125, 10);
  });

  it("is the whole photo when the photo is already 3:4", () => {
    expect(largestCrop(1536, 2048)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("refuses a photo with no size", () => {
    expect(() => largestCrop(0, 100)).toThrow();
    expect(() => largestCrop(100, Number.NaN)).toThrow();
  });
});

describe("zoom limits", () => {
  it("never zooms out past the largest fit", () => {
    const start = largestCrop(2048, 1536);
    const out = zoomCrop(start, 0.25, { x: 0.5, y: 0.5 }, 2048, 1536);
    expect(out).toEqual(start);
    expect(cropZoom(out, 2048, 1536)).toBeCloseTo(1, 10);
  });

  it("stops zooming in once the crop is MIN_CROP_WIDTH_PX wide", () => {
    const limit = maxCropZoom(2048, 1536);
    expect(limit).toBeCloseTo(1152 / MIN_CROP_WIDTH_PX, 10);
    const zoomed = zoomCrop(largestCrop(2048, 1536), 50, { x: 0.5, y: 0.5 }, 2048, 1536);
    expect(cropZoom(zoomed, 2048, 1536)).toBeCloseTo(limit, 10);
    expect(zoomed.width * 2048).toBeCloseTo(MIN_CROP_WIDTH_PX, 6);
  });

  it("caps zoom at MAX_CROP_ZOOM on a large photo", () => {
    expect(maxCropZoom(8000, 6000)).toBe(MAX_CROP_ZOOM);
  });

  it("does not zoom a photo that is already small", () => {
    expect(maxCropZoom(400, 300)).toBe(1);
    const crop = zoomCrop(largestCrop(400, 300), 3, { x: 0.5, y: 0.5 }, 400, 300);
    expect(crop).toEqual(largestCrop(400, 300));
  });

  it("keeps the point under the fingers where it was", () => {
    const start = largestCrop(2048, 1536);
    const focus = { x: 0.25, y: 0.25 };
    const before = { x: start.x + focus.x * start.width, y: start.y + focus.y * start.height };
    const zoomed = zoomCrop(start, 2, focus, 2048, 1536);
    expect(zoomed.x + focus.x * zoomed.width).toBeCloseTo(before.x, 10);
    expect(zoomed.y + focus.y * zoomed.height).toBeCloseTo(before.y, 10);
    expect(pixelAspect(zoomed, 2048, 1536)).toBeCloseTo(3 / 4, 10);
  });
});

describe("clamping", () => {
  it("keeps a dragged crop inside the photo", () => {
    const start = zoomCrop(largestCrop(2048, 1536), 2, { x: 0.5, y: 0.5 }, 2048, 1536);
    const farRight = panCrop(start, -10, 0, 2048, 1536);
    expect(farRight.x + farRight.width).toBeCloseTo(1, 10);
    const farUp = panCrop(start, 0, 10, 2048, 1536);
    expect(farUp.y).toBe(0);
    expectInside(farRight);
    expectInside(farUp);
  });

  it("moves the photo with the finger: dragging right shows more of the left", () => {
    const start = zoomCrop(largestCrop(2048, 1536), 2, { x: 0.5, y: 0.5 }, 2048, 1536);
    const moved = panCrop(start, 0.1, 0, 2048, 1536);
    expect(moved.x).toBeCloseTo(start.x - 0.1 * start.width, 10);
    expect(moved.width).toBe(start.width);
  });

  it("repairs a stored rectangle that is the wrong shape, too big or outside the photo", () => {
    const repaired = clampCrop({ x: 0.9, y: -0.5, width: 2, height: 0.3 }, 2048, 1536);
    expectInside(repaired);
    expect(pixelAspect(repaired, 2048, 1536)).toBeCloseTo(3 / 4, 10);
    const largest = largestCrop(2048, 1536);
    expect(repaired.width).toBe(largest.width);
    expect(repaired.height).toBe(largest.height);
    expect(repaired.x).toBeCloseTo(1 - largest.width, 10);
  });

  it("falls back to the largest fit for a rectangle that is not a number", () => {
    expect(clampCrop({ x: Number.NaN, y: 0, width: 0.5, height: 0.5 }, 2048, 1536)).toEqual(largestCrop(2048, 1536));
    expect(clampCrop({ x: 0, y: 0, width: 0, height: 0 }, 2048, 1536)).toEqual(largestCrop(2048, 1536));
  });
});

describe("rotated EXIF input", () => {
  it("crops against the upright size of a sideways-stored portrait photo", () => {
    // A phone held upright stores 4032 x 3024 with orientation 6; the player sees 3024 x 4032.
    const upright = uprightSize(4032, 3024, 6);
    expect(upright).toEqual({ width: 3024, height: 4032 });
    const crop = largestCrop(upright.width, upright.height);
    expect(crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(cropPixels(crop, upright.width, upright.height)).toEqual({ sx: 0, sy: 0, sw: 3024, sh: 4032 });
  });

  it("crops a landscape photo turned upright the same as one stored upright", () => {
    const upright = uprightSize(3024, 4032, 8);
    expect(upright).toEqual({ width: 4032, height: 3024 });
    expect(largestCrop(upright.width, upright.height)).toEqual(largestCrop(4032, 3024));
  });
});

describe("cropPixels", () => {
  it("gives whole pixels inside the photo in a 3:4 shape", () => {
    const crop = zoomCrop(largestCrop(2048, 1536), 1.7, { x: 0.8, y: 0.3 }, 2048, 1536);
    const area = cropPixels(crop, 2048, 1536);
    for (const value of Object.values(area)) expect(Number.isInteger(value)).toBe(true);
    expect(area.sx + area.sw).toBeLessThanOrEqual(2048);
    expect(area.sy + area.sh).toBeLessThanOrEqual(1536);
    expect(Math.abs(area.sw / area.sh - 3 / 4)).toBeLessThan(0.002);
  });

  it("covers the full height of a landscape photo at the largest fit", () => {
    expect(cropPixels(largestCrop(2048, 1536), 2048, 1536)).toEqual({ sx: 448, sy: 0, sw: 1152, sh: 1536 });
  });
});

describe("storing and showing a crop", () => {
  it("accepts only finite rectangles inside 0 to 1", () => {
    expect(isPhotoCrop(largestCrop(2048, 1536))).toBe(true);
    expect(isPhotoCrop(roundCrop(zoomCrop(largestCrop(2048, 1536), 2, { x: 1, y: 1 }, 2048, 1536)))).toBe(true);
    expect(isPhotoCrop({ x: 0.5, y: 0, width: 0.6, height: 1 })).toBe(false);
    expect(isPhotoCrop({ x: 0, y: 0, width: 0, height: 1 })).toBe(false);
    expect(isPhotoCrop({ x: "0", y: 0, width: 1, height: 1 })).toBe(false);
    expect(isPhotoCrop(null)).toBe(false);
  });

  it("rounds to six decimals", () => {
    expect(roundCrop({ x: 0.123456789, y: 0, width: 0.5, height: 1 })).toEqual({ x: 0.123457, y: 0, width: 0.5, height: 1 });
  });

  it("positions the original so only the crop shows in a 3:4 box", () => {
    expect(cropImageStyle({ x: 0.25, y: 0.1, width: 0.5, height: 0.5 })).toEqual({
      position: "absolute", left: "-50%", top: "-20%", width: "200%", height: "200%", maxWidth: "none",
    });
  });
});
