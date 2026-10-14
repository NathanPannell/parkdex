import { describe, expect, it } from "vitest";
import {
  clampTransform, CLOSE_DRAG_PX, DOUBLE_TAP_MS, DOUBLE_TAP_ZOOM, doubleTap, dragDownOpacity, fitInside, flagViewSize, IDENTITY, isDoubleTap, MAX_VIEWER_ZOOM, panBy, releaseAction,
  viewerKeyAction, viewerReducer, zoomAround, type Release,
} from "./viewer";

const box = { width: 360, height: 640 };
/** A 4:3 landscape photo fitted to the stage's width. */
const photo = fitInside({ width: 2048, height: 1536 }, box);

function release(overrides: Partial<Release>): Release {
  return { dx: 0, dy: 0, vx: 0, vy: 0, transform: IDENTITY, index: 0, count: 3, box, ...overrides };
}

describe("opening and closing", () => {
  it("opens on the slide asked for, kept inside the list", () => {
    expect(viewerReducer({ index: null }, { type: "open", index: 1, count: 3 })).toEqual({ index: 1 });
    expect(viewerReducer({ index: null }, { type: "open", index: 7, count: 3 })).toEqual({ index: 2 });
    expect(viewerReducer({ index: null }, { type: "open", index: -1, count: 3 })).toEqual({ index: 0 });
  });

  it("stays closed with nothing to show", () => {
    expect(viewerReducer({ index: null }, { type: "open", index: 0, count: 0 })).toEqual({ index: null });
  });

  it("closes, and closing a closed viewer changes nothing", () => {
    expect(viewerReducer({ index: 2 }, { type: "close" })).toEqual({ index: null });
    const closed = { index: null };
    expect(viewerReducer(closed, { type: "close" })).toBe(closed);
  });

  it("steps between slides and stops at either end", () => {
    expect(viewerReducer({ index: 0 }, { type: "step", delta: 1, count: 3 })).toEqual({ index: 1 });
    const last = { index: 2 };
    expect(viewerReducer(last, { type: "step", delta: 1, count: 3 })).toBe(last);
    const first = { index: 0 };
    expect(viewerReducer(first, { type: "step", delta: -1, count: 3 })).toBe(first);
    expect(viewerReducer({ index: null }, { type: "step", delta: 1, count: 3 })).toEqual({ index: null });
  });

  it("closes on Escape and pages with the arrow keys", () => {
    expect(viewerKeyAction("Escape")).toBe("close");
    expect(viewerKeyAction("ArrowRight")).toBe("next");
    expect(viewerKeyAction("ArrowLeft")).toBe("prev");
    expect(viewerKeyAction("Enter")).toBeNull();
  });
});

describe("lifting a finger", () => {
  it("closes after a long enough drag down", () => {
    expect(releaseAction(release({ dy: CLOSE_DRAG_PX }))).toBe("close");
    expect(releaseAction(release({ dy: CLOSE_DRAG_PX - 1 }))).toBe("stay");
  });

  it("closes after a quick flick down, but not a slow nudge", () => {
    expect(releaseAction(release({ dy: 40, vy: 0.8 }))).toBe("close");
    expect(releaseAction(release({ dy: 40, vy: 0.1 }))).toBe("stay");
  });

  it("never closes on a drag up", () => {
    expect(releaseAction(release({ dy: -300, vy: -2 }))).toBe("stay");
  });

  it("pages sideways when there is a slide that way", () => {
    expect(releaseAction(release({ dx: -120 }))).toBe("next");
    expect(releaseAction(release({ dx: 120, index: 1 }))).toBe("prev");
    expect(releaseAction(release({ dx: 120, index: 0 }))).toBe("stay");
    expect(releaseAction(release({ dx: -120, index: 2 }))).toBe("stay");
    expect(releaseAction(release({ dx: -40, vx: -0.9 }))).toBe("next");
    expect(releaseAction(release({ dx: -40 }))).toBe("stay");
  });

  it("only pans a zoomed slide: lifting never closes it or turns the page", () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    expect(releaseAction(release({ dy: 400, vy: 2, transform: zoomed }))).toBe("stay");
    expect(releaseAction(release({ dx: -300, transform: zoomed }))).toBe("stay");
  });

  it("fades the backdrop as the slide is pulled down", () => {
    expect(dragDownOpacity(0)).toBe(1);
    expect(dragDownOpacity(-50)).toBe(1);
    expect(dragDownOpacity(200)).toBeCloseTo(0.5, 10);
    expect(dragDownOpacity(2000)).toBe(0.35);
  });
});

