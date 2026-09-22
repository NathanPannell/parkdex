import type { PendingVisit } from "./visit-outbox";
import type { KeyValueStore } from "./platform-storage";

type BrowserStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type StorageLike = KeyValueStore | BrowserStorageLike;

export const JOURNAL_STORAGE = {
  collectionKey: "every-park:collection-key:v1",
  places: "every-park:places:v1",
  guestVisited: "every-park:visited:v1",
  guestVisitTimestamps: "every-park:visit-timestamps:v1",
  guestVisitMetadata: "every-park:visit-metadata:v1",
  guestTrails: "every-park:trails:v1",
  guestVisitPending: "every-park:pending:v1",
  guestTrailPending: "every-park:trail-pending:v1",
  guestRevision: "every-park:guest-revision:v1",
  accountSnapshot: "every-park:account-snapshot:v1",
  accountDeletion: "every-park:account-deletion:v1",
} as const;

export type PendingSnapshot = Record<string, PendingVisit | boolean>;

export function accountPendingKey(accountId: string, kind: "visits" | "trails") {
  return `every-park:account-${kind}-pending:${accountId}:v1`;
}

export function importedGuestKey(accountId: string) {
  return `every-park:imported-guest:${accountId}:v1`;
}

function decodeStored<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    if (typeof fallback === "string") return raw as T;
    return fallback;
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

export function readStored<T>(storage: StorageLike, key: string, fallback: T): T | Promise<T> {
  try {
    const raw = storage.getItem(key);
    return isPromiseLike(raw) ? raw.then((value) => decodeStored(value, fallback)) : decodeStored(raw, fallback);
  } catch {
    // Synchronous browser-storage failures are recoverable. Native async
    // storage failures intentionally reject so the journal can fail closed.
    return fallback;
  }
}

export function writeStored(storage: StorageLike, key: string, value: unknown): boolean | Promise<boolean> {
  try {
    const result = storage.setItem(key, JSON.stringify(value));
    return isPromiseLike(result) ? result.then(() => true).catch(() => false) : true;
  } catch {
    return false;
  }
}

export function writeRawStored(storage: StorageLike, key: string, value: string): boolean | Promise<boolean> {
  try {
    const result = storage.setItem(key, value);
    return isPromiseLike(result) ? result.then(() => true).catch(() => false) : true;
  } catch {
    return false;
  }
}

export function removeStored(storage: StorageLike, key: string): boolean | Promise<boolean> {
  try {
    const result = storage.removeItem(key);
    return isPromiseLike(result) ? result.then(() => true).catch(() => false) : true;
  } catch {
    return false;
  }
}

/** Legacy synchronous access used by the existing groups cache. */
export function getBrowserStorage(): BrowserStorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class IdentityEpoch {
  private value = 0;

  capture() { return this.value; }
  advance() { this.value += 1; return this.value; }
  isCurrent(captured: number) { return captured === this.value; }
}

export function toggledSet(current: ReadonlySet<string>, id: string): { next: Set<string>; enabled: boolean } {
  const next = new Set(current);
  const enabled = !next.has(id);
  if (enabled) next.add(id); else next.delete(id);
  return { next, enabled };
}
