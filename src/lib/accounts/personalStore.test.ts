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

function installTestFileReader() {
  vi.stubGlobal("FileReader", class {
    result: string | null = null;
    error: Error | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    async readAsDataURL(blob: Blob) {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        this.result = `data:${blob.type};base64,${btoa(binary)}`;
        this.onload?.();
      } catch (error) {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.onerror?.();
      }
    }
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

  it("migrates legacy ;utf8 SVG photos as viewable local-only photos and keeps them through guest attach", async () => {
    const storage = globalThis.localStorage as unknown as MemoryStorage;
    const accountId = "89abcdef-1234-4234-8234-123456789abc";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="#f80"/></svg>';
    storage.setItem(LEGACY_KEY, JSON.stringify({ claims: { "cedar-point": { at: "2025-04-03T12:34:56.000Z", photo: "" } } }));
    await seedLegacyPhotos({ "cedar-point": `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` });

    const personal = await import("./personalStore");
    await personal.initializePersonalStore();
    const [guestClaim] = await personal.listPersonalClaims({ kind: "guest" });
    expect(guestClaim.photoIssue).toBeNull();
    const guestPhoto = await personal.getPersonalPhoto({ kind: "guest" }, guestClaim.claimId);
    expect(guestPhoto).toMatchObject({ contentType: "image/svg+xml", backupState: "unsupported", unsupportedReason: "type" });
    expect(await guestPhoto?.blob.text()).toBe(svg);
    installTestFileReader();
    expect((await personal.loadPersonalPhotos({ kind: "guest" }))?.["cedar-point"]).toMatch(/^data:image\/svg\+xml;/);
    expect(await readLegacyPhoto("cedar-point")).toBeUndefined();

    await personal.setLegacyClaimSnapshot({ kind: "guest" }, guestClaim.claimId, park(), "staging-r17");
    await personal.copyGuestClaimsToAccount(accountId);
    const account = { kind: "account" as const, accountId };
    const attachedPhoto = await personal.getPersonalPhoto(account, guestClaim.claimId);
    expect(attachedPhoto).toMatchObject({ contentType: "image/svg+xml", backupState: "unsupported", unsupportedReason: "type" });
    expect(attachedPhoto?.sha256).toBe(guestPhoto?.sha256);
    expect(await attachedPhoto?.blob.text()).toBe(svg);
    expect(await personal.listPersonalOutbox(account)).toEqual([
      { ownerKey: `account:${accountId}`, claimId: guestClaim.claimId, kind: "claim" },
    ]);
    await expect(personal.removeAttachedGuestClaims(accountId)).rejects.toThrow("waiting for server acknowledgement");
    expect(await personal.getPersonalPhoto({ kind: "guest" }, guestClaim.claimId)).not.toBeNull();

    const attachedClaim = (await personal.listPersonalClaims(account))[0];
    await personal.markClaimUploaded(account, guestClaim.claimId, {
      parkId: attachedClaim.parkId,
      claimedAt: attachedClaim.claimedAt,
      parkSnapshot: attachedClaim.parkSnapshot!,
      contentReleaseId: attachedClaim.contentReleaseId,
    });

    // A missing account copy must never cause cleanup to delete the only guest copy.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("parkdex-personal-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("photos", "readwrite");
        tx.objectStore("photos").delete([`account:${accountId}`, guestClaim.claimId]);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
    await expect(personal.removeAttachedGuestClaims(accountId)).rejects.toThrow("not durably attached");
    expect(await personal.getPersonalPhoto({ kind: "guest" }, guestClaim.claimId)).not.toBeNull();

    await personal.copyGuestClaimsToAccount(accountId);
    expect(await personal.removeAttachedGuestClaims(accountId)).toBe(1);
    expect(await personal.getPersonalPhoto({ kind: "guest" }, guestClaim.claimId)).toBeNull();
    const retainedAccountPhoto = await personal.getPersonalPhoto(account, guestClaim.claimId);
    expect(retainedAccountPhoto).toMatchObject({ contentType: "image/svg+xml", backupState: "unsupported", unsupportedReason: "type" });
    expect(await retainedAccountPhoto?.blob.text()).toBe(svg);
    installTestFileReader();
    expect((await personal.loadPersonalPhotos(account))["cedar-point"]).toMatch(/^data:image\/svg\+xml;/);
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
    const malformedSvg = "data:image/svg+xml;utf8,<svg>%not-encoded</svg>";
    await seedLegacyPhotos({ "cedar-point": malformedSvg });
    const personal = await import("./personalStore");
    await personal.initializePersonalStore();
    const [claim] = await personal.listPersonalClaims({ kind: "guest" });
    expect(claim.photoIssue).toBe("corrupt");
    expect(await personal.getPersonalPhoto({ kind: "guest" }, claim.claimId)).toBeNull();
    expect(await readLegacyPhoto("cedar-point")).toBe(malformedSvg);
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
