import { DEMO_TOOLS } from "./demo";
import { FIELD, isNative } from "./native";

/**
 * Which builds follow the player's real position.
 * - Phones and field builds always do; the OS asks for permission.
 * - The hosted web app does once the player has allowed location (onboarding's "Allow
 *   location", or "Center on me" later). Without that it keeps the demo spot in Victoria.
 * - Dev builds keep the demo spot, so their teleports and simulated trips work.
 */
export const ALWAYS_TRACKS = FIELD || isNative;
export const WEB_CAN_TRACK = !ALWAYS_TRACKS && !DEMO_TOOLS;

const KEY = "parkdex-web-location-v1";

/** Whether this browser's player allowed live location before. */
export function webLocationAllowed(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): boolean {
  if (!WEB_CAN_TRACK) return false;
  try {
    return storage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberWebLocation(allowed: boolean, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeStorage()): void {
  try {
    if (allowed) storage?.setItem(KEY, "1");
    else storage?.removeItem(KEY);
  } catch {
    // Private windows only lose the choice across reloads.
  }
}

/** Whether the app should watch the player's position right now. */
export function tracksLocation(webAllowed: boolean): boolean {
  return ALWAYS_TRACKS || (WEB_CAN_TRACK && webAllowed);
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
