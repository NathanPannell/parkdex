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

async function mutatePersonalDatabase(work: (tx: IDBTransaction) => void) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("parkdex-personal-v1");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(["claims", "photos", "outbox", "meta"], "readwrite");
      try { work(tx); }
      catch (error) { tx.abort(); db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

async function readPersonalValue<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const request = indexedDB.open("parkdex-personal-v1");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(storeName, "readonly");
      const valueRequest = tx.objectStore(storeName).get(key);
      let value: T | undefined;
      valueRequest.onsuccess = () => { value = valueRequest.result as T | undefined; };
      valueRequest.onerror = () => reject(valueRequest.error);
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

function pngPhoto() {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer], { type: "image/png" });
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
  vi.unstubAllGlobals();
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

  it("keeps unsupported guest photos until the acknowledged account copy is durable", async () => {
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
    await personal.reserveGuestClaimsForAccount(accountId);
    const account = { kind: "account" as const, accountId };
    const attachedPhoto = await personal.getPersonalPhoto(account, guestClaim.claimId);
    expect(attachedPhoto).toMatchObject({ contentType: "image/svg+xml", backupState: "unsupported", unsupportedReason: "type" });
    expect(attachedPhoto?.sha256).toBe(guestPhoto?.sha256);
    expect(await attachedPhoto?.blob.text()).toBe(svg);
    expect(await personal.listPersonalOutbox(account)).toEqual([
      { ownerKey: `account:${accountId}`, claimId: guestClaim.claimId, kind: "claim" },
    ]);
    expect(await personal.finalizeReservedGuestClaims(accountId)).toBe(0);
    expect(await personal.listPersonalClaims({ kind: "guest" })).toEqual([]);
    expect(await personal.listPersonalPhotos({ kind: "guest" })).toEqual([]);
    expect(await personal.getPersonalPhoto({ kind: "guest" }, guestClaim.claimId)).toBeNull();

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
    expect(await personal.finalizeReservedGuestClaims(accountId)).toBe(0);
    expect(await readPersonalValue("claims", ["guest", guestClaim.claimId])).toBeDefined();

    await personal.reserveGuestClaimsForAccount(accountId);
    expect(await personal.finalizeReservedGuestClaims(accountId)).toBe(1);
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

  it("accepts frozen municipal and community park snapshots for local claims", async () => {
    const personal = await import("./personalStore");
    const municipal = await personal.createPersonalClaim({ kind: "guest" }, { park: { ...park("beacon-hill"), category: "municipal" } });
    const community = await personal.createPersonalClaim({ kind: "guest" }, { park: { ...park("cedar-grove"), category: "community" } });

    expect(municipal.parkSnapshot?.category).toBe("municipal");
    expect(community.parkSnapshot?.category).toBe("community");
  });

  it("commits an upload rendition only for the same owner, original digest, and frozen snapshot", async () => {
    const personal = await import("./personalStore");
    const owner = { kind: "account" as const, accountId: "89abcdef-1234-4234-8234-123456789abc" };
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x01]).buffer], { type: "image/jpeg" });
    const claim = await personal.createPersonalClaim(owner, { park: park(), photo: new Blob(["<svg />"], { type: "image/svg+xml" }) });
    const original = await personal.getPersonalPhoto(owner, claim.claimId);
    if (!original) throw new Error("Original test photo missing.");
    const converted = { blob: jpeg, contentType: "image/jpeg" as const, sizeBytes: jpeg.size, sha256: await personal.hashPhoto(jpeg) };
    const expected = {
      sha256: original.sha256, contentType: original.contentType, sizeBytes: original.sizeBytes,
      backupState: original.backupState, parkSnapshot: claim.parkSnapshot,
    };

    expect(await personal.commitPhotoBackupRendition(owner, claim.claimId, { ...expected, sha256: "0".repeat(64) }, converted)).toBe("stale");
    expect(await personal.commitPhotoBackupRendition(owner, claim.claimId, expected, converted, () => false)).toBe("session-changed");
    expect(await personal.commitPhotoBackupRendition({ kind: "account", accountId: "12345678-1234-4234-8234-123456789abc" }, claim.claimId, expected, converted)).toBe("stale");
    expect(await personal.getPersonalPhoto(owner, claim.claimId)).toMatchObject({ sha256: original.sha256, backupState: "unsupported", backupRendition: null });
    expect(await personal.listPersonalOutbox(owner)).toEqual([{ ownerKey: `account:${owner.accountId}`, claimId: claim.claimId, kind: "claim" }]);

    expect(await personal.commitPhotoBackupRendition(owner, claim.claimId, expected, converted)).toBe("stored");
    expect(await personal.getPersonalPhoto(owner, claim.claimId)).toMatchObject({
      sha256: original.sha256, contentType: "image/svg+xml", backupState: "pending",
      backupRendition: { sha256: converted.sha256, sizeBytes: converted.sizeBytes, sourceSha256: original.sha256 },
    });
    expect(await personal.listPersonalOutbox(owner)).toEqual([
      { ownerKey: `account:${owner.accountId}`, claimId: claim.claimId, kind: "claim" },
      { ownerKey: `account:${owner.accountId}`, claimId: claim.claimId, kind: "photo" },
    ]);
    expect(await (await personal.getPersonalPhoto(owner, claim.claimId))?.blob.text()).toBe("<svg />");
  });

  it("matches remote ready metadata against the rendition without replacing the original photo", async () => {
    const personal = await import("./personalStore");
    const owner = { kind: "account" as const, accountId: "89abcdef-1234-4234-8234-123456789abc" };
    const originalBlob = new Blob(["<svg />"], { type: "image/svg+xml" });
    const claim = await personal.createPersonalClaim(owner, { park: park(), photo: originalBlob });
    const original = await personal.getPersonalPhoto(owner, claim.claimId);
    if (!original) throw new Error("Original test photo missing.");
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x01]).buffer], { type: "image/jpeg" });
    const converted = { blob: jpeg, contentType: "image/jpeg" as const, sizeBytes: jpeg.size, sha256: await personal.hashPhoto(jpeg) };
    expect(await personal.commitPhotoBackupRendition(owner, claim.claimId, {
      sha256: original.sha256, contentType: original.contentType, sizeBytes: original.sizeBytes,
      backupState: original.backupState, parkSnapshot: claim.parkSnapshot,
    }, converted)).toBe("stored");

    const remote = personal.validateRemoteClaim({
      claimId: claim.claimId, ...personal.claimPayload(claim),
      photo: { status: "ready", sha256: converted.sha256, sizeBytes: converted.sizeBytes, contentType: converted.contentType },
    });
    await personal.commitRemotePage(owner, [remote], "rendition-cursor");
    expect((await personal.getPersonalPhoto(owner, claim.claimId))?.backupState).toBe("backed-up");
    expect(await personal.listPhotosNeedingDownload(owner)).toEqual([]);
    expect(await personal.listPersonalOutbox(owner)).toEqual([]);
    expect(await (await personal.getPersonalPhoto(owner, claim.claimId))?.blob.text()).toBe(await originalBlob.text());
  });

  it("does not project an older photo when the latest visit has no photo", async () => {
    const personal = await import("./personalStore");
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer], { type: "image/png" });
    await personal.createPersonalClaim({ kind: "guest" }, { park: park(), claimedAt: "2025-04-03T12:34:56.000Z", photo: png });
    await personal.createPersonalClaim({ kind: "guest" }, { park: park(), claimedAt: "2025-04-04T12:34:56.000Z" });
    expect(await personal.loadPersonalPhotos({ kind: "guest" })).toEqual({});
  });

  it("publishes guest claim metadata before delayed photo conversion finishes", async () => {
    const personal = await import("./personalStore");
    const owner = { kind: "guest" as const };
    const saved = await personal.createPersonalClaim(owner, { park: park(), photo: pngPhoto() });
    let releaseConversion!: () => void;
    let markConversionStarted!: () => void;
    let conversionStarted = false;
    const conversionGate = new Promise<void>((resolve) => { releaseConversion = resolve; });
    const started = new Promise<void>((resolve) => { markConversionStarted = resolve; });
    vi.stubGlobal("FileReader", class {
      result: string | null = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(blob: Blob) {
        conversionStarted = true;
        markConversionStarted();
        void conversionGate.then(async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          this.result = `data:${blob.type};base64,${btoa(binary)}`;
          this.onload?.();
        });
      }
    });

    let metadata: import("./personalStore").PersonalClaim[] = [];
    let markMetadataReady!: () => void;
    const metadataReady = new Promise<void>((resolve) => { markMetadataReady = resolve; });
    let settled = false;
    const hydration = personal.loadPersonalProgress(owner, (claims) => {
      metadata = claims;
      markMetadataReady();
    });
    void hydration.then(() => { settled = true; });

    await metadataReady;
    await started;
    expect(conversionStarted).toBe(true);
    expect(metadata.map((claim) => claim.claimId)).toEqual([saved.claimId]);
    expect(settled).toBe(false);

    releaseConversion();
    await expect(hydration).resolves.toMatchObject({ photos: expect.objectContaining({ "cedar-point": expect.stringMatching(/^data:image\/png;base64,/) }) });
  });

  it("publishes claim metadata even when photo conversion fails", async () => {
    const personal = await import("./personalStore");
    const owner = { kind: "account" as const, accountId: "89abcdef-1234-4234-8234-123456789abc" };
    const saved = await personal.createPersonalClaim(owner, { park: park(), photo: pngPhoto() });
    let metadata: import("./personalStore").PersonalClaim[] = [];
    vi.stubGlobal("FileReader", class {
      result: string | null = null;
      error: Error | null = new Error("Saved photo could not be read.");
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onerror?.()); }
    });

    await expect(personal.loadPersonalProgress(owner, (claims) => { metadata = claims; })).rejects.toThrow("Saved photo could not be read.");
    expect(metadata.map((claim) => claim.claimId)).toEqual([saved.claimId]);
  });

  it("lets only the first concurrent account reserve a guest claim and hides its guest projections", async () => {
    const personal = await import("./personalStore");
    const accountA = "89abcdef-1234-4234-8234-123456789abc";
    const accountB = "12345678-1234-4234-8234-123456789abc";
    const source = await personal.createPersonalClaim({ kind: "guest" }, {
      park: park(), claimedAt: "2025-04-03T12:34:56.000Z", photo: pngPhoto(),
    });

    const [reservedA, reservedB] = await Promise.all([
      personal.reserveGuestClaimsForAccount(accountA),
      personal.reserveGuestClaimsForAccount(accountB),
    ]);
    expect([reservedA, reservedB].sort()).toEqual([0, 1]);

    const ownerId = reservedA === 1 ? accountA : accountB;
    const otherId = ownerId === accountA ? accountB : accountA;
    const owner = { kind: "account" as const, accountId: ownerId };
    expect((await personal.listPersonalClaims(owner)).map((claim) => claim.claimId)).toEqual([source.claimId]);
    expect((await personal.listPersonalClaims({ kind: "account", accountId: otherId }))).toEqual([]);
    expect(await personal.listPersonalOutbox(owner)).toEqual([
      { ownerKey: `account:${ownerId}`, claimId: source.claimId, kind: "claim" },
      { ownerKey: `account:${ownerId}`, claimId: source.claimId, kind: "photo" },
    ]);
    expect(await personal.listPersonalClaims({ kind: "guest" })).toEqual([]);
    expect(await personal.listPersonalPhotos({ kind: "guest" })).toEqual([]);
    expect(await personal.loadPersonalPhotos({ kind: "guest" })).toEqual({});
    expect(await personal.getPersonalPhoto({ kind: "guest" }, source.claimId)).toBeNull();
    expect(await readPersonalValue("meta", `guest-reservation:${source.claimId}`)).toMatchObject({ value: ownerId });
    expect(await personal.reserveGuestClaimsForAccount(ownerId)).toBe(1);
  });

  it("finalizes acknowledged claims independently and retains each pending recovery row", async () => {
    const personal = await import("./personalStore");
    const accountId = "89abcdef-1234-4234-8234-123456789abc";
    const account = { kind: "account" as const, accountId };
    const first = await personal.createPersonalClaim({ kind: "guest" }, { park: park(), claimedAt: "2025-04-03T12:34:56.000Z" });
    const second = await personal.createPersonalClaim({ kind: "guest" }, { park: park(), claimedAt: "2025-04-04T12:34:56.000Z" });
    expect(await personal.reserveGuestClaimsForAccount(accountId)).toBe(2);
    expect(await personal.finalizeReservedGuestClaims(accountId)).toBe(0);
    expect(await readPersonalValue("claims", ["guest", first.claimId])).toBeDefined();
    expect(await readPersonalValue("claims", ["guest", second.claimId])).toBeDefined();

    const [accountFirst, accountSecond] = await personal.listPersonalClaims(account);
    await personal.markClaimUploaded(account, accountFirst.claimId, personal.claimPayload(accountFirst));
    expect(await personal.finalizeReservedGuestClaims(accountId)).toBe(1);
    expect(await readPersonalValue("claims", ["guest", first.claimId])).toBeUndefined();
    expect(await readPersonalValue("meta", `guest-reservation:${first.claimId}`)).toBeUndefined();
    expect(await readPersonalValue("claims", ["guest", second.claimId])).toBeDefined();
    expect(await readPersonalValue("meta", `guest-reservation:${second.claimId}`)).toMatchObject({ value: accountId });

    await personal.markClaimUploaded(account, accountSecond.claimId, personal.claimPayload(accountSecond));
    expect(await personal.finalizeReservedGuestClaims(accountId)).toBe(1);
    expect(await readPersonalValue("claims", ["guest", second.claimId])).toBeUndefined();
  });

  it("retains a supported guest photo until the matching account photo is backed up", async () => {
    const personal = await import("./personalStore");
    const accountId = "89abcdef-1234-4234-8234-123456789abc";
    const account = { kind: "account" as const, accountId };
    const source = await personal.createPersonalClaim({ kind: "guest" }, {
      park: park(), claimedAt: "2025-04-03T12:34:56.000Z", photo: pngPhoto(),
    });
    expect(await personal.reserveGuestClaimsForAccount(accountId)).toBe(1);
    const accountClaim = (await personal.listPersonalClaims(account))[0];
    const accountPhoto = await personal.getPersonalPhoto(account, source.claimId);
    expect(accountPhoto?.backupState).toBe("pending");
    await personal.markClaimUploaded(account, source.claimId, personal.claimPayload(accountClaim));
    expect(await personal.finalizeReservedGuestClaims(accountId)).toBe(0);
    expect(await readPersonalValue("claims", ["guest", source.claimId])).toBeDefined();
    expect(await readPersonalValue("photos", ["guest", source.claimId])).toBeDefined();

    await personal.markPhotoUploaded(account, source.claimId, accountPhoto!.sha256);
    expect(await personal.finalizeReservedGuestClaims(accountId)).toBe(1);
    expect(await readPersonalValue("claims", ["guest", source.claimId])).toBeUndefined();
    expect(await readPersonalValue("photos", ["guest", source.claimId])).toBeUndefined();
    expect((await personal.getPersonalPhoto(account, source.claimId))?.backupState).toBe("backed-up");
  });

  it("preserves a prior account owner for duplicate claim IDs and fails closed on conflicts", async () => {
    const personal = await import("./personalStore");
    const accountId = "89abcdef-1234-4234-8234-123456789abc";
    const otherAccountId = "12345678-1234-4234-8234-123456789abc";
    const account = { kind: "account" as const, accountId };
    const source = await personal.createPersonalClaim({ kind: "guest" }, { park: park(), claimedAt: "2025-04-03T12:34:56.000Z" });
    await mutatePersonalDatabase((tx) => {
      tx.objectStore("claims").put({ ...source, ownerKey: `account:${accountId}`, syncState: "acknowledged" });
    });

    expect(await personal.reserveGuestClaimsForAccount(otherAccountId)).toBe(0);
    expect(await personal.listPersonalClaims({ kind: "guest" })).toEqual([]);
    expect(await readPersonalValue("meta", `guest-reservation:${source.claimId}`)).toMatchObject({ value: accountId });
    expect(await personal.listPersonalClaims({ kind: "account", accountId: otherAccountId })).toEqual([]);
    expect(await personal.reserveGuestClaimsForAccount(accountId)).toBe(1);
    const prior = (await personal.listPersonalClaims(account))[0];
    expect(prior).toMatchObject({ ownerKey: `account:${accountId}`, claimId: source.claimId, syncState: "acknowledged" });
    expect(await personal.listPersonalOutbox(account)).toEqual([]);
    expect(await personal.finalizeReservedGuestClaims(accountId)).toBe(1);
    expect(await readPersonalValue("claims", ["guest", source.claimId])).toBeUndefined();

    const conflictingGuest = await personal.createPersonalClaim({ kind: "guest" }, { park: park("cedar-point-2"), claimedAt: "2025-04-05T12:34:56.000Z" });
    await mutatePersonalDatabase((tx) => {
      tx.objectStore("claims").put({ ...conflictingGuest, ownerKey: `account:${accountId}`, claimedAt: "2025-04-06T12:34:56.000Z" });
    });
    await expect(personal.reserveGuestClaimsForAccount(accountId)).rejects.toBeInstanceOf(personal.PersonalClaimConflictError);
    expect((await personal.listPersonalClaims({ kind: "guest" })).map((claim) => claim.claimId)).toContain(conflictingGuest.claimId);
    expect(await readPersonalValue("meta", `guest-reservation:${conflictingGuest.claimId}`)).toBeUndefined();

    const ambiguousGuest = await personal.createPersonalClaim({ kind: "guest" }, { park: park("cedar-point-3"), claimedAt: "2025-04-07T12:34:56.000Z" });
    await mutatePersonalDatabase((tx) => {
      tx.objectStore("claims").put({ ...ambiguousGuest, ownerKey: `account:${accountId}` });
      tx.objectStore("claims").put({ ...ambiguousGuest, ownerKey: `account:${otherAccountId}` });
    });
    await expect(personal.reserveGuestClaimsForAccount(accountId)).rejects.toBeInstanceOf(personal.PersonalClaimConflictError);
    expect((await personal.listPersonalClaims({ kind: "guest" })).map((claim) => claim.claimId)).toContain(ambiguousGuest.claimId);
    expect(await readPersonalValue("meta", `guest-reservation:${ambiguousGuest.claimId}`)).toBeUndefined();
  });

  it("stores successful backup timestamps per account and releases guest recovery rows after deletion", async () => {
    const personal = await import("./personalStore");
    const accountA = "89abcdef-1234-4234-8234-123456789abc";
    const accountB = "12345678-1234-4234-8234-123456789abc";
    expect(await personal.getLastSuccessfulBackupAt(accountA)).toBeNull();
    expect(await personal.getLastSuccessfulBackupAt(accountB)).toBeNull();
    await personal.setLastSuccessfulBackupAt(accountA, 1_735_689_600_000);
    await personal.setLastSuccessfulBackupAt(accountA, 1_735_689_500_000);
    await personal.setLastSuccessfulBackupAt(accountB, 1_735_689_700_000);
    expect(await personal.getLastSuccessfulBackupAt(accountA)).toBe(1_735_689_600_000);
    expect(await personal.getLastSuccessfulBackupAt(accountB)).toBe(1_735_689_700_000);

    const source = await personal.createPersonalClaim({ kind: "guest" }, {
      park: park(), claimedAt: "2025-04-03T12:34:56.000Z", photo: pngPhoto(),
    });
    await personal.reserveGuestClaimsForAccount(accountA);
    expect(await personal.listPersonalClaims({ kind: "guest" })).toEqual([]);
    await personal.clearAccountProgressAfterServerDeletion(accountA);

    expect(await personal.listPersonalClaims({ kind: "account", accountId: accountA })).toEqual([]);
    expect(await personal.getLastSuccessfulBackupAt(accountA)).toBeNull();
    expect(await personal.getLastSuccessfulBackupAt(accountB)).toBe(1_735_689_700_000);
    expect(await readPersonalValue("meta", `guest-reservation:${source.claimId}`)).toBeUndefined();
    expect(await readPersonalValue("claims", ["guest", source.claimId])).toBeUndefined();
    expect(await readPersonalValue("photos", ["guest", source.claimId])).toBeUndefined();
    expect(await personal.listPersonalClaims({ kind: "guest" })).toEqual([]);
  });

  it("keeps a photo's crop beside the original and re-crops without touching the photo or its backup", async () => {
    const personal = await import("./personalStore");
    const accountId = "89abcdef-1234-4234-8234-123456789abc";
    const account = { kind: "account" as const, accountId };
    const crop = { x: 0.21875, y: 0, width: 0.5625, height: 1 };
    const claim = await personal.createPersonalClaim(account, { park: park(), photo: pngPhoto(), crop });
    const saved = await personal.getPersonalPhoto(account, claim.claimId);
    expect(saved?.crop).toEqual(crop);
    expect(saved?.backupState).toBe("pending");

    const recrop = { x: 0.5, y: 0.25, width: 0.28125, height: 0.5 };
    expect(await personal.setPersonalPhotoCrop(account, claim.claimId, recrop)).toBe(true);
    const recropped = await personal.getPersonalPhoto(account, claim.claimId);
    expect(recropped?.crop).toEqual(recrop);
    expect(recropped?.sha256).toBe(saved?.sha256);
    expect(recropped?.backupState).toBe("pending");
    expect(await personal.listPersonalOutbox(account)).toHaveLength(2);

    expect(await personal.setPersonalPhotoCrop(account, claim.claimId, null)).toBe(true);
    expect((await personal.getPersonalPhoto(account, claim.claimId))?.crop).toBeNull();
    expect(await personal.setPersonalPhotoCrop(account, "00000000-0000-4000-8000-000000000000", recrop)).toBe(false);
  });

  it("refuses a crop outside the photo or without a photo", async () => {
    const personal = await import("./personalStore");
    const outside = { x: 0.6, y: 0, width: 0.5625, height: 1 };
    await expect(personal.createPersonalClaim({ kind: "guest" }, { park: park(), photo: pngPhoto(), crop: outside })).rejects.toThrow(/crop/);
    await expect(personal.createPersonalClaim({ kind: "guest" }, { park: park(), crop: { x: 0, y: 0, width: 1, height: 1 } })).rejects.toThrow(/crop/);
    const claim = await personal.createPersonalClaim({ kind: "guest" }, { park: park(), photo: pngPhoto() });
    expect((await personal.getPersonalPhoto({ kind: "guest" }, claim.claimId))?.crop).toBeUndefined();
    await expect(personal.setPersonalPhotoCrop({ kind: "guest" }, claim.claimId, outside)).rejects.toThrow(/crop/);
  });

  it("carries a guest photo's crop to the account copy", async () => {
    const personal = await import("./personalStore");
    const accountId = "89abcdef-1234-4234-8234-123456789abc";
    const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
    const source = await personal.createPersonalClaim({ kind: "guest" }, { park: park(), photo: pngPhoto(), crop });
    expect(await personal.reserveGuestClaimsForAccount(accountId)).toBe(1);
    expect((await personal.getPersonalPhoto({ kind: "account", accountId }, source.claimId))?.crop).toEqual(crop);
    // The reserved guest row is hidden, so it cannot be re-cropped behind the account's back.
    expect(await personal.setPersonalPhotoCrop({ kind: "guest" }, source.claimId, null)).toBe(false);
  });

  it("keeps several photos per park with cover and removal choices, queued for display backup", async () => {
    const personal = await import("./personalStore");
    const account = { kind: "account" as const, accountId: "89abcdef-1234-4234-8234-123456789abc" };
    const first = await personal.createPersonalClaim(account, { park: park(), photo: pngPhoto(), claimedAt: "2026-06-01T17:00:00.000Z" });
    const crop = { x: 0.1, y: 0, width: 0.5625, height: 1 };
    const second = await personal.createPersonalClaim(account, { park: park(), photo: pngPhoto(), crop, claimedAt: "2026-06-03T17:00:00.000Z" });
    expect((await personal.listPersonalClaims(account)).filter((claim) => claim.parkId === park().id)).toHaveLength(2);

    // A photo without choices has nothing to back up; a cropped one does.
    expect((await personal.listPendingPhotoDisplays(account)).map((item) => item.claimId)).toEqual([second.claimId]);
    expect(await personal.setPersonalPhotoCover(account, first.claimId, "2026-06-04T10:00:00.000Z")).toBe(true);
    const covered = await personal.getPersonalPhoto(account, first.claimId);
    expect(covered).toMatchObject({ coverAt: "2026-06-04T10:00:00.000Z", backupState: "pending" });
    const pending = await personal.listPendingPhotoDisplays(account);
    expect(pending.find((item) => item.claimId === first.claimId)?.display).toEqual({ crop: null, coverAt: "2026-06-04T10:00:00.000Z", removed: false });

    // Backing up version 1 while the player changes it again keeps the newer change pending.
    const sent = pending.find((item) => item.claimId === first.claimId)!;
    expect(await personal.removePersonalPhoto(account, first.claimId)).toBe(true);
    expect(await personal.markPhotoDisplaySynced(account, first.claimId, sent.version)).toBe(true);
    const removed = await personal.getPersonalPhoto(account, first.claimId);
    expect(removed).toMatchObject({ removed: true, coverAt: null });
    expect(personal.photoDisplayPending(removed!)).toBe(true);
    expect(removed?.sha256).toBe(covered?.sha256);
    const latest = (await personal.listPendingPhotoDisplays(account)).find((item) => item.claimId === first.claimId)!;
    await personal.markPhotoDisplaySynced(account, first.claimId, latest.version);
    expect(personal.photoDisplayPending((await personal.getPersonalPhoto(account, first.claimId))!)).toBe(false);
    expect(await personal.setPersonalPhotoCover(account, "00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("restores backed-up display choices without overwriting choices not yet backed up", async () => {
    const personal = await import("./personalStore");
    const account = { kind: "account" as const, accountId: "89abcdef-1234-4234-8234-123456789abc" };
    const restored = await personal.createPersonalClaim(account, { park: park(), photo: pngPhoto() });
    const edited = await personal.createPersonalClaim(account, { park: park(), photo: pngPhoto() });
    await personal.setPersonalPhotoCover(account, edited.claimId, "2026-06-05T10:00:00.000Z");
    const crop = { x: 0, y: 0.125, width: 1, height: 0.75 };
    const changed = await personal.applyRemotePhotoDisplays(account, [
      { claimId: restored.claimId.toUpperCase(), crop, coverAt: "2026-06-04T10:00:00.000Z", removed: false, updatedAt: "2026-06-04T10:00:00.000Z" },
      { claimId: edited.claimId, crop, coverAt: null, removed: true, updatedAt: "2026-06-04T10:00:00.000Z" },
      { claimId: "00000000-0000-4000-8000-000000000000", crop, coverAt: null, removed: true, updatedAt: "2026-06-04T10:00:00.000Z" },
    ]);
    expect(changed).toBe(1);
    const restoredPhoto = await personal.getPersonalPhoto(account, restored.claimId);
    expect(restoredPhoto).toMatchObject({ crop, coverAt: "2026-06-04T10:00:00.000Z", removed: false });
    expect(personal.photoDisplayPending(restoredPhoto!)).toBe(false);
    expect(await personal.getPersonalPhoto(account, edited.claimId)).toMatchObject({ coverAt: "2026-06-05T10:00:00.000Z", removed: false });
  });

  it("does not return claim success when durable storage is unavailable", async () => {
    const personal = await import("./personalStore");
    const old = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    await expect(personal.createPersonalClaim({ kind: "guest" }, { park: park() })).rejects.toThrow();
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: old });
  });
});
