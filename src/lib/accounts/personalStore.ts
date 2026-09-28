import type { Park } from "../parks";

const DATABASE = "parkdex-personal-v1";
const DATABASE_VERSION = 1;
const CLAIMS = "claims";
const PHOTOS = "photos";
const OUTBOX = "outbox";
const META = "meta";
const LEGACY_KEY = "parkdex-mockup-v1";
const LEGACY_DATABASE = "parkdex";
const LEGACY_PHOTOS = "photos";
const LEGACY_MIGRATION_KEY = "legacy:parkdex-mockup-v1";
export const MAX_BACKUP_PHOTO_BYTES = 2_621_440;

export type ProgressOwner = { kind: "guest" } | { kind: "account"; accountId: string };
export type PhotoBackupState = "pending" | "backed-up" | "unsupported" | "conflict";
export type RemotePhoto =
  | { status: "missing" | "pending" }
  | { status: "ready"; sha256: string; sizeBytes: number; contentType: SupportedPhotoType };
export type SupportedPhotoType = "image/jpeg" | "image/png" | "image/webp";

export type PersonalClaim = {
  ownerKey: string;
  claimId: string;
  parkId: string;
  claimedAt: string;
  parkSnapshot: Park | null;
  contentReleaseId: string | null;
  syncState: "local" | "pending" | "acknowledged";
  photoIssue: "corrupt" | null;
  remotePhoto: RemotePhoto;
};

export type PersonalPhoto = {
  ownerKey: string;
  claimId: string;
  blob: Blob;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  backupState: PhotoBackupState;
  unsupportedReason: "type" | "size" | "magic" | null;
};

export type ClaimUploadPayload = {
  parkId: string;
  claimedAt: string;
  parkSnapshot: Park;
  contentReleaseId: string | null;
};

export type RemoteClaim = ClaimUploadPayload & {
  claimId: string;
  photo: RemotePhoto;
};

type ClaimOutbox = { ownerKey: string; claimId: string; kind: "claim" };
type PhotoOutbox = { ownerKey: string; claimId: string; kind: "photo" };
type Outbox = ClaimOutbox | PhotoOutbox;
type Meta = { key: string; value: unknown };
type LocalStorageLike = Pick<Storage, "getItem" | "setItem">;
type LegacyMigrationManifest = { complete: true; parkIds: string[]; photoParkIds: string[] };

export class PersonalClaimConflictError extends Error {
  constructor(message = "A saved claim with this ID has different immutable details.") {
    super(message);
    this.name = "PersonalClaimConflictError";
  }
}

export class PersonalStoreUnavailableError extends Error {
  constructor(message = "Personal progress storage is unavailable.") {
    super(message);
    this.name = "PersonalStoreUnavailableError";
  }
}

