import { useEffect, useState, useSyncExternalStore } from "react";
import { isNative } from "./native";

/**
 * Parkdex in a phone browser: install, full screen and the portrait-only panel (#177).
 * Native builds skip all of it; `startWebApp()` returns straight away there, and the hooks
 * report nothing to offer.
 */

/** Chrome's install prompt, held back so Parkdex can offer it from Settings and Kip's Tips. */
type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type WebAppEnv = {
  native: boolean;
  /** Running from the home screen, not a browser tab. */
  installed: boolean;
  /** Chrome fired `beforeinstallprompt` and it has not been used yet. */
  promptReady: boolean;
  /** iPhone or iPad, where the only way in is Share, then Add to Home Screen. */
  appleMobile: boolean;
  /** The primary pointer is a finger. */
  coarsePointer: boolean;
  /** The page may call `requestFullscreen` (iPhone Safari may not). */
  fullscreenEnabled: boolean;
  /** A browser tab currently in full screen. */
  fullscreen: boolean;
};

export type InstallOffer = "prompt" | "apple-hint" | null;

/**
 * What "Install Parkdex" does here: Chrome's prompt, the iPhone hint, or nothing. Phones only:
 * a desktop that offers the prompt in a narrow window is not where Parkdex is played.
 */
export function installOffer(env: WebAppEnv): InstallOffer {
  if (env.native || env.installed) return null;
  if (env.promptReady && env.coarsePointer) return "prompt";
  if (env.appleMobile) return "apple-hint";
  return null;
}

/** A phone browser tab that can hide its bars with the Fullscreen API. */
export function canGoFullscreen(env: WebAppEnv): boolean {
  return !env.native && !env.installed && !env.appleMobile && env.coarsePointer && env.fullscreenEnabled;
}

/** Whether the "Go full screen" row shows: the tab could go full screen and isn't. */
export function fullscreenOffer(env: WebAppEnv): boolean {
  return canGoFullscreen(env) && !env.fullscreen;
}

/** iPadOS reports a Mac user agent, so a Mac with touch points is an iPad. */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export type PortraitPanel = "desktop" | "sideways" | null;

/**
 * The Kip panel shows on the web while the viewport is wider than it is tall. It checks the
 * screen shape, not the device, so a narrow desktop window still runs the app. Touch screens
 * get "turn upright"; anything else gets the desktop panel with a QR code.
 *
 * The viewport alone decides. Browsers report screen.orientation inconsistently (iPhones never
 * swap screen.width and height, and emulators can leave the type stale), and an open keyboard
 * does not resize the layout viewport in Chrome or Safari, so it cannot turn an upright phone
 * landscape.
 */
export function portraitPanel(input: { native: boolean; landscapeViewport: boolean; coarsePointer: boolean }): PortraitPanel {
  if (input.native || !input.landscapeViewport) return null;
  return input.coarsePointer ? "sideways" : "desktop";
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installedNow = false;
let started = false;
const listeners = new Set<() => void>();
let snapshot: WebAppEnv | null = null;

function media(query: string): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia(query).matches;
  } catch {
    return false;
  }
}

function readEnv(): WebAppEnv {
  if (isNative || typeof document === "undefined") {
    return { native: true, installed: false, promptReady: false, appleMobile: false, coarsePointer: false, fullscreenEnabled: false, fullscreen: false };
  }
  const fullscreen = !!document.fullscreenElement;
  // A tab put in full screen also matches display-mode: fullscreen, so only count it as
  // installed when no element holds the Fullscreen API.
  const installed = installedNow
    || media("(display-mode: standalone)")
    || (media("(display-mode: fullscreen)") && !fullscreen)
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    native: false,
    installed,
    promptReady: !!deferredPrompt,
    appleMobile: isAppleMobile(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    coarsePointer: media("(pointer: coarse)"),
    fullscreenEnabled: !!document.fullscreenEnabled,
    fullscreen,
  };
}

function sameEnv(a: WebAppEnv, b: WebAppEnv): boolean {
  return (Object.keys(a) as (keyof WebAppEnv)[]).every((key) => a[key] === b[key]);
}

function notify(): void {
  const next = readEnv();
  if (snapshot && sameEnv(snapshot, next)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function currentWebApp(): WebAppEnv {
  if (!snapshot) snapshot = readEnv();
  return snapshot;
}

export function subscribeWebApp(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useWebApp(): WebAppEnv {
  return useSyncExternalStore(subscribeWebApp, currentWebApp, currentWebApp);
}

/** Full screen in a browser tab, then a portrait lock where the browser allows one. Failures are ignored. */
export async function enterFullscreen(): Promise<boolean> {
  if (isNative) return false;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch {
    return false;
  }
  try {
    await (screen.orientation as ScreenOrientation & { lock?: (orientation: string) => Promise<void> }).lock?.("portrait");
  } catch {
    // Orientation lock is optional; the portrait panel covers a sideways screen anyway.
  }
  return true;
}

/** Show Chrome's install prompt. The event works once, so it is dropped whatever the answer. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferredPrompt;
  if (!event) return "unavailable";
  deferredPrompt = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === "accepted") installedNow = true;
    return choice.outcome;
  } catch {
    return "dismissed";
  } finally {
    notify();
  }
}

/**
 * Called once from main.tsx on the web. Holds back Chrome's install prompt, goes full screen
 * on the first tap in a phone tab, and registers the install-only service worker.
 */
export function startWebApp(): void {
  if (isNative || started || typeof window === "undefined") return;
  started = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installedNow = true;
    notify();
  });
  document.addEventListener("fullscreenchange", notify);
  for (const query of ["(display-mode: standalone)", "(display-mode: fullscreen)", "(pointer: coarse)"]) {
    try {
      matchMedia(query).addEventListener("change", notify);
    } catch {
      // Older browsers without MediaQueryList events keep the first reading.
    }
  }

  // The first tap in a phone tab asks for full screen once. Leaving full screen is the
  // player's choice; Settings offers it again instead of asking on every tap.
  if (canGoFullscreen(currentWebApp()) && !document.fullscreenElement) {
    const firstTap = () => {
      window.removeEventListener("pointerup", firstTap, true);
      void enterFullscreen();
    };
    // pointerup, not pointerdown: a touch pointerdown does not count as a user gesture.
    window.addEventListener("pointerup", firstTap, true);
  }

  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    const register = () => void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }
}

function readPanel(): PortraitPanel {
  if (isNative || typeof window === "undefined") return null;
  return portraitPanel({
    native: false,
    landscapeViewport: media("(orientation: landscape)"),
    coarsePointer: media("(pointer: coarse)"),
  });
}

/** Which portrait-only panel to show now, if any. Always null in native builds. */
export function usePortraitPanel(): PortraitPanel {
  const [panel, setPanel] = useState(readPanel);
  useEffect(() => {
    if (isNative) return;
    const update = () => setPanel(readPanel());
    const queries = ["(orientation: landscape)", "(pointer: coarse)"].map((query) => matchMedia(query));
    for (const query of queries) query.addEventListener("change", update);
    screen.orientation?.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      for (const query of queries) query.removeEventListener("change", update);
      screen.orientation?.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return panel;
}
