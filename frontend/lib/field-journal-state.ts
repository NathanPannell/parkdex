import type { PendingVisit } from "./visit-outbox";
import type { KeyValueStore } from "./platform-storage";

export type StorageLike = KeyValueStore;

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
} as const;

export type PendingSnapshot = Record<string, PendingVisit | boolean>;

export function accountPendingKey(accountId: string, kind: "visits" | "trails") {
  return `every-park:account-${kind}-pending:${accountId}:v1`;
}

export function importedGuestKey(accountId: string) {
  return `every-park:imported-guest:${accountId}:v1`;
}

export async function readStored<T>(storage: StorageLike, key: string, fallback: T): Promise<T> {
  let raw: string | null = null;
  try {
    raw = await storage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch {
    if (raw !== null && typeof fallback === "string") return raw as T;
    return fallback;
  }
}

export async function writeStored(storage: StorageLike, key: string, value: unknown): Promise<boolean> {
  try {
    await storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export async function writeRawStored(storage: StorageLike, key: string, value: string): Promise<boolean> {
  try {
    await storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export async function removeStored(storage: StorageLike, key: string): Promise<boolean> {
  try {
    await storage.removeItem(key);
    return true;
  } catch {
    return false;
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
