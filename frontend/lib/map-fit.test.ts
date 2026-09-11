import { describe, expect, it } from "vitest";

import { cameraOffsetForPadding, cameraPaddingForOverlays, cameraPaddingWithContentMargin, hasUsableCameraViewport, overviewPadding, selectedPlacePadding, VANCOUVER_ISLAND_OVERVIEW_BOUNDS, type LayoutRect } from "./map-fit";

const rect = (left: number, top: number, width: number, height: number): LayoutRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

describe("selected boundary camera padding", () => {
  it("frames Vancouver Island with phone-safe overlay padding", () => {
    expect(VANCOUVER_ISLAND_OVERVIEW_BOUNDS).toEqual([[-128.52, 48.25], [-123, 50.92]]);
    expect(overviewPadding(390)).toEqual({ top: 156, right: 12, bottom: 112, left: 12 });
  });

  it("reserves the visible map above a full-width mobile sheet", () => {
    expect(selectedPlacePadding(rect(0, 0, 390, 844), rect(12, 409, 366, 353), 142)).toEqual({
      top: 154,
      right: 32,
      bottom: 453,
      left: 32,
    });
  });

  it("moves a desktop boundary beside the detail sheet without double-counting its height", () => {
    expect(selectedPlacePadding(rect(0, 0, 1050, 900), rect(24, 520, 550, 350), 142)).toEqual({
      top: 154,
      right: 32,
      bottom: 32,
      left: 592,
    });
  });

  it("rejects stale desktop padding against a phone canvas during a responsive resize", () => {
    const desktopPadding = selectedPlacePadding(rect(0, 0, 1280, 900), rect(24, 520, 550, 350), 142);
    expect(hasUsableCameraViewport(rect(0, 0, 390, 844), desktopPadding)).toBe(false);
    expect(hasUsableCameraViewport(rect(0, 0, 1280, 900), desktopPadding)).toBe(true);
  });

  it("keeps cluster content between the header, utility bar, and mobile navigation", () => {
    const map = rect(0, 0, 390, 844);
    const overlayPadding = cameraPaddingForOverlays(map, [
      rect(8, 8, 374, 62),
      rect(10, 690, 370, 58),
      rect(14, 762, 362, 70),
    ]);
    expect(overlayPadding).toEqual({ top: 82, right: 24, bottom: 172, left: 24 });
    expect(cameraPaddingWithContentMargin(map, overlayPadding)).toEqual({
      top: 180.33333333333331,
      right: 81,
      bottom: 270.3333333333333,
      left: 81,
    });
  });

  it("uses the center two-thirds of unobstructed map space for fitted clusters", () => {
    expect(cameraPaddingWithContentMargin(rect(0, 0, 600, 900), {
      top: 150,
      right: 30,
      bottom: 150,
      left: 30,
    })).toEqual({ top: 250, right: 120, bottom: 250, left: 120 });
  });

  it("reserves a side sheet on a wide map without treating it as a bottom sheet", () => {
    expect(cameraPaddingForOverlays(rect(0, 0, 1200, 900), [rect(760, 160, 420, 700)])).toEqual({
      top: 28,
      right: 458,
      bottom: 32,
      left: 24,
    });
  });

  it("keeps a usable camera window when temporary overlays meet from both edges", () => {
    const map = rect(0, 0, 390, 620);
    const padding = cameraPaddingForOverlays(map, [rect(0, 0, 390, 280), rect(0, 300, 390, 320)]);
    expect(hasUsableCameraViewport(map, padding, 96)).toBe(true);
    expect(padding.top + padding.bottom).toBeCloseTo(524);
  });

  it("centers point-camera fallbacks in the unobstructed area without map padding", () => {
    expect(cameraOffsetForPadding({ top: 110, right: 58, bottom: 458, left: 58 })).toEqual([0, -174]);
    expect(cameraOffsetForPadding({ top: 40, right: 160, bottom: 40, left: 20 })).toEqual([-70, 0]);
  });
});
