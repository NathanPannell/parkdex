import { useEffect } from "react";
import type { KipPose } from "../components/Kip";
import { isFeatureEnabled, type FeatureFlag } from "./appConfig";
import { captureProductEvent } from "./productAnalytics";

/**
 * Kip's Tips: the first time a new idea comes up, Kip explains it in one or two short pages.
 * Feature code asks for a tip with `useKipTip(id, when)` (or `requestKipTip(id)` from an event
 * handler); `KipTipHost` shows one tip at a time over the current screen. Seen state is per
 * device in localStorage, keyed by tip ID and version, so changing a tip's copy enough to
 * re-teach it means bumping its version.
 */

export type KipTipId =
  | "crew-leader"
  | "crew-outsider"
  | "crew-joined"
  | "points"
  | "photo-crop"
  | "dex"
  | "badge-first"
  | "install-web";

export type KipTipPage = { title: string; body: string; pose: KipPose };
export type KipTip = { id: KipTipId; version: number; pages: readonly [KipTipPage] | readonly [KipTipPage, KipTipPage] };

export const KIP_TIPS: { readonly [Id in KipTipId]: KipTip & { id: Id } } = {
  "crew-leader": {
    id: "crew-leader",
    version: 1,
    pages: [
      { pose: "cheer", title: "Your flag is protected", body: "Your flag is safe for an hour. Nobody can take it." },
      { pose: "point", title: "Bring your crew", body: "Friends with you? Show them the crew code. They scan it and hold this park with you." },
    ],
  },
  "crew-outsider": {
    id: "crew-outsider",
    version: 1,
    pages: [
      { pose: "think", title: "This flag is protected", body: "This flag was just planted, so it's protected for an hour. You can still log your visit." },
      { pose: "point", title: "Take it later", body: "Come back after the hour to take it, or ask the crew for their code." },
    ],
  },
  "crew-joined": {
    id: "crew-joined",
    version: 1,
    pages: [{ pose: "cheer", title: "You're in the crew!", body: "You all hold this park now. If anyone takes it, the whole crew loses it, so keep visiting." }],
  },
  points: {
    id: "points",
    version: 1,
    pages: [{ pose: "talk", title: "Points by the hour", body: "Your flag earns 1 point every hour it flies. Planting, taking and visiting add a little extra." }],
  },
  "photo-crop": {
    id: "photo-crop",
    version: 1,
    pages: [{ pose: "camera", title: "Frame your shot", body: "Drag and pinch to frame your photo. This photo goes in your Dex." }],
  },
  dex: {
    id: "dex",
    version: 1,
    pages: [{ pose: "map", title: "This is your Dex", body: "Every park you visit lands here, sorted by region. Turn off “Only my visits” to see what's left to find." }],
  },
  "badge-first": {
    id: "badge-first",
    version: 1,
    pages: [{ pose: "cheer", title: "You earned a badge!", body: "Sew up to 3 onto your flag, and everyone who sees your flag sees them too." }],
  },
  "install-web": {
    id: "install-web",
    version: 1,
    pages: [{ pose: "point", title: "Go full screen", body: "Add Parkdex to your home screen for the full-screen version." }],
  },
};

export const KIP_TIP_IDS = Object.keys(KIP_TIPS) as KipTipId[];

/** Tips about a feature behind a flag: they never show while it is off, not even from the demo tools. */
const TIP_FLAGS: Partial<Record<KipTipId, FeatureFlag>> = { "badge-first": "badges" };

const SEEN_KEY = "parkdex-kip-tips-seen-v1";
const ENABLED_KEY = "parkdex-kip-tips-enabled-v1";

/** How a tip closed: Skip, the system back button (or Escape), a tap outside, or Got it. */
export type KipTipClose = "skip" | "back" | "outside" | "done";
export type ShownKipTip = { tip: KipTip; token: number };

type Entry = ShownKipTip & { shown: boolean };

// Tips seen this session, kept even when storage works, so a tip shows at most once per
// session if writes fail. `enabledOverride` does the same for the Settings switch.
const sessionSeen = new Set<string>();
let enabledOverride: boolean | null = null;
let queue: Entry[] = [];
let nextToken = 1;
let paused = false;
const listeners = new Set<() => void>();

