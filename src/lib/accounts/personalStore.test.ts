import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(String(key), String(value)); }
}

const DATABASES = ["parkdex-personal-v1", "parkdex"];
const LEGACY_KEY = "parkdex-mockup-v1";

function deleteDatabase(name: string) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Database ${name} is blocked.`));
  });
}

async function seedLegacyPhotos(entries: Record<string, string>) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("parkdex", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("photos");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("photos", "readwrite");
      for (const [parkId, data] of Object.entries(entries)) tx.objectStore("photos").put(data, parkId);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

async function readLegacyPhoto(parkId: string) {
  return new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open("parkdex", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("photos")) { db.close(); resolve(undefined); return; }
      const tx = db.transaction("photos", "readonly");
      const photo = tx.objectStore("photos").get(parkId);
      photo.onsuccess = () => resolve(photo.result);
      photo.onerror = () => reject(photo.error);
      tx.oncomplete = () => db.close();
    };
  });
}

function park(id = "cedar-point"): import("../parks").Park {
  return {
    id, name: "Cedar Point Park", short: "Cedar Point", category: "regional", region: "Victoria",
    lat: 48.4, lng: -123.3, biome: "coast", shape: "circle", rarity: "common", seed: 7,
    blurb: "A calm shore walk.", scene: "cedar-point",
  };
}

beforeEach(async () => {
  vi.resetModules();
  for (const name of DATABASES) await deleteDatabase(name);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("durable personal progress storage", () => {
  it("cleans migrated legacy rows only after commit and preserves unrelated preferences", async () => {
    const storage = globalThis.localStorage as unknown as MemoryStorage;
    const at = "2025-04-03T12:34:56.000Z";
    storage.setItem(LEGACY_KEY, JSON.stringify({ onboarded: true, muted: true, claims: { "cedar-point": { at, photo: "" } } }));
    const photo = "data:image/png;base64,iVBORw0KGgo=";
    await seedLegacyPhotos({ "cedar-point": photo });

    const personal = await import("./personalStore");
    await personal.initializePersonalStore();
    const first = await personal.listPersonalClaims({ kind: "guest" });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ parkId: "cedar-point", claimedAt: at, parkSnapshot: null, syncState: "local" });
    expect(personal.isUuid(first[0].claimId)).toBe(true);
    expect((await personal.getPersonalPhoto({ kind: "guest" }, first[0].claimId))?.contentType).toBe("image/png");
    expect(JSON.parse(storage.getItem(LEGACY_KEY)!)).toEqual({ onboarded: true, muted: true, claims: {} });
    expect(await readLegacyPhoto("cedar-point")).toBeUndefined();

    vi.resetModules();
    const restarted = await import("./personalStore");
    await restarted.initializePersonalStore();
    expect((await restarted.listPersonalClaims({ kind: "guest" })).map((claim) => claim.claimId)).toEqual([first[0].claimId]);
  });

  it("recovers cleanly when migration is interrupted before its destination transaction", async () => {
    const storage = globalThis.localStorage as unknown as MemoryStorage;
    storage.setItem(LEGACY_KEY, "{ broken json");
    const personal = await import("./personalStore");
    await expect(personal.initializePersonalStore()).rejects.toThrow("Existing data was left untouched");
    expect(storage.getItem(LEGACY_KEY)).toBe("{ broken json");

    storage.setItem(LEGACY_KEY, JSON.stringify({ claims: { "cedar-point": { at: "2025-04-03T12:34:56.000Z", photo: "" } } }));
    await personal.initializePersonalStore();
    expect(await personal.listPersonalClaims({ kind: "guest" })).toHaveLength(1);
  });

  it("keeps a claim when its legacy photo is corrupt and does not invent a replacement", async () => {
    const storage = globalThis.localStorage as unknown as MemoryStorage;
    storage.setItem(LEGACY_KEY, JSON.stringify({ claims: { "cedar-point": { at: "2025-04-03T12:34:56.000Z", photo: "" } } }));
    await seedLegacyPhotos({ "cedar-point": "not-a-photo" });
    const personal = await import("./personalStore");
    await personal.initializePersonalStore();
    const [claim] = await personal.listPersonalClaims({ kind: "guest" });
    expect(claim.photoIssue).toBe("corrupt");
    expect(await personal.getPersonalPhoto({ kind: "guest" }, claim.claimId)).toBeNull();
    expect(await readLegacyPhoto("cedar-point")).toBe("not-a-photo");
  });

  it("commits a new claim, supported photo, and account outbox before returning", async () => {
    const personal = await import("./personalStore");
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer], { type: "image/png" });
    const claim = await personal.createPersonalClaim({ kind: "account", accountId: "89abcdef-1234-4234-8234-123456789abc" }, {
      park: park(), claimedAt: "2025-04-03T12:34:56.000Z", contentReleaseId: "staging-r17", photo: png,
    });
    expect(claim).toMatchObject({ parkId: "cedar-point", syncState: "pending", parkSnapshot: { id: "cedar-point" } });
    expect(await personal.listPersonalOutbox({ kind: "account", accountId: "89abcdef-1234-4234-8234-123456789abc" })).toEqual([
      { ownerKey: "account:89abcdef-1234-4234-8234-123456789abc", claimId: claim.claimId, kind: "claim" },
      { ownerKey: "account:89abcdef-1234-4234-8234-123456789abc", claimId: claim.claimId, kind: "photo" },
    ]);
    expect((await personal.getPersonalPhoto({ kind: "account", accountId: "89abcdef-1234-4234-8234-123456789abc" }, claim.claimId))?.backupState).toBe("pending");
  });

  it("does not project an older photo when the latest visit has no photo", async () => {
    const personal = await import("./personalStore");
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer], { type: "image/png" });
    await personal.createPersonalClaim({ kind: "guest" }, { park: park(), claimedAt: "2025-04-03T12:34:56.000Z", photo: png });
    await personal.createPersonalClaim({ kind: "guest" }, { park: park(), claimedAt: "2025-04-04T12:34:56.000Z" });
    expect(await personal.loadPersonalPhotos({ kind: "guest" })).toEqual({});
  });

  it("does not return claim success when durable storage is unavailable", async () => {
    const personal = await import("./personalStore");
    const old = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    await expect(personal.createPersonalClaim({ kind: "guest" }, { park: park() })).rejects.toThrow();
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: old });
  });
});
