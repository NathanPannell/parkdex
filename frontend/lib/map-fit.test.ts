import { describe, expect, it } from "vitest";

import { hasUsableCameraViewport, selectedPlacePadding, type LayoutRect } from "./map-fit";

const rect = (left: number, top: number, width: number, height: number): LayoutRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

describe("selected boundary camera padding", () => {
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
});
