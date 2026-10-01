import type { ArchivedScene, ContentChangeBatch, ContentEnvironment, ContentMapInventory, ContentMapPointer, ContentStore, ContentSyncCursor, ContentSyncState, RetainedPark, StoredRelease } from "./contracts";
import { archivedSceneStorageKey, assertArchivedSceneDescriptor } from "./archived-art";

const DATABASE = "parkdex-content-v1";
const VERSION = 4;
const RELEASES = "releases";
const META = "meta";
const FILES = "files";
const RETAINED_PARKS = "retainedParks";
const SYNC_ROWS = "syncRows";
const SYNC_CURSORS = "syncCursors";
const MAP_INVENTORIES = "mapInventories";
const CACHED_MAP_POINTERS = "cachedMapPointers";
const ARCHIVED_SCENES = "archivedScenes";
const ACTIVE_KEY = "activeReleaseId";

type MetaRecord = { key: string; value: string | null };
type FileRecord = { hash: string; size: number; bytes: Blob };
type RetainedRecord = { parkId: string; park: RetainedPark["park"]; sceneFile?: RetainedPark["sceneFile"] };
type SyncRow = { key: string; environment: ContentEnvironment; entity: "park" | "boundary" | "drive" | "asset" | "hubs" | "map"; id: string; value: unknown; position: number };
type SyncCursor = { environment: ContentEnvironment; revision: number; sourceId: string };
type MapInventoryRecord = { version: string; inventory: ContentMapInventory };
type CachedMapPointer = { environment: ContentEnvironment; pointer: ContentMapPointer };
type ArchivedSceneRecord = ArchivedScene & { key: string };

function syncKey(environment: ContentEnvironment, entity: SyncRow["entity"], id: string) {
  return `${environment}\u0000${entity}\u0000${id}`;
}

function contentRows(environment: ContentEnvironment, state: ContentSyncState): SyncRow[] {
  const rows: SyncRow[] = [];
  state.parks.forEach((value, position) => rows.push({ key: syncKey(environment, "park", value.id), environment, entity: "park", id: value.id, value, position }));
  state.boundaries.features.forEach((value, position) => {
    const id = value.properties.id;
    rows.push({ key: syncKey(environment, "boundary", id), environment, entity: "boundary", id, value, position });
  });
  Object.entries(state.drive.parks).forEach(([id, value], position) => rows.push({ key: syncKey(environment, "drive", id), environment, entity: "drive", id, value, position }));
  state.assets.forEach((value, position) => rows.push({ key: syncKey(environment, "asset", value.path), environment, entity: "asset", id: value.path, value, position }));
  rows.push({ key: syncKey(environment, "hubs", "default"), environment, entity: "hubs", id: "default", value: state.drive.hubs, position: 0 });
  if (state.map) rows.push({ key: syncKey(environment, "map", "default"), environment, entity: "map", id: "default", value: state.map, position: 0 });
  return rows;
}

function assertHash(hash: string): string {
  if (!/^[a-f\d]{64}$/i.test(hash)) throw new Error("Invalid content SHA-256 hash");
  return hash.toLowerCase();
}

function assertSize(size: number) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid content byte size");
}

function assertRange(offset = 0, length?: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid content read offset");
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
    throw new Error("Invalid content read length");
  }
  if (length !== undefined && !Number.isSafeInteger(offset + length)) {
    throw new Error("Invalid content read range");
  }
}

