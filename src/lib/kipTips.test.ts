import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
vi.mock("./productAnalytics", () => ({ captureProductEvent: (...args: unknown[]) => capture(...args) }));

import {
  KIP_TIPS,
  KIP_TIP_IDS,
  closeKipTip,
  currentKipTip,
  isKipTipSeen,
  kipTipsEnabled,
  markKipTipSeen,
  noteKipTipShown,
  replayKipTips,
  requestKipTip,
  resetKipTipsForTests,
  setKipTipsEnabled,
  setKipTipsPaused,
  withdrawKipTip,
} from "./kipTips";
import { setFeatureFlagsForTests } from "./appConfig";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

/** Show the waiting tip, as the host does, and return its token. */
function showCurrent(): number {
  const current = currentKipTip();
  if (!current) throw new Error("no tip waiting");
  noteKipTipShown(current.token);
  return current.token;
}

describe("Kip's Tips", () => {
  beforeEach(() => {
    resetKipTipsForTests();
    capture.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("has all four tips, each with one or two pages of short, sentence-case copy", () => {
    expect(KIP_TIP_IDS).toEqual(["points", "dex", "badge-first", "install-web"]);
    for (const id of KIP_TIP_IDS) {
      const tip = KIP_TIPS[id];
      expect(tip.id).toBe(id);
      expect(tip.pages.length).toBeGreaterThanOrEqual(1);
      expect(tip.pages.length).toBeLessThanOrEqual(2);
      for (const page of tip.pages) {
        expect(page.title).toMatch(/^[A-Z]/);
        expect(
          page.title
            .split(" ")
            .slice(1)
            .some((word) => /^[A-Z][a-z]/.test(word) && word !== "Dex"),
        ).toBe(false);
        expect(page.body.length).toBeLessThanOrEqual(140);
      }
    }
  });

  it("stores seen state per tip ID and version", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    expect(isKipTipSeen("points")).toBe(false);
    markKipTipSeen("points");
    expect(Object.keys(JSON.parse(storage.values.get("parkdex-kip-tips-seen-v1")!))).toEqual(["points@2"]);
    resetKipTipsForTests();
    expect(isKipTipSeen("points")).toBe(true);
    expect(isKipTipSeen("dex")).toBe(false);
  });

  it("a throwing localStorage still shows each tip at most once per session", () => {
    vi.stubGlobal("localStorage", throwingStorage);
    expect(kipTipsEnabled()).toBe(true);
    expect(requestKipTip("dex")).toBe(true);
    const token = showCurrent();
    expect(() => closeKipTip(token, "done", 0)).not.toThrow();
    expect(isKipTipSeen("dex")).toBe(true);
    expect(requestKipTip("dex")).toBe(false);
    expect(() => setKipTipsEnabled(false)).not.toThrow();
    expect(kipTipsEnabled()).toBe(false);
    expect(() => replayKipTips()).not.toThrow();
    expect(requestKipTip("dex")).toBe(true);
  });

  it("works when localStorage itself cannot be reached", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    try {
      expect(requestKipTip("points")).toBe(true);
      closeKipTip(showCurrent(), "skip", 0);
      expect(requestKipTip("points")).toBe(false);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("Skip marks a tip as seen and records tip_skipped", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    requestKipTip("points");
    const token = showCurrent();
    expect(capture).toHaveBeenCalledWith("tip_shown", { tip_id: "points", tip_version: 2 });
    closeKipTip(token, "skip", 0);
    expect(currentKipTip()).toBeNull();
    resetKipTipsForTests();
    expect(isKipTipSeen("points")).toBe(true);
    expect(capture).toHaveBeenCalledWith("tip_skipped", { tip_id: "points", tip_version: 2, page: 1, pages: 2, via: "skip" });
  });

  it("Got it records tip_completed, and tip_shown is sent once per showing", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    requestKipTip("points");
    const token = showCurrent();
    noteKipTipShown(token);
    closeKipTip(token, "done", 1);
    expect(capture.mock.calls.filter(([name]) => name === "tip_shown")).toHaveLength(1);
    expect(capture).toHaveBeenCalledWith("tip_completed", { tip_id: "points", tip_version: 2, page: 2, pages: 2 });
    expect(capture.mock.calls.some(([name]) => name === "tip_skipped")).toBe(false);
  });

  it("shows one tip at a time, in order, without repeats", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(requestKipTip("points")).toBe(true);
    expect(requestKipTip("points")).toBe(false);
    expect(requestKipTip("dex")).toBe(true);
    const first = showCurrent();
    expect(currentKipTip()?.tip.id).toBe("points");
    closeKipTip(first, "outside", 0);
    expect(currentKipTip()?.tip.id).toBe("dex");
  });

  it("withdraws a waiting tip but never the one on screen", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    requestKipTip("points");
    requestKipTip("dex");
    showCurrent();
    withdrawKipTip("points");
    withdrawKipTip("dex");
    expect(currentKipTip()?.tip.id).toBe("points");
    closeKipTip(currentKipTip()!.token, "back", 0);
    expect(currentKipTip()).toBeNull();
    expect(isKipTipSeen("dex")).toBe(false);
  });

  it("holds tips back while paused", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    setKipTipsPaused(true);
    requestKipTip("points");
    expect(currentKipTip()).toBeNull();
    setKipTipsPaused(false);
    expect(currentKipTip()?.tip.id).toBe("points");
  });

  it("the Settings switch turns tips off, and Replay clears seen state and turns them back on", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    markKipTipSeen("points");
    setKipTipsEnabled(false);
    expect(storage.values.get("parkdex-kip-tips-enabled-v1")).toBe("0");
    expect(requestKipTip("dex")).toBe(false);
    expect(requestKipTip("dex", { force: true })).toBe(true);
    replayKipTips();
    expect(kipTipsEnabled()).toBe(true);
    expect(isKipTipSeen("points")).toBe(false);
    expect(storage.values.has("parkdex-kip-tips-seen-v1")).toBe(false);
  });

  it("never shows the badge tip while the badges flag is off, not even forced from the demo tools", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    setFeatureFlagsForTests({ badges: false });
    expect(requestKipTip("badge-first")).toBe(false);
    expect(requestKipTip("badge-first", { force: true })).toBe(false);
    expect(currentKipTip()).toBeNull();
    setFeatureFlagsForTests({ badges: true });
    expect(requestKipTip("badge-first")).toBe(true);
    expect(currentKipTip()?.tip.id).toBe("badge-first");
    setFeatureFlagsForTests({ badges: false });
  });
});
