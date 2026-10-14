import { isNative } from "./native";

/**
 * How a photo is taken:
 *
 * - "native-camera": the Android build hands off to the phone's camera app (`takeNativePhoto`).
 * - "browser-camera": a phone browser, or any browser without a camera stream, opens the phone's
 *   camera app through a file input with `capture`. The phone's own processing (HDR, night mode,
 *   full resolution) applies, which a frame grabbed from a live preview skips.
 * - "live-preview": a desktop browser shows its webcam in the page and grabs a frame.
 */
export type CaptureMode = "native-camera" | "browser-camera" | "live-preview";

export type CaptureEnv = {
  native: boolean;
  /** The primary pointer is a finger. */
  coarsePointer: boolean;
  /** The browser says it is on a phone or tablet. */
  mobileUserAgent: boolean;
  /** `navigator.mediaDevices.getUserMedia` exists. */
  liveCameraApi: boolean;
};

export function captureMode(env: CaptureEnv): CaptureMode {
  if (env.native) return "native-camera";
  if (env.coarsePointer || env.mobileUserAgent || !env.liveCameraApi) return "browser-camera";
  return "live-preview";
}

/** Whether the photo comes from the phone's camera app rather than a preview in the page. */
export const usesCameraApp = (mode: CaptureMode) => mode !== "live-preview";

/** Phones and tablets by user agent, iPads included (they report themselves as a Mac). */
export function isMobileUserAgent(userAgent: string, maxTouchPoints: number, uaDataMobile?: boolean): boolean {
  if (uaDataMobile) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function currentCaptureEnv(): CaptureEnv {
  if (isNative) return { native: true, coarsePointer: true, mobileUserAgent: true, liveCameraApi: false };
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { userAgentData?: { mobile?: boolean } });
  let coarsePointer = false;
  try {
    coarsePointer = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    // Treat a browser without media queries as a desktop.
  }
  return {
    native: false,
    coarsePointer,
    mobileUserAgent: isMobileUserAgent(nav?.userAgent ?? "", nav?.maxTouchPoints ?? 0, nav?.userAgentData?.mobile),
    liveCameraApi: typeof nav?.mediaDevices?.getUserMedia === "function",
  };
}

/**
 * Opens the browser's camera capture: a file input asking for the rear camera. Phone browsers open
 * the camera app straight away, at full resolution; a desktop without a camera shows its file
 * chooser. Resolves with the photo, or null when the player backs out (browsers that fire the
 * input's `cancel` event) or when a newer capture replaces this one.
 *
 * Browsers only open it from a tap, so call this synchronously inside the tap's handler, never
 * after an await or from an effect.
 */
export function openBrowserCamera(): Promise<File | null> {
  current?.settle(null);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  // Asks for the camera, not the gallery. Some browsers still offer the gallery beside it.
  input.setAttribute("capture", "environment");
  input.setAttribute("aria-hidden", "true");
  input.tabIndex = -1;
  // Visually hidden rather than display: none, which some mobile browsers refuse to open.
  input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
  return new Promise((resolve) => {
    const request = {
      settle(file: File | null) {
        if (current !== request) return;
        current = null;
        input.remove();
        resolve(file);
      },
    };
    current = request;
    input.addEventListener("change", () => request.settle(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => request.settle(null));
    document.body.appendChild(input);
    input.click();
  });
}

let current: { settle: (file: File | null) => void } | null = null;

/** A capture opened by the tap that also opens the photo screen, waiting for that screen. */
let started: { shot: Promise<File | null>; at: number } | null = null;

/** How long a started capture waits for its photo screen to mount and collect it. */
const STARTED_TTL_MS = 2000;

/**
 * Call from the tap that opens a photo screen (`PhotoCapture`), before opening it. In a phone
 * browser this opens the camera app inside the tap, which browsers require, and the photo screen
 * collects the result with `takeStartedCapture`. Elsewhere it does nothing: the Android build opens
 * its camera app from the photo screen, and desktops show the live preview.
 */
export function startPhotoCapture(mode: CaptureMode = captureMode(currentCaptureEnv()), now = Date.now()): void {
  started = mode === "browser-camera" ? { shot: openBrowserCamera(), at: now } : null;
}

/** The capture the opening tap started, once. Null when there is none or it is stale. */
export function takeStartedCapture(now = Date.now()): Promise<File | null> | null {
  const taken = started;
  started = null;
  return taken && now - taken.at <= STARTED_TTL_MS ? taken.shot : null;
}
