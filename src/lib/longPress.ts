/** Long enough that a slow tap never opens the menu, short enough to feel responsive. */
export const LONG_PRESS_MS = 550;
/** A finger drifts a little while held; more than this is a pan, not a press. */
export const LONG_PRESS_TOLERANCE_PX = 10;

export type ScreenPoint = { x: number; y: number };

type Timers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Tracks one finger held still. `end` reports whether the press fired, so the caller can
 * cancel the click the browser would otherwise send when the finger lifts.
 */
export function createLongPress(onPress: (point: ScreenPoint) => void, timers: Timers = browserTimers) {
  let start: ScreenPoint | null = null;
  let handle: unknown = null;
  let fired = false;

  const cancelTimer = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };

  return {
    start(point: ScreenPoint, touches = 1) {
      cancelTimer();
      fired = false;
      // A second finger means a pinch.
      if (touches !== 1) {
        start = null;
        return;
      }
      start = point;
      handle = timers.set(() => {
        handle = null;
        if (!start) return;
        fired = true;
        onPress(start);
      }, LONG_PRESS_MS);
    },
    move(point: ScreenPoint, touches = 1) {
      if (!start) return;
      if (touches !== 1 || Math.hypot(point.x - start.x, point.y - start.y) > LONG_PRESS_TOLERANCE_PX) {
        start = null;
        cancelTimer();
      }
    },
    end(): boolean {
      cancelTimer();
      start = null;
      const didFire = fired;
      fired = false;
      return didFire;
    },
  };
}

const EDGE = 12;
const GAP = 14;

/**
 * Places the menu above the pressed point so the finger does not cover it, or below when
 * there is no room, and keeps it inside the map.
 */
export function pressMenuPosition(
  point: ScreenPoint,
  viewport: { width: number; height: number },
  menu: { width: number; height: number },
  topInset = 0,
): { left: number; top: number; below: boolean } {
  const maxLeft = Math.max(EDGE, viewport.width - menu.width - EDGE);
  const left = Math.min(Math.max(point.x - menu.width / 2, EDGE), maxLeft);
  const above = point.y - GAP - menu.height;
  const below = above < topInset + EDGE;
  const top = below ? Math.min(point.y + GAP, Math.max(EDGE, viewport.height - menu.height - EDGE)) : above;
  return { left, top, below };
}
