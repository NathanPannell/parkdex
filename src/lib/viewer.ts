/**
 * The full-screen viewer's maths (`components/FullscreenViewer.tsx`): which slide is open, how far
 * it is zoomed and panned, and what a finger lifting or a key press does. Kept free of React and
 * the DOM so it can be tested on its own.
 *
 * Sizes are CSS pixels. `box` is the viewer's stage; `content` is the slide drawn at zoom 1, fitted
 * inside the stage. A transform's `x` and `y` move the content's centre from the stage's centre.
 */

export type Size = { width: number; height: number };
export type ViewerTransform = { scale: number; x: number; y: number };
export type Point = { x: number; y: number };

/** The furthest a slide zooms in from its fitted size. */
export const MAX_VIEWER_ZOOM = 4;
/** A double tap at zoom 1 zooms to this; at any other zoom it returns to 1. */
export const DOUBLE_TAP_ZOOM = 2.5;
/** Two taps this close in time, and in place, are a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 30;
/** A finger that moved less than this is a tap, not a drag. */
export const TAP_SLOP_PX = 8;
/** Drag down this far, or flick down this fast, to close. */
export const CLOSE_DRAG_PX = 110;
export const CLOSE_FLICK_PX_PER_MS = 0.5;
/** Drag sideways this share of the stage, or flick this fast, to go to the next or previous slide. */
export const PAGE_DRAG_SHARE = 0.22;
export const PAGE_FLICK_PX_PER_MS = 0.45;

export const IDENTITY: ViewerTransform = Object.freeze({ scale: 1, x: 0, y: 0 });

/**
 * Which slide is open: null when the viewer is closed. Opening picks a slide inside the list;
 * stepping stops at either end instead of wrapping.
 */
export type ViewerState = { index: number | null };
export type ViewerAction =
  | { type: "open"; index: number; count: number }
  | { type: "close" }
  | { type: "step"; delta: number; count: number };

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case "open":
      if (action.count < 1) return { index: null };
      return { index: clamp(Math.round(action.index) || 0, 0, action.count - 1) };
    case "close":
      return state.index === null ? state : { index: null };
    case "step": {
      if (state.index === null || action.count < 1) return state;
      const index = clamp(state.index + action.delta, 0, action.count - 1);
      return index === state.index ? state : { index };
    }
  }
}

/** What a key does while the viewer is open. Escape closes, like Android back. */
export function viewerKeyAction(key: string): "close" | "next" | "prev" | null {
  if (key === "Escape") return "close";
  if (key === "ArrowRight") return "next";
  if (key === "ArrowLeft") return "prev";
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The largest size of this shape that fits inside `box`, never zero. */
export function fitInside(natural: Size, box: Size): Size {
  if (!(natural.width > 0) || !(natural.height > 0) || !(box.width > 0) || !(box.height > 0)) return { width: Math.max(1, box.width), height: Math.max(1, box.height) };
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  return { width: natural.width * scale, height: natural.height * scale };
}

/**
 * Keeps a transform inside its limits: zoom between 1 and MAX_VIEWER_ZOOM, and pan only as far as
 * the zoomed content overhangs the stage, so an edge never pulls in past the stage's edge. At zoom
 * 1 the content is centred.
 */
export function clampTransform(transform: ViewerTransform, box: Size, content: Size): ViewerTransform {
  const scale = clamp(Number.isFinite(transform.scale) ? transform.scale : 1, 1, MAX_VIEWER_ZOOM);
  const maxX = Math.max(0, (content.width * scale - box.width) / 2);
  const maxY = Math.max(0, (content.height * scale - box.height) / 2);
  // `|| 0` turns -0 into 0, so a centred slide is exactly IDENTITY.
  return {
    scale,
    x: clamp(Number.isFinite(transform.x) ? transform.x : 0, -maxX, maxX) || 0,
    y: clamp(Number.isFinite(transform.y) ? transform.y : 0, -maxY, maxY) || 0,
  };
}

/**
 * Zooms by `factor` around `focus`, a point given from the stage's centre, so the part of the
 * slide under the fingers stays under them.
 */
export function zoomAround(transform: ViewerTransform, factor: number, focus: Point, box: Size, content: Size): ViewerTransform {
  if (!(factor > 0) || !Number.isFinite(factor)) return clampTransform(transform, box, content);
  const scale = clamp(transform.scale * factor, 1, MAX_VIEWER_ZOOM);
  const applied = scale / transform.scale;
  return clampTransform({
    scale,
    x: focus.x - (focus.x - transform.x) * applied,
    y: focus.y - (focus.y - transform.y) * applied,
  }, box, content);
}

/** Moves a zoomed slide with the finger. */
export function panBy(transform: ViewerTransform, dx: number, dy: number, box: Size, content: Size): ViewerTransform {
  return clampTransform({ ...transform, x: transform.x + dx, y: transform.y + dy }, box, content);
}

/** A double tap zooms in on the tapped point, or back out to the fitted size when zoomed. */
export function doubleTap(transform: ViewerTransform, focus: Point, box: Size, content: Size): ViewerTransform {
  if (transform.scale > 1.01) return IDENTITY;
  return zoomAround(IDENTITY, DOUBLE_TAP_ZOOM, focus, box, content);
}

export function isZoomed(transform: ViewerTransform): boolean {
  return transform.scale > 1.01;
}

/** True when a second tap lands soon enough and near enough to the first to be a double tap. */
export function isDoubleTap(previous: { at: number; point: Point } | null, at: number, point: Point): boolean {
  if (!previous) return false;
  return at - previous.at <= DOUBLE_TAP_MS && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <= DOUBLE_TAP_SLOP_PX;
}

export type Release = {
  /** How far the finger travelled, in CSS pixels. */
  dx: number;
  dy: number;
  /** Its speed as it lifted, in CSS pixels per millisecond. */
  vx: number;
  vy: number;
  transform: ViewerTransform;
  index: number;
  count: number;
  box: Size;
};

/**
 * What one finger lifting does. A zoomed slide only pans, so lifting never closes it or turns the
 * page. Otherwise a mostly downward drag or flick closes the viewer, and a mostly sideways one
 * goes to the next or previous slide when there is one.
 */
export function releaseAction({ dx, dy, vx, vy, transform, index, count, box }: Release): "close" | "next" | "prev" | "stay" {
  if (isZoomed(transform)) return "stay";
  if (Math.abs(dy) > Math.abs(dx)) {
    if (dy > 0 && (dy >= CLOSE_DRAG_PX || (vy >= CLOSE_FLICK_PX_PER_MS && dy > TAP_SLOP_PX * 3))) return "close";
    return "stay";
  }
  const far = Math.abs(dx) >= box.width * PAGE_DRAG_SHARE || (Math.abs(vx) >= PAGE_FLICK_PX_PER_MS && Math.abs(dx) > TAP_SLOP_PX * 3);
  if (!far) return "stay";
  if (dx < 0 && index < count - 1) return "next";
  if (dx > 0 && index > 0) return "prev";
  return "stay";
}

/** How faded the backdrop is while a slide is dragged down to close: 1 at rest, lighter with distance. */
export function dragDownOpacity(dy: number): number {
  return clamp(1 - Math.max(0, dy) / 400, 0.35, 1);
}

/**
 * "My flag" in the viewer: as wide as the stage allows inside a 20 px margin, short enough to
 * leave room for the @handle and score under its 3:2 cloth, and never wider than 640 px.
 */
export function flagViewSize(stage: Size): number {
  return Math.max(120, Math.floor(Math.min(stage.width - 40, (stage.height - 120) * 1.5, 640)));
}