export function ownerKey(owner: ProgressOwner): string {
  if (owner.kind === "guest") return "guest";
  if (!isUuid(owner.accountId)) throw new Error("Invalid account ID for personal progress.");
  return `account:${owner.accountId.toLowerCase()}`;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function makeUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new PersonalStoreUnavailableError("Secure random IDs are unavailable.");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function freezeParkSnapshot(park: Park): Park {
  if (!park || typeof park !== "object" || typeof park.id !== "string" || !park.id.trim()) {
    throw new Error("A park snapshot is required to save progress.");
  }
  const stringField = (value: unknown, name: string, max: number) => {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw new Error(`Invalid park snapshot field: ${name}.`);
    }
    return value.trim();
  };
  const numberField = (value: unknown, name: string) => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid park snapshot field: ${name}.`);
    return value;
  };
  const biome = ["coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"] as const;
  const shape = ["circle", "hex", "shield", "arch", "seal"] as const;
  const rarity = ["common", "uncommon", "rare", "epic", "legendary"] as const;
  const category = ["national", "provincial", "regional"] as const;
  if (!(biome as readonly unknown[]).includes(park.biome) || !(shape as readonly unknown[]).includes(park.shape) ||
      !(rarity as readonly unknown[]).includes(park.rarity) || !(category as readonly unknown[]).includes(park.category)) {
    throw new Error("Invalid park snapshot category.");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(park.id) || (park.scene !== null && (typeof park.scene !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(park.scene)))) {
    throw new Error("Invalid park snapshot identifier.");
  }
  const lat = numberField(park.lat, "lat");
  const lng = numberField(park.lng, "lng");
  const seed = numberField(park.seed, "seed");
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || !Number.isSafeInteger(seed) || seed < 0 || seed > 1_000_000) {
    throw new Error("Invalid park snapshot coordinates or seed.");
  }
  return {
    id: stringField(park.id, "id", 160),
    name: stringField(park.name, "name", 140),
    short: stringField(park.short, "short", 140),
    category: park.category,
    region: stringField(park.region, "region", 140),
    lat,
    lng,
    biome: park.biome,
    shape: park.shape,
    rarity: park.rarity,
    seed,
    blurb: stringField(park.blurb, "blurb", 800),
    scene: park.scene === null ? null : stringField(park.scene, "scene", 80),
  };
}

export function claimPayload(claim: Pick<PersonalClaim, "parkId" | "claimedAt" | "parkSnapshot" | "contentReleaseId">): ClaimUploadPayload {
  if (!claim.parkSnapshot) throw new Error("Park details are unavailable for this saved claim.");
  return {
    parkId: claim.parkId,
    claimedAt: claim.claimedAt,
    parkSnapshot: freezeParkSnapshot(claim.parkSnapshot),
    contentReleaseId: claim.contentReleaseId,
  };
}

function validClaimedAt(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function normalizeReleaseId(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("Invalid content release ID.");
  return value;
}

function normalizeClaimedAt(value: string): string {
  if (!validClaimedAt(value)) throw new Error("Invalid claim time.");
  const normalized = new Date(value).toISOString();
  if (Date.parse(normalized) > Date.now() + 10 * 60 * 1000) throw new Error("Claim time cannot be in the future.");
  return normalized;
}

function database(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new PersonalStoreUnavailableError());
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CLAIMS)) {
        const claims = db.createObjectStore(CLAIMS, { keyPath: ["ownerKey", "claimId"] });
        claims.createIndex("byOwner", "ownerKey", { unique: false });
      }
      if (!db.objectStoreNames.contains(PHOTOS)) {
        const photos = db.createObjectStore(PHOTOS, { keyPath: ["ownerKey", "claimId"] });
        photos.createIndex("byOwner", "ownerKey", { unique: false });
      }
      if (!db.objectStoreNames.contains(OUTBOX)) {
        const outbox = db.createObjectStore(OUTBOX, { keyPath: ["ownerKey", "claimId", "kind"] });
        outbox.createIndex("byOwner", "ownerKey", { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new PersonalStoreUnavailableError());
    request.onblocked = () => reject(new PersonalStoreUnavailableError("Personal progress storage is blocked by another open session."));
  });
}

function transaction<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, complete: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let value: T;
    let hasValue = false;
    let failure: unknown;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (error) {
      reject(error);
      return;
    }
    const complete = (result: T) => { value = result; hasValue = true; };
    const fail = (error: unknown) => {
      failure = error;
      try { tx.abort(); } catch { reject(error); }
    };
    tx.oncomplete = () => {
      if (failure !== undefined) reject(failure);
      else if (hasValue) resolve(value);
      else reject(new Error("Personal progress transaction completed without a result."));
    };
    tx.onerror = () => reject(failure ?? tx.error ?? new PersonalStoreUnavailableError());
    tx.onabort = () => reject(failure ?? tx.error ?? new PersonalStoreUnavailableError("Personal progress transaction was aborted."));
    try { work(tx, complete, fail); } catch (error) { fail(error); }
  });
}

function withDatabase<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  return database().then(async (db) => {
    try { return await work(db); }
    finally { db.close(); }
  });
}

function legacyLocalStorage(): LocalStorageLike {
  try {
    if (!globalThis.localStorage) throw new PersonalStoreUnavailableError("Legacy local storage is unavailable.");
    return globalThis.localStorage;
  } catch (error) {
    throw error instanceof Error ? error : new PersonalStoreUnavailableError("Legacy local storage is unavailable.");
  }
}

function readLegacyClaims(storage: LocalStorageLike): Record<string, { at: string }> {
  const raw = storage.getItem(LEGACY_KEY);
  if (!raw) return {};
  let saved: unknown;
  try { saved = JSON.parse(raw); }
  catch { throw new Error("Saved progress could not be read. Existing data was left untouched."); }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  const claims = (saved as { claims?: unknown }).claims;
  if (claims == null) return {};
  if (typeof claims !== "object" || Array.isArray(claims)) throw new Error("Saved progress claims are invalid. Existing data was left untouched.");
  const parsed: Record<string, { at: string }> = {};
  for (const [parkId, rawClaim] of Object.entries(claims)) {
    if (!parkId.trim() || parkId.length > 160 || !rawClaim || typeof rawClaim !== "object" || Array.isArray(rawClaim)) {
      throw new Error("A saved progress record is invalid. Existing data was left untouched.");
    }
    const at = (rawClaim as { at?: unknown }).at;
    if (!validClaimedAt(at)) throw new Error("A saved claim time is invalid. Existing data was left untouched.");
    parsed[parkId] = { at };
  }
  return parsed;
}

function readLegacyPhotos(): Promise<Record<string, unknown>> {
  if (!globalThis.indexedDB) return Promise.reject(new PersonalStoreUnavailableError());
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(LEGACY_DATABASE);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(LEGACY_PHOTOS)) open.result.createObjectStore(LEGACY_PHOTOS);
    };
    open.onerror = () => reject(open.error ?? new PersonalStoreUnavailableError());
    open.onblocked = () => reject(new PersonalStoreUnavailableError("Legacy photo storage is blocked by another open session."));
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(LEGACY_PHOTOS)) { db.close(); resolve({}); return; }
      let tx: IDBTransaction;
      try { tx = db.transaction(LEGACY_PHOTOS, "readonly"); }
      catch (error) { db.close(); reject(error); return; }
      const photos: Record<string, unknown> = {};
      const request = tx.objectStore(LEGACY_PHOTOS).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        photos[String(cursor.key)] = cursor.value;
        cursor.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(photos); };
      tx.onerror = () => { db.close(); reject(tx.error ?? new PersonalStoreUnavailableError()); };
      tx.onabort = () => { db.close(); reject(tx.error ?? new PersonalStoreUnavailableError()); };
    };
  });
}

function isLegacyMigrationManifest(value: unknown): value is LegacyMigrationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return manifest.complete === true && Array.isArray(manifest.parkIds) && manifest.parkIds.every((id) => typeof id === "string") &&
    Array.isArray(manifest.photoParkIds) && manifest.photoParkIds.every((id) => typeof id === "string");
}

async function readLegacyMigrationStatus(): Promise<{ complete: boolean; manifest: LegacyMigrationManifest | null }> {
  return withDatabase((db) => transaction<{ complete: boolean; manifest: LegacyMigrationManifest | null }>(db, META, "readonly", (tx, complete, fail) => {
    const request = tx.objectStore(META).get(LEGACY_MIGRATION_KEY) as IDBRequest<Meta | undefined>;
    request.onsuccess = () => complete({
      complete: request.result?.value === true || isLegacyMigrationManifest(request.result?.value),
      manifest: isLegacyMigrationManifest(request.result?.value) ? request.result.value : null,
    });
    request.onerror = () => fail(request.error);
  }));
}

async function cleanupLegacySources(manifest: LegacyMigrationManifest, storage?: LocalStorageLike): Promise<void> {
  if (storage) {
    try {
      const raw = storage.getItem(LEGACY_KEY);
      if (raw) {
        const saved: unknown = JSON.parse(raw);
        if (saved && typeof saved === "object" && !Array.isArray(saved)) {
          const record = saved as Record<string, unknown>;
          if (record.claims && typeof record.claims === "object" && !Array.isArray(record.claims)) {
            const claims = { ...(record.claims as Record<string, unknown>) };
            for (const parkId of manifest.parkIds) delete claims[parkId];
            record.claims = claims;
            storage.setItem(LEGACY_KEY, JSON.stringify(record));
          }
        }
      }
    } catch { /* The committed local copy remains authoritative; cleanup can be retried next startup. */ }
  }
  if (manifest.photoParkIds.length === 0 || !globalThis.indexedDB) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DATABASE);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Legacy photo cleanup is blocked."));
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(LEGACY_PHOTOS)) { db.close(); resolve(); return; }
        try {
          const tx = db.transaction(LEGACY_PHOTOS, "readwrite");
          const photos = tx.objectStore(LEGACY_PHOTOS);
          for (const parkId of manifest.photoParkIds) photos.delete(parkId);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        } catch (error) { db.close(); reject(error); }
      };
    });
  } catch { /* Cleanup is idempotent and retried after the migration marker is read again. */ }
}

function dataUrlToBlob(dataUrl: string): Blob {
  // `;utf8` is a legacy marker used by the old web camera for SVG captures.
  // Keep accepting only this known parameter plus the standard base64 marker.
  const match = /^data:([^;,]*)(;base64|;utf8)?,([\s\S]*)$/i.exec(dataUrl);
  if (!match) throw new Error("Saved photo is not a data URL.");
  const contentType = match[1] || "text/plain";
  if (match[2]?.toLowerCase() === ";base64") {
    const binary = atob(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: contentType });
  }
  return new Blob([decodeURIComponent(match[3])], { type: contentType });
}

async function asBlob(value: unknown): Promise<Blob> {
  if (value instanceof Blob) return value;
  if (typeof value === "string") return dataUrlToBlob(value);
  throw new Error("Saved photo data is invalid.");
}

async function sha256Blob(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new PersonalStoreUnavailableError("Photo integrity checks are unavailable.");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function supportedPhotoType(value: string): value is SupportedPhotoType {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

async function photoEligibility(blob: Blob): Promise<{ supported: boolean; reason: PersonalPhoto["unsupportedReason"] }> {
  if (!supportedPhotoType(blob.type.toLowerCase())) return { supported: false, reason: "type" };
  if (blob.size <= 0 || blob.size > MAX_BACKUP_PHOTO_BYTES) return { supported: false, reason: "size" };
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  const matches = blob.type.toLowerCase() === "image/jpeg" ? jpeg : blob.type.toLowerCase() === "image/png" ? png : webp;
  return matches ? { supported: true, reason: null } : { supported: false, reason: "magic" };
}

async function preparePhoto(owner: ProgressOwner, claimId: string, blob: Blob): Promise<PersonalPhoto> {
  const eligibility = await photoEligibility(blob);
  return {
    ownerKey: ownerKey(owner), claimId, blob, contentType: blob.type.toLowerCase(), sizeBytes: blob.size,
    sha256: await sha256Blob(blob), backupState: eligibility.supported ? "pending" : "unsupported",
    unsupportedReason: eligibility.reason,
  };
}

let initialized: Promise<void> | null = null;

/** Migrate current tester data once, then remove only the source claims/photos now durably copied. */
export function initializePersonalStore(): Promise<void> {
  if (!initialized) initialized = migrateLegacyProgress().catch((error) => { initialized = null; throw error; });
  return initialized;
}

async function migrateLegacyProgress(): Promise<void> {
  const migrationStatus = await readLegacyMigrationStatus();
  if (migrationStatus.complete) {
    let storage: LocalStorageLike | undefined;
    try { storage = legacyLocalStorage(); } catch { /* New progress is already committed. */ }
    if (migrationStatus.manifest) await cleanupLegacySources(migrationStatus.manifest, storage);
    return;
  }
  const storage = legacyLocalStorage();
  const legacyClaims = readLegacyClaims(storage);
  const legacyPhotos = await readLegacyPhotos();
  const owner: ProgressOwner = { kind: "guest" };
  const records: Array<{ claim: PersonalClaim; photo: PersonalPhoto | null }> = [];
  for (const [parkId, legacy] of Object.entries(legacyClaims)) {
    const claimId = makeUuid();
    let photo: PersonalPhoto | null = null;
    let photoIssue: PersonalClaim["photoIssue"] = null;
    if (Object.hasOwn(legacyPhotos, parkId)) {
      try { photo = await preparePhoto(owner, claimId, await asBlob(legacyPhotos[parkId])); }
      catch { photoIssue = "corrupt"; }
    }
    records.push({
      claim: {
        ownerKey: "guest", claimId, parkId, claimedAt: normalizeClaimedAt(legacy.at), parkSnapshot: null, contentReleaseId: null,
        syncState: "local", photoIssue, remotePhoto: { status: "missing" },
      },
      photo,
    });
  }
  const manifest: LegacyMigrationManifest = {
    complete: true,
    parkIds: records.map(({ claim }) => claim.parkId),
    photoParkIds: records.flatMap(({ claim, photo }) => photo && !claim.photoIssue ? [claim.parkId] : []),
  };
  await withDatabase((db) => transaction(db, [CLAIMS, PHOTOS, META], "readwrite", (tx, complete, fail) => {
    const meta = tx.objectStore(META);
    const markerRequest = meta.get(LEGACY_MIGRATION_KEY) as IDBRequest<Meta | undefined>;
    markerRequest.onsuccess = () => {
      if (markerRequest.result?.value === true || isLegacyMigrationManifest(markerRequest.result?.value)) { complete(undefined); return; }
      for (const item of records) {
        tx.objectStore(CLAIMS).put(item.claim);
        if (item.photo) tx.objectStore(PHOTOS).put(item.photo);
      }
      meta.put({ key: LEGACY_MIGRATION_KEY, value: manifest } satisfies Meta);
      complete(undefined);
    };
    markerRequest.onerror = () => fail(markerRequest.error);
  }));
  await cleanupLegacySources(manifest, storage);
}

export type CreatePersonalClaimInput = {
  park: Park;
  claimedAt?: string;
  contentReleaseId?: string | null;
  photo?: Blob | string | null;
};

/** The resolved promise means claim metadata, local photo, and account outbox committed together. */
export async function createPersonalClaim(owner: ProgressOwner, input: CreatePersonalClaimInput): Promise<PersonalClaim> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  const parkSnapshot = freezeParkSnapshot(input.park);
  const claimedAt = normalizeClaimedAt(input.claimedAt ?? new Date().toISOString());
  const contentReleaseId = normalizeReleaseId(input.contentReleaseId);
  const claimId = makeUuid();
  const row: PersonalClaim = {
    ownerKey: key, claimId, parkId: parkSnapshot.id, claimedAt, parkSnapshot, contentReleaseId,
    syncState: owner.kind === "guest" ? "local" : "pending", photoIssue: null, remotePhoto: { status: "missing" },
  };
  let photo: PersonalPhoto | null = null;
  if (input.photo != null) photo = await preparePhoto(owner, claimId, typeof input.photo === "string" ? dataUrlToBlob(input.photo) : input.photo);
  await withDatabase((db) => transaction(db, [CLAIMS, PHOTOS, OUTBOX], "readwrite", (tx, complete, fail) => {
    const claims = tx.objectStore(CLAIMS);
    const request = claims.get([key, claimId]);
    request.onsuccess = () => {
      if (request.result) { fail(new PersonalClaimConflictError("A generated claim ID already exists.")); return; }
      claims.add(row);
      if (photo) {
        tx.objectStore(PHOTOS).add(photo);
        if (owner.kind === "account" && photo.backupState === "pending") {
          tx.objectStore(OUTBOX).add({ ownerKey: key, claimId, kind: "photo" } satisfies PhotoOutbox);
        }
      }
      if (owner.kind === "account") tx.objectStore(OUTBOX).add({ ownerKey: key, claimId, kind: "claim" } satisfies ClaimOutbox);
      complete(row);
    };
    request.onerror = () => fail(request.error);
  }));
  return row;
}

export async function listPersonalClaims(owner: ProgressOwner): Promise<PersonalClaim[]> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  return withDatabase((db) => transaction(db, CLAIMS, "readonly", (tx, complete, fail) => {
    const request = tx.objectStore(CLAIMS).index("byOwner").getAll(IDBKeyRange.only(key));
    request.onsuccess = () => complete((request.result as PersonalClaim[]).sort((a, b) => a.claimedAt.localeCompare(b.claimedAt) || a.claimId.localeCompare(b.claimId)));
    request.onerror = () => fail(request.error);
  }));
}

export async function listPersonalPhotos(owner: ProgressOwner): Promise<PersonalPhoto[]> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  return withDatabase((db) => transaction(db, PHOTOS, "readonly", (tx, complete, fail) => {
    const request = tx.objectStore(PHOTOS).index("byOwner").getAll(IDBKeyRange.only(key));
    request.onsuccess = () => complete(request.result as PersonalPhoto[]);
    request.onerror = () => fail(request.error);
  }));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Saved photo could not be read."));
    reader.readAsDataURL(blob);
  });
}

/** Project each park to its most recent locally available claim photo for the current collection UI. */
export async function loadPersonalPhotos(owner: ProgressOwner): Promise<Record<string, string>> {
  const [claims, photos] = await Promise.all([listPersonalClaims(owner), listPersonalPhotos(owner)]);
  const photosByClaim = new Map(photos.map((photo) => [photo.claimId, photo]));
  const out: Record<string, string> = {};
  const visited = new Set<string>();
  const newest = [...claims].reverse();
  for (const claim of newest) {
    if (visited.has(claim.parkId)) continue;
    visited.add(claim.parkId);
    const photo = photosByClaim.get(claim.claimId);
    if (photo) out[claim.parkId] = await blobToDataUrl(photo.blob);
  }
  return out;
}

export async function getPersonalPhoto(owner: ProgressOwner, claimId: string): Promise<PersonalPhoto | null> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  return withDatabase((db) => transaction<PersonalPhoto | null>(db, PHOTOS, "readonly", (tx, complete, fail) => {
    const request = tx.objectStore(PHOTOS).get([key, claimId]);
    request.onsuccess = () => complete((request.result as PersonalPhoto | undefined) ?? null);
    request.onerror = () => fail(request.error);
  }));
}

/** A legacy claim can be backed up only once a real frozen snapshot is available. */
export async function setLegacyClaimSnapshot(owner: ProgressOwner, claimId: string, park: Park, releaseId?: string | null): Promise<void> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  const snapshot = freezeParkSnapshot(park);
  const contentReleaseId = normalizeReleaseId(releaseId);
  await withDatabase((db) => transaction(db, [CLAIMS, OUTBOX], "readwrite", (tx, complete, fail) => {
    const claims = tx.objectStore(CLAIMS);
    const request = claims.get([key, claimId]);
    request.onsuccess = () => {
      const row = request.result as PersonalClaim | undefined;
      if (!row) { fail(new Error("Saved claim could not be found.")); return; }
      if (row.parkId !== snapshot.id) { fail(new PersonalClaimConflictError("The supplied park snapshot does not match the saved claim.")); return; }
      if (row.parkSnapshot) {
        if (!samePayload(row, { parkId: row.parkId, claimedAt: row.claimedAt, parkSnapshot: snapshot, contentReleaseId })) {
          fail(new PersonalClaimConflictError("A frozen park snapshot cannot be changed."));
          return;
        }
        complete(undefined);
        return;
      }
      if (row.syncState === "acknowledged") { fail(new PersonalClaimConflictError("An acknowledged claim cannot change its snapshot.")); return; }
      row.parkSnapshot = snapshot;
      row.contentReleaseId = contentReleaseId;
      if (owner.kind === "account") {
        row.syncState = "pending";
        tx.objectStore(OUTBOX).put({ ownerKey: key, claimId, kind: "claim" } satisfies ClaimOutbox);
      }
      claims.put(row);
      complete(undefined);
    };
    request.onerror = () => fail(request.error);
  }));
}

export async function listPersonalOutbox(owner: ProgressOwner): Promise<Outbox[]> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  return withDatabase((db) => transaction(db, OUTBOX, "readonly", (tx, complete, fail) => {
    const request = tx.objectStore(OUTBOX).index("byOwner").getAll(IDBKeyRange.only(key));
    request.onsuccess = () => complete((request.result as Outbox[]).sort((a, b) => a.claimId.localeCompare(b.claimId) || a.kind.localeCompare(b.kind)));
    request.onerror = () => fail(request.error);
  }));
}

export async function markClaimUploaded(owner: ProgressOwner, claimId: string, payload: ClaimUploadPayload): Promise<void> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  await withDatabase((db) => transaction(db, [CLAIMS, OUTBOX], "readwrite", (tx, complete, fail) => {
    const request = tx.objectStore(CLAIMS).get([key, claimId]);
    request.onsuccess = () => {
      const row = request.result as PersonalClaim | undefined;
      if (!row || !samePayload(row, payload)) { fail(new PersonalClaimConflictError()); return; }
      row.syncState = "acknowledged";
      tx.objectStore(CLAIMS).put(row);
      tx.objectStore(OUTBOX).delete([key, claimId, "claim"]);
      complete(undefined);
    };
    request.onerror = () => fail(request.error);
  }));
}

export async function markPhotoUploaded(owner: ProgressOwner, claimId: string, sha256: string): Promise<void> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  await withDatabase((db) => transaction(db, [PHOTOS, CLAIMS, OUTBOX], "readwrite", (tx, complete, fail) => {
    const photos = tx.objectStore(PHOTOS);
    const request = photos.get([key, claimId]);
    request.onsuccess = () => {
      const photo = request.result as PersonalPhoto | undefined;
      if (!photo || photo.sha256 !== sha256) { fail(new PersonalClaimConflictError("The local photo changed during upload.")); return; }
      photo.backupState = "backed-up";
      photo.unsupportedReason = null;
      photos.put(photo);
      tx.objectStore(OUTBOX).delete([key, claimId, "photo"]);
      const claimRequest = tx.objectStore(CLAIMS).get([key, claimId]);
      claimRequest.onerror = () => fail(claimRequest.error);
      claimRequest.onsuccess = () => {
        const claim = claimRequest.result as PersonalClaim | undefined;
        if (claim) { claim.remotePhoto = { status: "ready", sha256, sizeBytes: photo.sizeBytes, contentType: photo.contentType as SupportedPhotoType }; tx.objectStore(CLAIMS).put(claim); }
        complete(undefined);
      };
    };
    request.onerror = () => fail(request.error);
  }));
}

export async function markPhotoConflict(owner: ProgressOwner, claimId: string): Promise<void> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  await withDatabase((db) => transaction(db, [PHOTOS, OUTBOX], "readwrite", (tx, complete, fail) => {
    const request = tx.objectStore(PHOTOS).get([key, claimId]);
    request.onsuccess = () => {
      const photo = request.result as PersonalPhoto | undefined;
      if (photo) { photo.backupState = "conflict"; tx.objectStore(PHOTOS).put(photo); }
      tx.objectStore(OUTBOX).delete([key, claimId, "photo"]);
      complete(undefined);
    };
    request.onerror = () => fail(request.error);
  }));
}

export async function markPhotoUnsupported(owner: ProgressOwner, claimId: string): Promise<void> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  const saved = await getPersonalPhoto(owner, claimId);
  if (!saved) return;
  const eligibility = await photoEligibility(saved.blob);
  await withDatabase((db) => transaction(db, [PHOTOS, OUTBOX], "readwrite", (tx, complete, fail) => {
    const request = tx.objectStore(PHOTOS).get([key, claimId]);
    request.onsuccess = () => {
      const photo = request.result as PersonalPhoto | undefined;
      if (photo) {
        if (photo.sha256 !== saved.sha256) { fail(new PersonalClaimConflictError("The local photo changed during validation.")); return; }
        photo.backupState = "unsupported";
        photo.unsupportedReason = eligibility.reason ?? "magic";
        tx.objectStore(PHOTOS).put(photo);
      }
      tx.objectStore(OUTBOX).delete([key, claimId, "photo"]);
      complete(undefined);
    };
    request.onerror = () => fail(request.error);
  }));
}

function canonicalPayload(payload: ClaimUploadPayload): string {
  return JSON.stringify({
    parkId: payload.parkId,
    claimedAt: payload.claimedAt,
    parkSnapshot: freezeParkSnapshot(payload.parkSnapshot),
    contentReleaseId: payload.contentReleaseId,
  });
}

function samePayload(claim: Pick<PersonalClaim, "parkId" | "claimedAt" | "parkSnapshot" | "contentReleaseId">, payload: ClaimUploadPayload): boolean {
  if (!claim.parkSnapshot) return false;
  return canonicalPayload({ parkId: claim.parkId, claimedAt: claim.claimedAt, parkSnapshot: claim.parkSnapshot, contentReleaseId: claim.contentReleaseId }) === canonicalPayload(payload);
}

function validateRemotePhoto(value: unknown): RemotePhoto {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The server returned invalid photo metadata.");
  const photo = value as Record<string, unknown>;
  if (photo.status === "missing" || photo.status === "pending") return { status: photo.status };
  if (photo.status !== "ready" || typeof photo.sha256 !== "string" || !/^[a-f\d]{64}$/i.test(photo.sha256) ||
      !Number.isSafeInteger(photo.sizeBytes) || Number(photo.sizeBytes) <= 0 || Number(photo.sizeBytes) > MAX_BACKUP_PHOTO_BYTES ||
      typeof photo.contentType !== "string" || !supportedPhotoType(photo.contentType)) {
    throw new Error("The server returned invalid photo metadata.");
  }
  return { status: "ready", sha256: photo.sha256.toLowerCase(), sizeBytes: Number(photo.sizeBytes), contentType: photo.contentType };
}

export function validateRemoteClaim(value: unknown): RemoteClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The server returned an invalid claim.");
  const claim = value as Record<string, unknown>;
  if (!isUuid(claim.claimId) || typeof claim.parkId !== "string" || !claim.parkId.trim() || claim.parkId.length > 160 ||
      !validClaimedAt(claim.claimedAt) || (claim.contentReleaseId !== null && typeof claim.contentReleaseId !== "string")) {
    throw new Error("The server returned an invalid claim.");
  }
  const parkSnapshot = freezeParkSnapshot(claim.parkSnapshot as Park);
  if (parkSnapshot.id !== claim.parkId) throw new Error("The server returned a claim with a mismatched park snapshot.");
  return {
    claimId: claim.claimId.toLowerCase(),
    parkId: claim.parkId,
    claimedAt: claim.claimedAt,
    parkSnapshot,
    contentReleaseId: normalizeReleaseId(claim.contentReleaseId as string | null),
    photo: validateRemotePhoto(claim.photo),
  };
}

export async function commitRemotePage(owner: ProgressOwner, incoming: RemoteClaim[], nextCursor: string | null): Promise<void> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length > 2048)) throw new Error("The server returned an invalid claim cursor.");
  await withDatabase((db) => transaction(db, [CLAIMS, PHOTOS, OUTBOX, META], "readwrite", (tx, complete, fail) => {
    const claimsIndex = tx.objectStore(CLAIMS).index("byOwner");
    const photosIndex = tx.objectStore(PHOTOS).index("byOwner");
    const outboxIndex = tx.objectStore(OUTBOX).index("byOwner");
    const claimsRequest = claimsIndex.getAll(IDBKeyRange.only(key));
    const photosRequest = photosIndex.getAll(IDBKeyRange.only(key));
    const outboxRequest = outboxIndex.getAll(IDBKeyRange.only(key));
    let ready = 0;
    const allReady = () => {
      ready += 1;
      if (ready !== 3) return;
      try {
        const claims = new Map((claimsRequest.result as PersonalClaim[]).map((row) => [row.claimId, row]));
        const photos = new Map((photosRequest.result as PersonalPhoto[]).map((row) => [row.claimId, row]));
        const outbox = new Set((outboxRequest.result as Outbox[]).map((row) => `${row.claimId}:${row.kind}`));
        for (const remote of incoming) {
          const existing = claims.get(remote.claimId);
          if (existing && existing.parkSnapshot && !samePayload(existing, remote)) throw new PersonalClaimConflictError();
          if (existing && (existing.parkId !== remote.parkId || existing.claimedAt !== remote.claimedAt)) throw new PersonalClaimConflictError();
          const row: PersonalClaim = existing ?? {
            ownerKey: key, claimId: remote.claimId, parkId: remote.parkId, claimedAt: remote.claimedAt,
            parkSnapshot: remote.parkSnapshot, contentReleaseId: remote.contentReleaseId,
            syncState: "acknowledged", photoIssue: null, remotePhoto: remote.photo,
          };
          if (existing) {
            row.parkSnapshot ??= remote.parkSnapshot;
            row.contentReleaseId ??= remote.contentReleaseId;
            row.syncState = "acknowledged";
            row.remotePhoto = remote.photo;
          }
          tx.objectStore(CLAIMS).put(row);
          tx.objectStore(OUTBOX).delete([key, remote.claimId, "claim"]);
          outbox.delete(`${remote.claimId}:claim`);
          const localPhoto = photos.get(remote.claimId);
          if (remote.photo.status === "ready" && localPhoto) {
            if (localPhoto.sha256 === remote.photo.sha256) {
              localPhoto.backupState = "backed-up";
              localPhoto.unsupportedReason = null;
              tx.objectStore(PHOTOS).put(localPhoto);
              tx.objectStore(OUTBOX).delete([key, remote.claimId, "photo"]);
            } else {
              localPhoto.backupState = "conflict";
              tx.objectStore(PHOTOS).put(localPhoto);
              tx.objectStore(OUTBOX).delete([key, remote.claimId, "photo"]);
            }
          } else if ((remote.photo.status === "missing" || remote.photo.status === "pending") && localPhoto) {
            if (localPhoto.backupState !== "conflict" && localPhoto.unsupportedReason === null) {
              localPhoto.backupState = "pending";
              tx.objectStore(PHOTOS).put(localPhoto);
              if (!outbox.has(`${remote.claimId}:photo`)) tx.objectStore(OUTBOX).put({ ownerKey: key, claimId: remote.claimId, kind: "photo" } satisfies PhotoOutbox);
            }
          }
        }
        if (incoming.length > 0 || nextCursor !== null) {
          tx.objectStore(META).put({ key: `cursor:${key}`, value: nextCursor } satisfies Meta);
        }
        complete(undefined);
      } catch (error) { fail(error); }
    };
    claimsRequest.onsuccess = allReady;
    photosRequest.onsuccess = allReady;
    outboxRequest.onsuccess = allReady;
    claimsRequest.onerror = () => fail(claimsRequest.error);
    photosRequest.onerror = () => fail(photosRequest.error);
    outboxRequest.onerror = () => fail(outboxRequest.error);
  }));
}

export async function getPullCursor(owner: ProgressOwner): Promise<string | null> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  return withDatabase((db) => transaction<string | null>(db, META, "readonly", (tx, complete, fail) => {
    const request = tx.objectStore(META).get(`cursor:${key}`) as IDBRequest<Meta | undefined>;
    request.onsuccess = () => complete(typeof request.result?.value === "string" ? request.result.value : null);
    request.onerror = () => fail(request.error);
  }));
}

export async function listPhotosNeedingDownload(owner: ProgressOwner): Promise<Array<{ claim: PersonalClaim; photo: RemotePhoto & { status: "ready" } }>> {
  const [claims, photos] = await Promise.all([listPersonalClaims(owner), listPersonalPhotos(owner)]);
  const localPhotos = new Map(photos.map((photo) => [photo.claimId, photo]));
  return claims.flatMap((claim) => {
    if (claim.remotePhoto.status !== "ready") return [];
    const local = localPhotos.get(claim.claimId);
    if (local?.sha256 === claim.remotePhoto.sha256) return [];
    if (local?.backupState === "conflict") return [];
    return [{ claim, photo: claim.remotePhoto }];
  });
}

export async function commitDownloadedPhoto(owner: ProgressOwner, claimId: string, remote: RemotePhoto, blob: Blob, sha256: string): Promise<"stored" | "conflict"> {
  await initializePersonalStore();
  const key = ownerKey(owner);
  if (remote.status !== "ready" || blob.size !== remote.sizeBytes || blob.size > MAX_BACKUP_PHOTO_BYTES ||
      blob.type.toLowerCase() !== remote.contentType || sha256.toLowerCase() !== remote.sha256) {
    throw new Error("The backed-up photo failed its integrity check.");
  }
  const eligibility = await photoEligibility(blob);
  if (!eligibility.supported) throw new Error("The backed-up photo is not a supported image.");
  return withDatabase((db) => transaction(db, [CLAIMS, PHOTOS, OUTBOX], "readwrite", (tx, complete, fail) => {
    const claimRequest = tx.objectStore(CLAIMS).get([key, claimId]);
    const photoRequest = tx.objectStore(PHOTOS).get([key, claimId]);
    let ready = 0;
    let claim: PersonalClaim | undefined;
    let existing: PersonalPhoto | undefined;
    const finish = () => {
      ready += 1;
      if (ready !== 2) return;
      if (!claim || claim.remotePhoto.status !== "ready" || claim.remotePhoto.sha256 !== remote.sha256) {
        fail(new PersonalClaimConflictError("The server photo changed while it was downloading."));
        return;
      }
      if (existing && existing.sha256 !== remote.sha256) {
        existing.backupState = "conflict";
        tx.objectStore(PHOTOS).put(existing);
        complete("conflict");
        return;
      }
      tx.objectStore(PHOTOS).put({ ownerKey: key, claimId, blob, contentType: blob.type.toLowerCase(), sizeBytes: blob.size, sha256, backupState: "backed-up", unsupportedReason: null } satisfies PersonalPhoto);
      tx.objectStore(OUTBOX).delete([key, claimId, "photo"]);
      complete("stored");
    };
    claimRequest.onsuccess = () => { claim = claimRequest.result as PersonalClaim | undefined; finish(); };
    photoRequest.onsuccess = () => { existing = photoRequest.result as PersonalPhoto | undefined; finish(); };
    claimRequest.onerror = () => fail(claimRequest.error);
    photoRequest.onerror = () => fail(photoRequest.error);
  }));
}

export async function loadPersonalProgress(owner: ProgressOwner): Promise<{ claims: PersonalClaim[]; photos: Record<string, string> }> {
  const [claims, photos] = await Promise.all([listPersonalClaims(owner), loadPersonalPhotos(owner)]);
  return { claims, photos };
}

export async function copyGuestClaimsToAccount(accountId: string): Promise<number> {
  await initializePersonalStore();
  const guest: ProgressOwner = { kind: "guest" };
  const account: ProgressOwner = { kind: "account", accountId };
  const guestKey = ownerKey(guest);
  const accountKey = ownerKey(account);
  return withDatabase((db) => transaction<number>(db, [CLAIMS, PHOTOS, OUTBOX], "readwrite", (tx, complete, fail) => {
    const claimsRequest = tx.objectStore(CLAIMS).index("byOwner").getAll(IDBKeyRange.only(guestKey));
    const photosRequest = tx.objectStore(PHOTOS).index("byOwner").getAll(IDBKeyRange.only(guestKey));
    const targetClaimsRequest = tx.objectStore(CLAIMS).index("byOwner").getAll(IDBKeyRange.only(accountKey));
    const targetPhotosRequest = tx.objectStore(PHOTOS).index("byOwner").getAll(IDBKeyRange.only(accountKey));
    let ready = 0;
    let guestClaims: PersonalClaim[] = [];
    let guestPhotos: PersonalPhoto[] = [];
    let accountClaims: PersonalClaim[] = [];
    let accountPhotos: PersonalPhoto[] = [];
    const finish = () => {
      ready += 1;
      if (ready !== 4) return;
      try {
        const targetClaims = tx.objectStore(CLAIMS);
        const targetPhotos = tx.objectStore(PHOTOS);
        const targetOutbox = tx.objectStore(OUTBOX);
        const claimById = new Map(accountClaims.map((row) => [row.claimId, row]));
        const photoById = new Map(accountPhotos.map((row) => [row.claimId, row]));
        for (const source of guestClaims) {
          const existing = claimById.get(source.claimId);
          if (existing && (existing.parkId !== source.parkId || existing.claimedAt !== source.claimedAt ||
              (existing.parkSnapshot && source.parkSnapshot && !samePayload(existing, { parkId: source.parkId, claimedAt: source.claimedAt, parkSnapshot: source.parkSnapshot, contentReleaseId: source.contentReleaseId })))) {
            throw new PersonalClaimConflictError("A guest claim conflicts with progress already on this account.");
          }
          if (!existing) {
            const copied: PersonalClaim = { ...source, ownerKey: accountKey, syncState: "pending" };
            claimById.set(copied.claimId, copied);
            targetClaims.add(copied);
            targetOutbox.put({ ownerKey: accountKey, claimId: source.claimId, kind: "claim" } satisfies ClaimOutbox);
          } else if (!existing.parkSnapshot && source.parkSnapshot) {
            if (existing.syncState === "acknowledged") throw new PersonalClaimConflictError("An acknowledged account claim is missing its frozen snapshot.");
            existing.parkSnapshot = source.parkSnapshot;
            existing.contentReleaseId = source.contentReleaseId;
            existing.syncState = "pending";
            targetClaims.put(existing);
            targetOutbox.put({ ownerKey: accountKey, claimId: source.claimId, kind: "claim" } satisfies ClaimOutbox);
          }
        }
        for (const sourcePhoto of guestPhotos) {
          const existing = photoById.get(sourcePhoto.claimId);
          const claim = claimById.get(sourcePhoto.claimId);
          if (!claim) throw new PersonalClaimConflictError("A guest photo has no matching account claim.");
          if (existing && existing.sha256 !== sourcePhoto.sha256) {
            throw new PersonalClaimConflictError("A guest photo conflicts with progress already on this account.");
          }
          if (!existing) {
            const sameAsServer = claim.remotePhoto.status === "ready" && claim.remotePhoto.sha256 === sourcePhoto.sha256;
            if (claim.remotePhoto.status === "ready" && !sameAsServer) {
              throw new PersonalClaimConflictError("The account already has a different backed-up photo for this claim.");
            }
            const copied: PersonalPhoto = {
              ...sourcePhoto,
              ownerKey: accountKey,
              backupState: sourcePhoto.unsupportedReason ? "unsupported" : sameAsServer ? "backed-up" : "pending",
            };
            photoById.set(copied.claimId, copied);
            targetPhotos.add(copied);
            if (!copied.unsupportedReason && !sameAsServer) targetOutbox.put({ ownerKey: accountKey, claimId: copied.claimId, kind: "photo" } satisfies PhotoOutbox);
          };
        }
        complete(guestClaims.length);
      } catch (error) { fail(error); }
    };
    claimsRequest.onsuccess = () => { guestClaims = claimsRequest.result as PersonalClaim[]; finish(); };
    photosRequest.onsuccess = () => { guestPhotos = photosRequest.result as PersonalPhoto[]; finish(); };
    targetClaimsRequest.onsuccess = () => { accountClaims = targetClaimsRequest.result as PersonalClaim[]; finish(); };
    targetPhotosRequest.onsuccess = () => { accountPhotos = targetPhotosRequest.result as PersonalPhoto[]; finish(); };
    claimsRequest.onerror = () => fail(claimsRequest.error);
    photosRequest.onerror = () => fail(photosRequest.error);
    targetClaimsRequest.onerror = () => fail(targetClaimsRequest.error);
    targetPhotosRequest.onerror = () => fail(targetPhotosRequest.error);
  }));
}

export async function removeAttachedGuestClaims(accountId: string): Promise<number> {
  await initializePersonalStore();
  const guest: ProgressOwner = { kind: "guest" };
  const account: ProgressOwner = { kind: "account", accountId };
  const guestKey = ownerKey(guest);
  const accountKey = ownerKey(account);
  return withDatabase((db) => transaction<number>(db, [CLAIMS, PHOTOS, OUTBOX], "readwrite", (tx, complete, fail) => {
    const guestClaimsRequest = tx.objectStore(CLAIMS).index("byOwner").getAll(IDBKeyRange.only(guestKey));
    const accountClaimsRequest = tx.objectStore(CLAIMS).index("byOwner").getAll(IDBKeyRange.only(accountKey));
    let ready = 0;
    let guestClaims: PersonalClaim[] = [];
    let accountClaims: PersonalClaim[] = [];
    const finish = () => {
      ready += 1;
      if (ready !== 2) return;
      const accountById = new Map(accountClaims.map((claim) => [claim.claimId, claim]));
      const pendingRemove = guestClaims.filter((claim) => {
        const accountClaim = accountById.get(claim.claimId);
        return accountClaim?.syncState === "acknowledged";
      });
      if (pendingRemove.length !== guestClaims.length) { fail(new Error("Guest progress is still waiting for server acknowledgement.")); return; }
      let remaining = pendingRemove.length;
      if (remaining === 0) { complete(0); return; }
      for (const claim of pendingRemove) {
        const photoRequest = tx.objectStore(PHOTOS).get([guestKey, claim.claimId]);
        photoRequest.onsuccess = () => {
          const guestPhoto = photoRequest.result as PersonalPhoto | undefined;
          const accountPhotoRequest = tx.objectStore(PHOTOS).get([accountKey, claim.claimId]);
          accountPhotoRequest.onsuccess = () => {
            const accountPhoto = accountPhotoRequest.result as PersonalPhoto | undefined;
            if (guestPhoto) {
              if (accountPhoto?.sha256 !== guestPhoto.sha256) {
                fail(new Error("A guest photo is not durably attached to the account."));
                return;
              }
              if (!guestPhoto.unsupportedReason && accountPhoto.backupState !== "backed-up") {
                fail(new Error("A guest photo is still waiting for server acknowledgement."));
                return;
              }
            }
            tx.objectStore(CLAIMS).delete([guestKey, claim.claimId]);
            tx.objectStore(PHOTOS).delete([guestKey, claim.claimId]);
            remaining -= 1;
            if (remaining === 0) complete(pendingRemove.length);
          };
          accountPhotoRequest.onerror = () => fail(accountPhotoRequest.error);
        };
        photoRequest.onerror = () => fail(photoRequest.error);
      }
    };
    guestClaimsRequest.onsuccess = () => { guestClaims = guestClaimsRequest.result as PersonalClaim[]; finish(); };
    accountClaimsRequest.onsuccess = () => { accountClaims = accountClaimsRequest.result as PersonalClaim[]; finish(); };
    guestClaimsRequest.onerror = () => fail(guestClaimsRequest.error);
    accountClaimsRequest.onerror = () => fail(accountClaimsRequest.error);
  }));
}

export async function clearAccountProgressAfterServerDeletion(accountId: string): Promise<void> {
  await initializePersonalStore();
  const account: ProgressOwner = { kind: "account", accountId };
  const key = ownerKey(account);
  await withDatabase((db) => transaction(db, [CLAIMS, PHOTOS, OUTBOX, META], "readwrite", (tx, complete, fail) => {
    let pending = 4;
    const stores = [CLAIMS, PHOTOS, OUTBOX].map((name) => tx.objectStore(name));
    for (const store of stores) {
      const request = store.index("byOwner").openCursor(IDBKeyRange.only(key));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { pending -= 1; if (pending === 0) finish(); return; }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => fail(request.error);
    }
    const metaCursor = tx.objectStore(META).openCursor();
    metaCursor.onsuccess = () => {
      const cursor = metaCursor.result;
      if (!cursor) { pending -= 1; if (pending === 0) finish(); return; }
      if (String(cursor.key).endsWith(`:${key}`)) cursor.delete();
      cursor.continue();
    };
    metaCursor.onerror = () => fail(metaCursor.error);
    const finish = () => complete(undefined);
  }));
}

export async function hashPhoto(blob: Blob): Promise<string> {
  return sha256Blob(blob);
}

export function isPhotoEligible(blob: Blob): Promise<boolean> {
  return photoEligibility(blob).then((result) => result.supported);
}
