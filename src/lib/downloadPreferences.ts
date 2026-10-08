const MOBILE_DATA_KEY = "parkdex-map-downloads-on-mobile-data-v1";

type Listener = (allowed: boolean) => void;
const listeners = new Set<Listener>();

/** Whether chosen map squares and the area around the visitor may download without Wi-Fi. Off by default. */
export function readAllowMobileMapData(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): boolean {
  try {
    return storage?.getItem(MOBILE_DATA_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAllowMobileMapData(allowed: boolean, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(MOBILE_DATA_KEY, allowed ? "1" : "0");
  } catch {
    // Without storage the choice still applies until the app restarts.
  }
  for (const listener of listeners) listener(allowed);
}

export function subscribeAllowMobileMapData(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
