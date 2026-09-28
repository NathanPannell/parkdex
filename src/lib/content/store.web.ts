import type { ContentStore, RetainedPark, StoredRelease } from "./contracts";

const DATABASE = "parkdex-content-v1";
const VERSION = 1;
const RELEASES = "releases";
const META = "meta";
const FILES = "files";
const RETAINED_PARKS = "retainedParks";
const ACTIVE_KEY = "activeReleaseId";

type MetaRecord = { key: string; value: string | null };
type FileRecord = { hash: string; size: number; bytes: Blob };
type RetainedRecord = { parkId: string; park: RetainedPark["park"]; sceneFile?: RetainedPark["sceneFile"] };

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
      request.onsuccess = () => complete(request.result);
      request.onerror = () => fail(request.error);
    });
  }

  async listReleases(): Promise<StoredRelease[]> {
    const db = await this.database();
    return waitForTransaction<StoredRelease[]>(db, RELEASES, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(RELEASES).getAll() as IDBRequest<StoredRelease[]>;
      request.onsuccess = () => complete(request.result);
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
    await waitForTransaction<void>(db, [FILES, META, RELEASES, RETAINED_PARKS], "readwrite", (tx, complete, fail) => {
      const activeRequest = tx.objectStore(META).get(ACTIVE_KEY) as IDBRequest<MetaRecord | undefined>;
      const retainedRequest = tx.objectStore(RETAINED_PARKS).getAll() as IDBRequest<RetainedRecord[]>;
      let ready = 0;
      let activeId: string | null = null;
      let activeRelease: StoredRelease | undefined;
      let retainedParks: RetainedRecord[] = [];
      const finish = () => {
        if (ready !== 2) return;
        const activeReferencesFile = activeRelease?.manifest.files.some((file) => file.sha256.toLowerCase() === key) ?? false;
        const retainedReferencesFile = retainedParks.some((park) => park.sceneFile?.sha256.toLowerCase() === key);
        if (activeReferencesFile || retainedReferencesFile) {
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
    });
    this.revokeHashUrls(key);
  }

  async getRetainedParks(): Promise<RetainedPark[]> {
    const db = await this.database();
    return waitForTransaction<RetainedPark[]>(db, RETAINED_PARKS, "readonly", (tx, complete, fail) => {
      const request = tx.objectStore(RETAINED_PARKS).getAll() as IDBRequest<RetainedRecord[]>;
      request.onsuccess = () => complete(request.result.map(({ park, sceneFile }) => ({ park, sceneFile })));
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
          store.put({
            parkId,
            park: retained.park,
            sceneFile: retained.sceneFile ?? request.result?.sceneFile,
          } satisfies RetainedRecord);
          remaining -= 1;
          if (remaining === 0) complete(undefined);
        };
        request.onerror = () => fail(request.error);
      }
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
          if (!db.objectStoreNames.contains(RELEASES)) db.createObjectStore(RELEASES, { keyPath: "id" });
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
          if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: "hash" });
          if (!db.objectStoreNames.contains(RETAINED_PARKS)) db.createObjectStore(RETAINED_PARKS, { keyPath: "parkId" });
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
