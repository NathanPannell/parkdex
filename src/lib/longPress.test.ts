import { describe, expect, it, vi } from "vitest";
import { createLongPress, LONG_PRESS_MS, pressMenuPosition } from "./longPress";

function fakeTimers() {
  let pending: { callback: () => void; ms: number } | null = null;
  return {
    timers: {
      set: (callback: () => void, ms: number) => (pending = { callback, ms }),
      clear: () => void (pending = null),
    },
    elapse(ms: number) {
      if (pending && ms >= pending.ms) {
        const { callback } = pending;
        pending = null;
        callback();
      }
    },
  };
}

describe("createLongPress", () => {
  it("fires once a single finger is held still", () => {
    const clock = fakeTimers();
    const onPress = vi.fn();
    const press = createLongPress(onPress, clock.timers);
    press.start({ x: 100, y: 200 });
    press.move({ x: 104, y: 203 });
    clock.elapse(LONG_PRESS_MS);
    expect(onPress).toHaveBeenCalledWith({ x: 100, y: 200 });
    expect(press.end()).toBe(true);
  });

  it("does not fire for a tap", () => {
    const clock = fakeTimers();
    const onPress = vi.fn();
    const press = createLongPress(onPress, clock.timers);
    press.start({ x: 100, y: 200 });
    expect(press.end()).toBe(false);
    clock.elapse(LONG_PRESS_MS);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("does not fire when the finger pans away", () => {
    const clock = fakeTimers();
    const onPress = vi.fn();
    const press = createLongPress(onPress, clock.timers);
    press.start({ x: 100, y: 200 });
    press.move({ x: 100, y: 240 });
    clock.elapse(LONG_PRESS_MS);
    expect(onPress).not.toHaveBeenCalled();
    expect(press.end()).toBe(false);
  });

  it("does not fire for a pinch", () => {
    const clock = fakeTimers();
    const onPress = vi.fn();
    const press = createLongPress(onPress, clock.timers);
    press.start({ x: 100, y: 200 });
    press.move({ x: 100, y: 200 }, 2);
    clock.elapse(LONG_PRESS_MS);
    press.start({ x: 100, y: 200 }, 2);
    clock.elapse(LONG_PRESS_MS);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("pressMenuPosition", () => {
  const viewport = { width: 390, height: 844 };
  const menu = { width: 240, height: 150 };

  it("centres the menu above the pressed point", () => {
    expect(pressMenuPosition({ x: 195, y: 500 }, viewport, menu)).toEqual({ left: 75, top: 336, below: false });
  });

  it("keeps the menu inside the side edges", () => {
    expect(pressMenuPosition({ x: 10, y: 500 }, viewport, menu).left).toBe(12);
    expect(pressMenuPosition({ x: 385, y: 500 }, viewport, menu).left).toBe(138);
  });

  it("drops below the point when there is no room above", () => {
    expect(pressMenuPosition({ x: 195, y: 120 }, viewport, menu, 60)).toEqual({ left: 75, top: 134, below: true });
  });

  it("stays on screen near the bottom when it must go below", () => {
    const short = { width: 390, height: 200 };
    expect(pressMenuPosition({ x: 195, y: 100 }, short, menu).top).toBe(38);
  });
});