describe("zoom and pan", () => {
  it("fits a photo inside the stage at its own shape", () => {
    expect(photo).toEqual({ width: 360, height: 270 });
    expect(fitInside({ width: 1536, height: 2048 }, box)).toEqual({ width: 360, height: 480 });
  });

  it("keeps zoom between the fitted size and MAX_VIEWER_ZOOM", () => {
    expect(zoomAround(IDENTITY, 0.2, { x: 0, y: 0 }, box, photo).scale).toBe(1);
    expect(zoomAround(IDENTITY, 50, { x: 0, y: 0 }, box, photo).scale).toBe(MAX_VIEWER_ZOOM);
  });

  it("keeps the point under the fingers in place while zooming", () => {
    const upright = fitInside({ width: 1536, height: 2048 }, box);
    const focus = { x: 60, y: 40 };
    const zoomed = zoomAround(IDENTITY, 2, focus, box, upright);
    // The content point under the focus: (focus - offset) / scale, before and after.
    expect((focus.x - zoomed.x) / zoomed.scale).toBeCloseTo(focus.x, 10);
    expect((focus.y - zoomed.y) / zoomed.scale).toBeCloseTo(focus.y, 10);
  });

  it("pans only as far as the zoomed photo overhangs the stage", () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    const farRight = panBy(zoomed, 10_000, 0, box, photo);
    expect(farRight.x).toBe((360 * 2 - 360) / 2);
    // 270 x 2 = 540 is shorter than the 640 stage, so it stays centred vertically.
    expect(panBy(zoomed, 0, 500, box, photo).y).toBe(0);
  });

  it("centres the slide at the fitted size", () => {
    expect(clampTransform({ scale: 1, x: 80, y: -40 }, box, photo)).toEqual(IDENTITY);
    expect(clampTransform({ scale: Number.NaN, x: Number.NaN, y: 0 }, box, photo)).toEqual(IDENTITY);
  });

  it("double tap zooms in on the tapped point, and out again", () => {
    const zoomed = doubleTap(IDENTITY, { x: 100, y: 0 }, box, photo);
    expect(zoomed.scale).toBe(DOUBLE_TAP_ZOOM);
    expect(zoomed.x).toBeLessThan(0);
    expect(doubleTap(zoomed, { x: 0, y: 0 }, box, photo)).toEqual(IDENTITY);
  });

  it("counts two quick taps in the same place as a double tap", () => {
    const first = { at: 1_000, point: { x: 100, y: 100 } };
    expect(isDoubleTap(first, 1_000 + DOUBLE_TAP_MS, { x: 110, y: 95 })).toBe(true);
    expect(isDoubleTap(first, 1_001 + DOUBLE_TAP_MS, { x: 100, y: 100 })).toBe(false);
    expect(isDoubleTap(first, 1_100, { x: 200, y: 100 })).toBe(false);
    expect(isDoubleTap(null, 1_100, { x: 100, y: 100 })).toBe(false);
  });
});

describe("flagViewSize", () => {
  it("draws the flag nearly as wide as a phone, and caps it on a large screen", () => {
    expect(flagViewSize({ width: 360, height: 700 })).toBe(320);
    expect(flagViewSize({ width: 412, height: 800 })).toBe(372);
    expect(flagViewSize({ width: 1400, height: 1000 })).toBe(640);
  });

  it("leaves room for the name under it on a short stage", () => {
    expect(flagViewSize({ width: 412, height: 300 })).toBe(270);
  });
});