function assertRelease(release: StoredRelease) {
  if (!release || typeof release.id !== "string" || release.id.length === 0) {
    throw new Error("Invalid content release");
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReadableRelease(value: unknown, id: string): value is StoredRelease {
  if (!isObjectRecord(value) || value.id !== id || !isObjectRecord(value.channel) || !isObjectRecord(value.manifest)) return false;
  const channel = value.channel;
  const manifest = value.manifest;
  const mapManifest = manifest.mapManifest;
  return channel.releaseId === id && Number.isSafeInteger(channel.generation) && typeof channel.environment === "string" &&
    typeof channel.manifestUrl === "string" && typeof channel.manifestSha256 === "string" &&
    typeof manifest.version === "string" && typeof manifest.sourceCommit === "string" && typeof manifest.cdnOrigin === "string" &&
    Array.isArray(manifest.files) && Array.isArray(manifest.parkIds) && Array.isArray(manifest.boundaryIds) &&
    isObjectRecord(mapManifest) && Number.isSafeInteger(mapManifest.size) && Number.isSafeInteger(mapManifest.chunkBytes) && Number.isSafeInteger(mapManifest.count) &&
    (value.readiness === "candidate" || value.readiness === "starter" || value.readiness === "complete") && typeof value.healthy === "boolean";
}

function isReadablePark(value: unknown): value is RetainedPark["park"] {
  if (!isObjectRecord(value)) return false;
  return typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string" && typeof value.short === "string" &&
    typeof value.category === "string" && typeof value.region === "string" && Number.isFinite(value.lat) && Number.isFinite(value.lng) &&
    typeof value.biome === "string" && typeof value.shape === "string" && typeof value.rarity === "string" && Number.isSafeInteger(value.seed) &&
    typeof value.blurb === "string" && (value.scene === null || typeof value.scene === "string");
}

function parseReleaseRecord(id: unknown, value: unknown): StoredRelease | undefined {
  return typeof id === "string" && isReadableRelease(value, id) ? value : undefined;
}

function parseRetainedRecord(record: RetainedRecord): RetainedPark | undefined {
  if (!record || !isReadablePark(record.park)) return undefined;
  try {
    const retained = { park: record.park, ...(record.sceneFile ? { sceneFile: record.sceneFile } : {}) };
    assertRetainedPark(retained);
    return retained;
  } catch {
    return undefined;
  }
}

function parseArchivedRecord(record: ArchivedSceneRecord): ArchivedScene | undefined {
  try {
    const { key, ...descriptor } = record;
    assertArchivedSceneDescriptor(descriptor);
    if (key !== archivedSceneStorageKey(descriptor.releaseId, descriptor.scene)) return undefined;
    return descriptor;
  } catch {
    return undefined;
  }
}

function assertRetainedPark(retained: RetainedPark) {
  if (!retained?.park || typeof retained.park.id !== "string" || retained.park.id.length === 0) {
    throw new Error("Invalid retained park");
  }
  if (retained.sceneFile) assertHash(retained.sceneFile.sha256);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable in this browser");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function waitForTransaction<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, complete: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T;
    let hasResult = false;
    let failure: unknown;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (error) {
      reject(error);
      return;
    }
    const complete = (value: T) => {
      result = value;
      hasResult = true;
    };
    const fail = (error: unknown) => {
      failure = error;
      try {
        tx.abort();
      } catch {
        reject(error);
      }
    };
    tx.oncomplete = () => {
      if (failure !== undefined) reject(failure);
      else if (hasResult) resolve(result);
      else reject(new Error("Content storage transaction completed without a result"));
    };
    tx.onerror = () => reject(failure ?? tx.error ?? new Error("Content storage transaction failed"));
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("Content storage transaction was aborted"));
    try {
      work(tx, complete, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function fileBytes(record: FileRecord): Promise<ArrayBuffer> {
  return record.bytes.arrayBuffer();
}

function normalizedMime(mime: string): string {
  if (typeof mime !== "string" || mime.length > 128 || /[\r\n]/.test(mime)) {
    throw new Error("Invalid content MIME type");
  }
  return mime;
}

/** Browser content storage is isolated from the IndexedDB database used for check-in photos. */
export class WebContentStore implements ContentStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly objectUrls = new Map<string, string>();

  async initialize(): Promise<void> {
    const db = await this.database();
    await waitForTransaction<void>(db, META, "readwrite", (tx, complete, fail) => {
      const store = tx.objectStore(META);
      const request = store.get(ACTIVE_KEY);
      request.onsuccess = () => {
        if (request.result === undefined) store.put({ key: ACTIVE_KEY, value: null } satisfies MetaRecord);
        complete(undefined);
      };
      request.onerror = () => fail(request.error);
    });
  }

  async getActiveId(): Promise<string | null> {
    const db = await this.database();
    return waitForTransaction<string | null>(db, META, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(META).get(ACTIVE_KEY) as IDBRequest<MetaRecord | undefined>;
      request.onsuccess = () => complete(request.result?.value ?? null);
      request.onerror = () => fail(request.error);
    });
  }

  async getRelease(id: string): Promise<StoredRelease | undefined> {
    const db = await this.database();
    return waitForTransaction<StoredRelease | undefined>(db, RELEASES, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(RELEASES).get(id) as IDBRequest<StoredRelease | undefined>;
      request.onsuccess = () => complete(parseReleaseRecord(id, request.result));
      request.onerror = () => fail(request.error);
    });
  }

  async listReleases(): Promise<StoredRelease[]> {
    const db = await this.database();
    return waitForTransaction<StoredRelease[]>(db, RELEASES, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(RELEASES).getAll() as IDBRequest<StoredRelease[]>;
      request.onsuccess = () => complete(request.result.flatMap((release) => {
        const parsed = parseReleaseRecord(release?.id, release);
        return parsed ? [parsed] : [];
      }));
      request.onerror = () => fail(request.error);
    });
  }

  async putRelease(release: StoredRelease): Promise<void> {
    assertRelease(release);
    const db = await this.database();
    await waitForTransaction<void>(db, RELEASES, "readwrite", (tx, complete, fail) => {
      const request = tx.objectStore(RELEASES).put(release);
      request.onsuccess = () => complete(undefined);
      request.onerror = () => fail(request.error);
    });
  }

  async activateRelease(id: string, expectedActiveId: string | null): Promise<void> {
    const db = await this.database();
    await waitForTransaction<void>(db, [META, RELEASES], "readwrite", (tx, complete, fail) => {
      const meta = tx.objectStore(META);
      const activeRequest = meta.get(ACTIVE_KEY) as IDBRequest<MetaRecord | undefined>;
      const releaseRequest = tx.objectStore(RELEASES).get(id) as IDBRequest<StoredRelease | undefined>;
      let activeReady = false;
      let releaseReady = false;
      let active: string | null = null;
      let release: StoredRelease | undefined;
      const finish = () => {
        if (!activeReady || !releaseReady) return;
        if (active !== expectedActiveId) {
          fail(new Error(`Active content changed: expected ${String(expectedActiveId)}, found ${String(active)}`));
          return;
        }
        if (!release) {
          fail(new Error(`Cannot activate missing content release: ${id}`));
          return;
        }
        const write = meta.put({ key: ACTIVE_KEY, value: id } satisfies MetaRecord);
        write.onsuccess = () => complete(undefined);
        write.onerror = () => fail(write.error);
      };
      activeRequest.onsuccess = () => {
        active = activeRequest.result?.value ?? null;
        activeReady = true;
        finish();
      };
      activeRequest.onerror = () => fail(activeRequest.error);
      releaseRequest.onsuccess = () => {
        release = releaseRequest.result;
        releaseReady = true;
        finish();
      };
      releaseRequest.onerror = () => fail(releaseRequest.error);
    });
  }

  async deleteRelease(id: string): Promise<void> {
    const db = await this.database();
    await waitForTransaction<void>(db, [META, RELEASES], "readwrite", (tx, complete, fail) => {
      const activeRequest = tx.objectStore(META).get(ACTIVE_KEY) as IDBRequest<MetaRecord | undefined>;
      activeRequest.onsuccess = () => {
        if ((activeRequest.result?.value ?? null) === id) {
          fail(new Error(`Cannot delete active content release: ${id}`));
          return;
        }
        const request = tx.objectStore(RELEASES).delete(id);
        request.onsuccess = () => complete(undefined);
        request.onerror = () => fail(request.error);
      };
      activeRequest.onerror = () => fail(activeRequest.error);
    });
  }

  async hasFile(hash: string, expectedSize: number): Promise<boolean> {
    const key = assertHash(hash);
    assertSize(expectedSize);
    const record = await this.getFile(key);
    if (!record || record.size !== expectedSize || record.bytes.size !== expectedSize) return false;
    return (await sha256(await fileBytes(record))) === key;
  }

  async putFile(hash: string, bytes: ArrayBuffer): Promise<void> {
    const key = assertHash(hash);
    if (!(bytes instanceof ArrayBuffer)) throw new Error("Content file must be an ArrayBuffer");
    if ((await sha256(bytes)) !== key) throw new Error("Content file SHA-256 does not match its address");
    const copy = bytes.slice(0);
    const db = await this.database();
    await waitForTransaction<void>(db, FILES, "readwrite", (tx, complete, fail) => {
      const request = tx.objectStore(FILES).put({ hash: key, size: copy.byteLength, bytes: new Blob([copy]) } satisfies FileRecord);
      request.onsuccess = () => complete(undefined);
      request.onerror = () => fail(request.error);
    });
    this.revokeHashUrls(key);
  }

  async readFile(hash: string, offset = 0, length?: number): Promise<ArrayBuffer> {
    const key = assertHash(hash);
    assertRange(offset, length);
    const record = await this.getFile(key);
    if (!record || record.bytes.size !== record.size) throw new Error(`Content file is unavailable: ${key}`);
    const bytes = await fileBytes(record);
    if ((await sha256(bytes)) !== key) throw new Error(`Content file failed SHA-256 verification: ${key}`);
    const end = length === undefined ? record.size : Math.min(record.size, offset + length);
    return bytes.slice(Math.min(offset, record.size), end);
  }

  async fileUrl(hash: string, mime: string): Promise<string> {
    const key = assertHash(hash);
    const type = normalizedMime(mime);
    const cacheKey = `${key}\n${type}`;
    const existing = this.objectUrls.get(cacheKey);
    if (existing) return existing;
    const bytes = await this.readFile(key);
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    this.objectUrls.set(cacheKey, url);
    return url;
  }

  async listFiles(): Promise<{ hash: string; size: number }[]> {
    const db = await this.database();
    return waitForTransaction<{ hash: string; size: number }[]>(db, FILES, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(FILES).getAll() as IDBRequest<FileRecord[]>;
      request.onsuccess = () => complete(request.result.map(({ hash, size }) => ({ hash, size })));
      request.onerror = () => fail(request.error);
    });
  }

  async deleteFile(hash: string): Promise<void> {
    const key = assertHash(hash);
    const db = await this.database();
    await waitForTransaction<void>(db, [FILES, META, RELEASES, RETAINED_PARKS, ARCHIVED_SCENES, SYNC_ROWS, MAP_INVENTORIES, CACHED_MAP_POINTERS], "readwrite", (tx, complete, fail) => {
      const activeRequest = tx.objectStore(META).get(ACTIVE_KEY) as IDBRequest<MetaRecord | undefined>;
      const retainedRequest = tx.objectStore(RETAINED_PARKS).getAll() as IDBRequest<RetainedRecord[]>;
      const archivedRequest = tx.objectStore(ARCHIVED_SCENES).getAll() as IDBRequest<ArchivedSceneRecord[]>;
      const syncRequest = tx.objectStore(SYNC_ROWS).getAll() as IDBRequest<SyncRow[]>;
      const inventoryRequest = tx.objectStore(MAP_INVENTORIES).getAll() as IDBRequest<MapInventoryRecord[]>;
      const pointersRequest = tx.objectStore(CACHED_MAP_POINTERS).getAll() as IDBRequest<CachedMapPointer[]>;
      let ready = 0;
      let activeId: string | null = null;
      let activeRelease: StoredRelease | undefined;
      let retainedParks: RetainedRecord[] = [];
      let archivedScenes: ArchivedSceneRecord[] = [];
      let syncRows: SyncRow[] = [];
      let inventories: MapInventoryRecord[] = [];
      let cachedPointers: CachedMapPointer[] = [];
      const finish = () => {
        if (ready !== 6) return;
        const activeReferencesFile = activeRelease?.manifest.files.some((file) => file.sha256.toLowerCase() === key) ?? false;
        const retainedReferencesFile = retainedParks.some((park) => park.sceneFile?.sha256.toLowerCase() === key);
        try {
          for (const archived of archivedScenes) {
            const { key: storedKey, ...descriptor } = archived;
            assertArchivedSceneDescriptor(descriptor);
            if (storedKey !== archivedSceneStorageKey(descriptor.releaseId, descriptor.scene)) {
              throw new Error("Archived scene storage key does not match its descriptor");
            }
          }
        } catch (error) {
          fail(error);
          return;
        }
        const archivedReferencesFile = archivedScenes.some((scene) => scene.file.sha256 === key);
        const syncReferencesFile = syncRows.some((row) => row.entity === "asset" && (row.value as { sha256?: unknown }).sha256 === key);
        const currentMapVersions = new Set(cachedPointers.map((entry) => entry.pointer.version));
        for (const row of syncRows) if (row.entity === "map" && row.value) currentMapVersions.add((row.value as ContentMapPointer).version);
        const mapReferencesFile = inventories.some((entry) => currentMapVersions.has(entry.version) && entry.inventory.files.some((file) => file.sha256 === key));
        if (activeReferencesFile || retainedReferencesFile || archivedReferencesFile || syncReferencesFile || mapReferencesFile) {
          fail(new Error(`Cannot delete content file referenced by active or retained content: ${key}`));
          return;
        }
        const request = tx.objectStore(FILES).delete(key);
        request.onsuccess = () => complete(undefined);
        request.onerror = () => fail(request.error);
      };
      activeRequest.onsuccess = () => {
        activeId = activeRequest.result?.value ?? null;
        if (activeId === null) {
          ready += 1;
          finish();
          return;
        }
        const releaseRequest = tx.objectStore(RELEASES).get(activeId) as IDBRequest<StoredRelease | undefined>;
        releaseRequest.onsuccess = () => {
          activeRelease = releaseRequest.result;
          ready += 1;
          finish();
        };
        releaseRequest.onerror = () => fail(releaseRequest.error);
      };
      activeRequest.onerror = () => fail(activeRequest.error);
      retainedRequest.onsuccess = () => {
        retainedParks = retainedRequest.result;
        ready += 1;
        finish();
      };
      retainedRequest.onerror = () => fail(retainedRequest.error);
      archivedRequest.onsuccess = () => { archivedScenes = archivedRequest.result; ready += 1; finish(); };
      archivedRequest.onerror = () => fail(archivedRequest.error);
      syncRequest.onsuccess = () => { syncRows = syncRequest.result; ready += 1; finish(); };
      syncRequest.onerror = () => fail(syncRequest.error);
      inventoryRequest.onsuccess = () => { inventories = inventoryRequest.result; ready += 1; finish(); };
      inventoryRequest.onerror = () => fail(inventoryRequest.error);
      pointersRequest.onsuccess = () => { cachedPointers = pointersRequest.result; ready += 1; finish(); };
      pointersRequest.onerror = () => fail(pointersRequest.error);
    });
    this.revokeHashUrls(key);
  }

  async getRetainedParks(): Promise<RetainedPark[]> {
    const db = await this.database();
    return waitForTransaction<RetainedPark[]>(db, RETAINED_PARKS, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(RETAINED_PARKS).getAll() as IDBRequest<RetainedRecord[]>;
      request.onsuccess = () => complete(request.result.flatMap((record) => {
        const retained = parseRetainedRecord(record);
        return retained ? [retained] : [];
      }));
      request.onerror = () => fail(request.error);
    });
  }

  async retainParks(parks: RetainedPark[]): Promise<void> {
    const unique = new Map<string, RetainedPark>();
    for (const retained of parks) {
      assertRetainedPark(retained);
      unique.set(retained.park.id, retained);
    }
    if (unique.size === 0) return;
    const db = await this.database();
    await waitForTransaction<void>(db, RETAINED_PARKS, "readwrite", (tx, complete, fail) => {
      const store = tx.objectStore(RETAINED_PARKS);
      let remaining = unique.size;
      for (const [parkId, retained] of unique) {
        const request = store.get(parkId) as IDBRequest<RetainedRecord | undefined>;
        request.onsuccess = () => {
          const existing = request.result;
          if (!existing) store.put({ parkId, park: retained.park, sceneFile: retained.sceneFile } satisfies RetainedRecord);
          else store.put({ parkId, park: retained.park, sceneFile: retained.sceneFile ?? existing.sceneFile } satisfies RetainedRecord);
          remaining -= 1;
          if (remaining === 0) complete(undefined);
        };
        request.onerror = () => fail(request.error);
      }
    });
  }

  async clearActiveRelease(expectedActiveId: string): Promise<void> {
    const db = await this.database();
    await waitForTransaction<void>(db, META, "readwrite", (tx, complete, fail) => {
      const store = tx.objectStore(META);
      const request = store.get(ACTIVE_KEY) as IDBRequest<MetaRecord | undefined>;
      request.onsuccess = () => {
        if ((request.result?.value ?? null) !== expectedActiveId) {
          fail(new Error("Active content changed before its legacy pointer could be cleared"));
          return;
        }
        const write = store.put({ key: ACTIVE_KEY, value: null } satisfies MetaRecord);
        write.onsuccess = () => complete(undefined);
        write.onerror = () => fail(write.error);
      };
      request.onerror = () => fail(request.error);
    });
  }

  async getArchivedScene(releaseId: string, scene: string): Promise<ArchivedScene | undefined> {
    const key = archivedSceneStorageKey(releaseId, scene);
    const db = await this.database();
    return waitForTransaction<ArchivedScene | undefined>(db, ARCHIVED_SCENES, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(ARCHIVED_SCENES).get(key) as IDBRequest<ArchivedSceneRecord | undefined>;
      request.onsuccess = () => {
        const archived = request.result ? parseArchivedRecord(request.result) : undefined;
        complete(archived?.releaseId === releaseId && archived.scene === scene ? archived : undefined);
      };
      request.onerror = () => fail(request.error);
    });
  }

  async retainArchivedScene(scene: ArchivedScene): Promise<void> {
    assertArchivedSceneDescriptor(scene);
    const descriptor: ArchivedScene = { releaseId: scene.releaseId, scene: scene.scene, file: { ...scene.file } };
    const db = await this.database();
    const key = archivedSceneStorageKey(descriptor.releaseId, descriptor.scene);
    await waitForTransaction<void>(db, ARCHIVED_SCENES, "readwrite", (tx, complete, fail) => {
      const request = tx.objectStore(ARCHIVED_SCENES).put({ ...descriptor, key } satisfies ArchivedSceneRecord);
      request.onsuccess = () => complete(undefined);
      request.onerror = () => fail(request.error);
    });
  }

  async listArchivedScenes(): Promise<ArchivedScene[]> {
    const db = await this.database();
    return waitForTransaction<ArchivedScene[]>(db, ARCHIVED_SCENES, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(ARCHIVED_SCENES).getAll() as IDBRequest<ArchivedSceneRecord[]>;
      request.onsuccess = () => {
        const descriptors = request.result.flatMap((record) => {
          const descriptor = parseArchivedRecord(record);
          return descriptor ? [descriptor] : [];
        });
        descriptors.sort((left, right) =>
          left.releaseId < right.releaseId ? -1 : left.releaseId > right.releaseId ? 1 :
            left.scene < right.scene ? -1 : left.scene > right.scene ? 1 : 0,
        );
        complete(descriptors);
      };
      request.onerror = () => fail(request.error);
    });
  }

  async getSyncState(environment: ContentEnvironment): Promise<ContentSyncState | null> {
    const db = await this.database();
    return waitForTransaction<ContentSyncState | null>(db, [SYNC_ROWS, SYNC_CURSORS], "readonly", (tx, complete, fail) => {
      const rowsRequest = tx.objectStore(SYNC_ROWS).getAll() as IDBRequest<SyncRow[]>;
      const cursorRequest = tx.objectStore(SYNC_CURSORS).get(environment) as IDBRequest<SyncCursor | undefined>;
      let rows: SyncRow[] | undefined;
      let cursor: SyncCursor | undefined;
      const finish = () => {
        if (!rows || (cursor === undefined && cursorRequest.readyState !== "done")) return;
        if (!cursor || !Number.isSafeInteger(cursor.revision) || typeof cursor.sourceId !== "string") { complete(null); return; }
        const knownEntities = new Set(["park", "boundary", "drive", "asset", "hubs", "map"]);
        const local = rows.filter((row) => row?.environment === environment && knownEntities.has(row.entity));
        if (local.some((row) => typeof row.id !== "string" || !Number.isSafeInteger(row.position) || !row.value || typeof row.value !== "object")) {
          complete(null);
          return;
        }
        local.sort((a, b) => a.entity.localeCompare(b.entity) || a.position - b.position || a.id.localeCompare(b.id));
        const parks = local.filter((row) => row.entity === "park").map((row) => row.value as ContentSyncState["parks"][number]);
        const boundaries = local.filter((row) => row.entity === "boundary").map((row) => row.value as ContentSyncState["boundaries"]["features"][number]);
        const drives = Object.fromEntries(local.filter((row) => row.entity === "drive").map((row) => [row.id, row.value as ContentSyncState["drive"]["parks"][string]]));
        const hubs = local.find((row) => row.entity === "hubs")?.value as ContentSyncState["drive"]["hubs"] | undefined;
        if (!Array.isArray(hubs) || parks.some((park) => typeof park.id !== "string") ||
          boundaries.some((feature) => typeof feature.properties?.id !== "string") ||
          local.some((row) => row.entity === "asset" && typeof (row.value as { path?: unknown }).path !== "string")) {
          complete(null);
          return;
        }
        const assets = local.filter((row) => row.entity === "asset").map((row) => row.value as ContentSyncState["assets"][number]);
        const map = local.find((row) => row.entity === "map")?.value as ContentSyncState["map"] | undefined;
        const parkOrder = new Map(parks.map((park, index) => [park.id, index]));
        boundaries.sort((a, b) => (parkOrder.get(a.properties.id) ?? Number.MAX_SAFE_INTEGER) - (parkOrder.get(b.properties.id) ?? Number.MAX_SAFE_INTEGER));
        complete({ revision: cursor.revision, sourceId: cursor.sourceId, parks, boundaries: { type: "FeatureCollection", features: boundaries }, drive: { hubs, parks: drives }, assets, map: map ?? null });
      };
      rowsRequest.onsuccess = () => { rows = rowsRequest.result; finish(); };
      rowsRequest.onerror = () => fail(rowsRequest.error);
      cursorRequest.onsuccess = () => { cursor = cursorRequest.result; finish(); };
      cursorRequest.onerror = () => fail(cursorRequest.error);
    });
  }

  async getSyncCursor(environment: ContentEnvironment): Promise<ContentSyncCursor | null> {
    const db = await this.database();
    return waitForTransaction<ContentSyncCursor | null>(db, SYNC_CURSORS, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(SYNC_CURSORS).get(environment) as IDBRequest<SyncCursor | undefined>;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || !Number.isSafeInteger(cursor.revision) || typeof cursor.sourceId !== "string") complete(null);
        else complete({ revision: cursor.revision, sourceId: cursor.sourceId });
      };
      request.onerror = () => fail(request.error);
    });
  }

  async replaceSyncState(environment: ContentEnvironment, expectedRevision: number | null, state: ContentSyncState, sourceId: string, expectedSourceId: string | null, resetCursor = false): Promise<void> {
    if (!resetCursor && expectedRevision !== null && state.revision < expectedRevision) throw new Error("Content snapshot cannot move the sync cursor backwards");
    const db = await this.database();
    await waitForTransaction<void>(db, [SYNC_ROWS, SYNC_CURSORS, CACHED_MAP_POINTERS], "readwrite", (tx, complete, fail) => {
      const rowsStore = tx.objectStore(SYNC_ROWS);
      const getAll = rowsStore.getAll() as IDBRequest<SyncRow[]>;
      const cursorStore = tx.objectStore(SYNC_CURSORS);
      const cursorRequest = cursorStore.get(environment) as IDBRequest<SyncCursor | undefined>;
      let rowsReady = false;
      let cursorReady = false;
      const finish = () => {
        if (!rowsReady || !cursorReady) return;
        const current = cursorRequest.result;
        const cursorAbsent = current === undefined && expectedRevision === null && expectedSourceId === null;
        const cursorMatches = current !== undefined && Number.isSafeInteger(current.revision) && typeof current.sourceId === "string" &&
          current.revision === expectedRevision && current.sourceId === expectedSourceId;
        const resetMalformedCursor = resetCursor && expectedRevision === null && expectedSourceId === null && current !== undefined &&
          (!Number.isSafeInteger(current.revision) || typeof current.sourceId !== "string");
        if (!cursorAbsent && !cursorMatches && !resetMalformedCursor) {
          fail(new Error("Content sync cursor changed before the snapshot could be committed"));
          return;
        }
        for (const row of getAll.result) if (row.environment === environment) rowsStore.delete(row.key);
        for (const row of contentRows(environment, state)) rowsStore.put(row);
        cursorStore.put({ environment, revision: state.revision, sourceId } satisfies SyncCursor);
        if (state.map) tx.objectStore(CACHED_MAP_POINTERS).put({ environment, pointer: state.map } satisfies CachedMapPointer);
        complete(undefined);
      };
      getAll.onsuccess = () => { rowsReady = true; finish(); };
      getAll.onerror = () => fail(getAll.error);
      cursorRequest.onsuccess = () => { cursorReady = true; finish(); };
      cursorRequest.onerror = () => fail(cursorRequest.error);
    });
  }

  async applySyncBatch(environment: ContentEnvironment, expectedRevision: number, batch: ContentChangeBatch, sourceId: string): Promise<void> {
    const db = await this.database();
    await waitForTransaction<void>(db, [SYNC_ROWS, SYNC_CURSORS, CACHED_MAP_POINTERS], "readwrite", (tx, complete, fail) => {
      const cursorStore = tx.objectStore(SYNC_CURSORS);
      const request = cursorStore.get(environment) as IDBRequest<SyncCursor | undefined>;
      const allRowsRequest = tx.objectStore(SYNC_ROWS).getAll() as IDBRequest<SyncRow[]>;
      let cursorReady = false;
      let allRows: SyncRow[] | undefined;
      const finish = () => {
        if (!cursorReady || !allRows) return;
        const cursor = request.result;
        if (!cursor || !Number.isSafeInteger(cursor.revision) || typeof cursor.sourceId !== "string" || cursor.revision !== expectedRevision || cursor.sourceId !== sourceId || batch.revision !== expectedRevision + 1) {
          fail(new Error("Content sync cursor changed before the batch could be committed"));
          return;
        }
        const rowsStore = tx.objectStore(SYNC_ROWS);
        const maxPositions = new Map<SyncRow["entity"], number>();
        for (const row of allRows) {
          if (row.environment !== environment) continue;
          maxPositions.set(row.entity, Math.max(maxPositions.get(row.entity) ?? -1, row.position));
        }
        for (const change of batch.changes) {
          const key = syncKey(environment, change.entity, change.id);
          if (change.op === "delete") rowsStore.delete(key);
          else if (change.entity === "map" && change.value === null) rowsStore.delete(key);
          else {
            const existing = allRows.find((row) => row.environment === environment && row.entity === change.entity && row.id === change.id);
            const position = existing?.position ?? (maxPositions.get(change.entity) ?? -1) + 1;
            if (!existing) maxPositions.set(change.entity, position);
            rowsStore.put({ key, environment, entity: change.entity, id: change.id, value: change.value, position } satisfies SyncRow);
            if (change.entity === "map" && change.value) tx.objectStore(CACHED_MAP_POINTERS).put({ environment, pointer: change.value } satisfies CachedMapPointer);
          }
        }
        cursorStore.put({ environment, revision: batch.revision, sourceId } satisfies SyncCursor);
        complete(undefined);
      };
      request.onsuccess = () => { cursorReady = true; finish(); };
      request.onerror = () => fail(request.error);
      allRowsRequest.onsuccess = () => { allRows = allRowsRequest.result; finish(); };
      allRowsRequest.onerror = () => fail(allRowsRequest.error);
    });
  }

  async advanceSyncRevision(environment: ContentEnvironment, expectedRevision: number, revision: number, sourceId: string): Promise<void> {
    const db = await this.database();
    await waitForTransaction<void>(db, SYNC_CURSORS, "readwrite", (tx, complete, fail) => {
      const store = tx.objectStore(SYNC_CURSORS);
      const request = store.get(environment) as IDBRequest<SyncCursor | undefined>;
      request.onsuccess = () => {
        if (!request.result || request.result.revision !== expectedRevision || request.result.sourceId !== sourceId || revision < expectedRevision) {
          fail(new Error("Content sync cursor changed before the revision could advance"));
          return;
        }
        store.put({ environment, revision, sourceId } satisfies SyncCursor);
        complete(undefined);
      };
      request.onerror = () => fail(request.error);
    });
  }

  async getMapInventory(version: string): Promise<ContentMapInventory | null> {
    const db = await this.database();
    return waitForTransaction<ContentMapInventory | null>(db, MAP_INVENTORIES, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(MAP_INVENTORIES).get(version) as IDBRequest<MapInventoryRecord | undefined>;
      request.onsuccess = () => complete(request.result?.inventory ?? null);
      request.onerror = () => fail(request.error);
    });
  }

  async putMapInventory(inventory: ContentMapInventory): Promise<void> {
    const db = await this.database();
    await waitForTransaction<void>(db, MAP_INVENTORIES, "readwrite", (tx, complete, fail) => {
      const request = tx.objectStore(MAP_INVENTORIES).put({ version: inventory.version, inventory } satisfies MapInventoryRecord);
      request.onsuccess = () => complete(undefined);
      request.onerror = () => fail(request.error);
    });
  }

  async pruneMapInventories(keepVersions: readonly string[]): Promise<void> {
    const db = await this.database();
    const keep = new Set(keepVersions);
    await waitForTransaction<void>(db, MAP_INVENTORIES, "readwrite", (tx, complete, fail) => {
      const store = tx.objectStore(MAP_INVENTORIES);
      const request = store.getAll() as IDBRequest<MapInventoryRecord[]>;
      request.onsuccess = () => {
        for (const record of request.result) if (!keep.has(record.version)) store.delete(record.version);
        complete(undefined);
      };
      request.onerror = () => fail(request.error);
    });
  }

  async getCachedMapPointer(environment: ContentEnvironment): Promise<ContentMapPointer | null> {
    const db = await this.database();
    return waitForTransaction<ContentMapPointer | null>(db, CACHED_MAP_POINTERS, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(CACHED_MAP_POINTERS).get(environment) as IDBRequest<CachedMapPointer | undefined>;
      request.onsuccess = () => complete(request.result?.pointer ?? null);
      request.onerror = () => fail(request.error);
    });
  }

  async close(): Promise<void> {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }

  private async getFile(hash: string): Promise<FileRecord | undefined> {
    const db = await this.database();
    return waitForTransaction<FileRecord | undefined>(db, FILES, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(FILES).get(hash) as IDBRequest<FileRecord | undefined>;
      request.onsuccess = () => complete(request.result);
      request.onerror = () => fail(request.error);
    });
  }

  private database(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new Error("IndexedDB is unavailable"));
          return;
        }
        const request = indexedDB.open(DATABASE, VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          const tx = request.transaction;
          if (!db.objectStoreNames.contains(RELEASES)) db.createObjectStore(RELEASES, { keyPath: "id" });
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
          if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: "hash" });
          if (!db.objectStoreNames.contains(RETAINED_PARKS)) db.createObjectStore(RETAINED_PARKS, { keyPath: "parkId" });
          if (!db.objectStoreNames.contains(SYNC_ROWS)) db.createObjectStore(SYNC_ROWS, { keyPath: "key" });
          if (!db.objectStoreNames.contains(SYNC_CURSORS)) db.createObjectStore(SYNC_CURSORS, { keyPath: "environment" });
          if (!db.objectStoreNames.contains(MAP_INVENTORIES)) db.createObjectStore(MAP_INVENTORIES, { keyPath: "version" });
          if (!db.objectStoreNames.contains(CACHED_MAP_POINTERS)) db.createObjectStore(CACHED_MAP_POINTERS, { keyPath: "environment" });
          if (!db.objectStoreNames.contains(ARCHIVED_SCENES)) db.createObjectStore(ARCHIVED_SCENES, { keyPath: "key" });
          if (tx && tx.objectStoreNames.contains(SYNC_CURSORS)) {
            const cursorRequest = tx.objectStore(SYNC_CURSORS).openCursor();
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              const value = cursor.value as SyncCursor & { source?: unknown };
              if (typeof value.sourceId !== "string" && typeof value.source === "string") {
                cursor.update({ ...value, sourceId: value.source });
              }
              cursor.continue();
            };
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => reject(request.error ?? new Error("Could not open content database"));
        request.onblocked = () => reject(new Error("Opening the content database is blocked by another tab"));
      }).catch((error) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }

  private revokeHashUrls(hash: string) {
    for (const [key, url] of this.objectUrls) {
      if (key.startsWith(`${hash}\n`)) {
        URL.revokeObjectURL(url);
        this.objectUrls.delete(key);
      }
    }
  }
}
