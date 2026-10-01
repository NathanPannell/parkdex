import { distanceKm, type LngLat } from "./geo";

const KEY = "parkdex-last-location-v1";
// Small moves do not change where the next launch should open.
const MIN_SAVE_DISTANCE_KM = 0.2;

let lastSaved: LngLat | null = null;

/** The last usable GPS fix, used only to place the camera before a fresh fix lands. */
export function readLastLocation(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): LngLat | null {
  try {
    const value = JSON.parse(storage?.getItem(KEY) ?? "null");
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [lng, lat] = value;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
    return [lng, lat];
  } catch {
    return null;
  }
}

export function saveLastLocation(point: LngLat, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  if (lastSaved && distanceKm(lastSaved, point) < MIN_SAVE_DISTANCE_KM) return;
  try {
    storage?.setItem(KEY, JSON.stringify([point[0], point[1]]));
    lastSaved = [point[0], point[1]];
  } catch {
    // Private windows and full storage only lose the faster first camera placement.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