const seenKey = (tip: KipTip) => `${tip.id}@${tip.version}`;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readSeen(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(SEEN_KEY) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeKipTips(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** On by default. A choice made this session wins over storage, so a failed write still applies. */
export function kipTipsEnabled(): boolean {
  if (enabledOverride !== null) return enabledOverride;
  try {
    return storage()?.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setKipTipsEnabled(enabled: boolean): void {
  enabledOverride = enabled;
  try {
    storage()?.setItem(ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    // The choice still applies until the app restarts.
  }
  if (!enabled) queue = queue.filter((entry) => entry.shown);
  notify();
}

export function isKipTipSeen(id: KipTipId): boolean {
  const key = seenKey(KIP_TIPS[id]);
  return sessionSeen.has(key) || key in readSeen();
}

export function markKipTipSeen(id: KipTipId): void {
  const key = seenKey(KIP_TIPS[id]);
  sessionSeen.add(key);
  try {
    storage()?.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(), [key]: new Date().toISOString() }));
  } catch {
    // Without storage the session set keeps the tip from showing again until the app restarts.
  }
}

/** "Replay Kip's Tips": forget every seen tip, and switch tips back on. */
export function replayKipTips(): void {
  sessionSeen.clear();
  try {
    storage()?.removeItem(SEEN_KEY);
  } catch {
    // Nothing stored to clear.
  }
  setKipTipsEnabled(true);
}

/**
 * Ask for a tip now, from an event handler. It shows unless tips are off, it was seen, or it is
 * already waiting. `force` skips those checks, for the demo tools. True when it was queued.
 */
export function requestKipTip(id: KipTipId, { force = false }: { force?: boolean } = {}): boolean {
  if (queue.some((entry) => entry.tip.id === id)) return false;
  const flag = TIP_FLAGS[id];
  if (flag && !isFeatureEnabled(flag)) return false;
  if (!force && (!kipTipsEnabled() || isKipTipSeen(id))) return false;
  queue = [...queue, { tip: KIP_TIPS[id], token: nextToken++, shown: false }];
  notify();
  return true;
}

/** Drop a tip that is still waiting, because what it explains has gone. A tip on screen stays. */
export function withdrawKipTip(id: KipTipId): void {
  const before = queue.length;
  queue = queue.filter((entry) => entry.shown || entry.tip.id !== id);
  if (queue.length !== before) notify();
}

/** The host holds tips back while onboarding or the splash is up. */
export function setKipTipsPaused(value: boolean): void {
  if (paused === value) return;
  paused = value;
  notify();
}

/** The tip to show now, or null. Stable between changes, for useSyncExternalStore. */
export function currentKipTip(): ShownKipTip | null {
  return paused ? null : queue[0] ?? null;
}

/** Called by the host once a tip is on screen. Records it for this session and sends `tip_shown` once. */
export function noteKipTipShown(token: number): void {
  const entry = queue[0];
  if (!entry || entry.token !== token || entry.shown) return;
  entry.shown = true;
  sessionSeen.add(seenKey(entry.tip));
  captureProductEvent("tip_shown", { tip_id: entry.tip.id, tip_version: entry.tip.version });
}

/** Close the tip on screen. Any way of closing marks it seen; only Got it counts as completed. */
export function closeKipTip(token: number, how: KipTipClose, page: number): void {
  const entry = queue[0];
  if (!entry || entry.token !== token) return;
  queue = queue.slice(1);
  markKipTipSeen(entry.tip.id);
  const properties = { tip_id: entry.tip.id, tip_version: entry.tip.version, page: page + 1, pages: entry.tip.pages.length };
  if (how === "done") captureProductEvent("tip_completed", properties);
  else captureProductEvent("tip_skipped", { ...properties, via: how });
  notify();
}

/**
 * Show tip `id` once `when` is true, after that render has painted so the thing being
 * explained is visible behind it. If `when` turns false before the tip shows, it is withdrawn.
 */
export function useKipTip(id: KipTipId, when: boolean): void {
  useEffect(() => {
    if (!when) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => void requestKipTip(id));
    });
    return () => {
      cancelAnimationFrame(frame);
      withdrawKipTip(id);
    };
  }, [id, when]);
}

/** Test hook: forget session state and the queue. */
export function resetKipTipsForTests(): void {
  sessionSeen.clear();
  enabledOverride = null;
  queue = [];
  nextToken = 1;
  paused = false;
  listeners.clear();
}
