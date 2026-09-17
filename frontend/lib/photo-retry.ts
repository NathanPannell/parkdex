import type { Directory, Encoding, FilesystemPlugin } from "@capacitor/filesystem";
import type { PhotoAsset } from "./native-capabilities";

/** Normalized retry inputs remain bounded independently from raw camera staging. */
export const MAX_PHOTO_RETRY_BYTES = 8 * 1024 * 1024;
export const MAX_RAW_PHOTO_STAGING_BYTES = 32 * 1024 * 1024;

const ROOT_DIRECTORY = "parkdex-photo-retry-v1";
const PHOTO_FILE = "photo.bin";
const METADATA_FILE = "metadata.json";
const NATIVE_SLOTS = ["slot-a", "slot-b"] as const;
const DATABASE_NAME = "parkdex-photo-retry-v1";
const DATABASE_VERSION = 1;
const DATABASE_STORE = "photos";

type PhotoRetryMetadata = {
  mimeType: string;
  fileName: string;
  processingState?: "raw" | "prepared";
  generation?: number;
  version?: number;
};

export type PhotoRetrySaveOptions = { rawStaging?: boolean };

type StoredBrowserPhoto = {
  key: string;
  ownerKey: string;
  placeId: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
  processingState?: "raw" | "prepared";
};

export type PhotoRetryStore = {
  save(ownerKey: string, placeId: string, photo: PhotoAsset, options?: PhotoRetrySaveOptions): Promise<void | boolean>;
  load(ownerKey: string, placeId: string): Promise<PhotoAsset | null>;
  remove(ownerKey: string, placeId: string): Promise<void>;
  clearOwner(ownerKey: string): Promise<void>;
};

/**
 * Only account ids are valid durable owners. In particular, the temporary
 * `account:current` label must never be used for persistent photo bytes.
 */
export function isDurablePhotoOwner(ownerKey: string | undefined): ownerKey is string {
  return Boolean(ownerKey && ownerKey !== "account:current" && ownerKey.startsWith("account:") && ownerKey.length > "account:".length);
}

function encoded(value: string) {
  return encodeURIComponent(value);
}

function ownerDirectory(ownerKey: string) {
  return `${ROOT_DIRECTORY}/${encoded(ownerKey)}`;
}

function entryDirectory(ownerKey: string, placeId: string) {
  return `${ownerDirectory(ownerKey)}/${encoded(placeId)}`;
}

function entryKey(ownerKey: string, placeId: string) {
  return `${ownerKey}\u0000${placeId}`;
}

function safeFileName(fileName: string, mimeType: string) {
  const fallback = mimeType === "image/png" ? "visit.png" : "visit.jpg";
  const normalized = fileName.split(/[\\/]/).pop()?.trim() ?? "";
  return (normalized || fallback).slice(0, 120);
}

function normalizedMimeType(photo: PhotoAsset) {
  const candidate = (photo.mimeType || photo.file.type || "image/jpeg").toLowerCase().split(";", 1)[0];
  return candidate.startsWith("image/") ? candidate : "image/jpeg";
}

function assertSaveable(photo: PhotoAsset, options?: PhotoRetrySaveOptions) {
  const maximumBytes = options?.rawStaging ? MAX_RAW_PHOTO_STAGING_BYTES : MAX_PHOTO_RETRY_BYTES;
  if (!photo.file || photo.file.size > maximumBytes) {
    throw new Error("The photo is too large to keep for retry.");
  }
}

function requireDurableOwner(ownerKey: string) {
  if (!isDurablePhotoOwner(ownerKey)) throw new Error("Photo retries require an authenticated account owner.");
}

function filesystemErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
}

function filesystemErrorMessage(error: unknown) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message)
    : error instanceof Error ? error.message : String(error);
}

/** Missing files are expected during cleanup; every other error is retained as a real failure. */
function isMissingFilesystemError(error: unknown) {
  return filesystemErrorCode(error) === "OS-PLUG-FILE-0008"
    || /(?:does not exist|not found|no such file)/i.test(filesystemErrorMessage(error));
}

function asBlob(data: string | Blob, mimeType: string) {
  if (data instanceof Blob) return data.type ? data : data.slice(0, data.size, mimeType);
  if (typeof atob !== "function") throw new Error("The saved photo could not be decoded.");
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function base64For(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  if (typeof btoa !== "function") throw new Error("The photo could not be saved for retry.");
  return btoa(binary);
}

function queueMutations(store: PhotoRetryStore): PhotoRetryStore {
  let previous = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>) => {
    const result = previous.then(operation);
    previous = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    save: (ownerKey, placeId, photo, options) => serial(() => store.save(ownerKey, placeId, photo, options)),
    load: (ownerKey, placeId) => serial(() => store.load(ownerKey, placeId)),
    remove: (ownerKey, placeId) => serial(() => store.remove(ownerKey, placeId)),
    clearOwner: (ownerKey) => serial(() => store.clearOwner(ownerKey)),
  };
}

function memoryPhotoRetryStore(): PhotoRetryStore {
  const photos = new Map<string, StoredBrowserPhoto>();
  return queueMutations({
    async save(ownerKey, placeId, photo, options) {
      requireDurableOwner(ownerKey);
      assertSaveable(photo, options);
      const mimeType = normalizedMimeType(photo);
      photos.set(entryKey(ownerKey, placeId), {
        key: entryKey(ownerKey, placeId),
        ownerKey,
        placeId,
        blob: photo.file.slice(0, photo.file.size, mimeType),
        fileName: safeFileName(photo.file.name, mimeType),
        mimeType,
        processingState: photo.processingState ?? "raw",
      });
    },
    async load(ownerKey, placeId) {
      if (!isDurablePhotoOwner(ownerKey)) return null;
      const saved = photos.get(entryKey(ownerKey, placeId));
      if (!saved) return null;
      const blob = saved.blob.slice(0, saved.blob.size, saved.mimeType);
      return { file: new File([blob], saved.fileName, { type: saved.mimeType }), mimeType: saved.mimeType, processingState: saved.processingState === "prepared" ? "prepared" : "raw" };
    },
    async remove(ownerKey, placeId) {
      if (!isDurablePhotoOwner(ownerKey)) return;
      photos.delete(entryKey(ownerKey, placeId));
    },
    async clearOwner(ownerKey) {
      if (!isDurablePhotoOwner(ownerKey)) return;
      for (const [key, saved] of photos) if (saved.ownerKey === ownerKey) photos.delete(key);
    },
  });
}

function indexedDbPhotoRetryStore(indexedDb: IDBFactory): PhotoRetryStore {
  let database: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (database) return database;
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
      request.onerror = () => reject(request.error ?? new Error("Photo retry storage could not be opened."));
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DATABASE_STORE)) {
          request.result.createObjectStore(DATABASE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
    }).catch((error) => {
      database = undefined;
      throw error;
    });
    return database;
  };
  const request = <T>(operation: (store: IDBObjectStore, setResult: (value: T) => void, reject: (reason?: unknown) => void) => void) => open().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(DATABASE_STORE, "readwrite");
    const store = transaction.objectStore(DATABASE_STORE);
    let result!: T;
    let resultSet = false;
    let settled = false;
    const fail = (reason?: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason ?? new Error("Photo retry storage failed."));
    };
    transaction.onerror = () => fail(transaction.error);
    transaction.onabort = () => fail(transaction.error);
    transaction.oncomplete = () => {
      if (settled) return;
      if (!resultSet) {
        fail(new Error("Photo retry storage completed without a result."));
        return;
      }
      settled = true;
      resolve(result);
    };
    try {
      operation(store, (value) => { result = value; resultSet = true; }, fail);
    } catch (error) {
      fail(error);
      try { transaction.abort(); } catch { /* transaction may already be complete */ }
    }
  }));

  return queueMutations({
    async save(ownerKey, placeId, photo, options) {
      requireDurableOwner(ownerKey);
      assertSaveable(photo, options);
      const mimeType = normalizedMimeType(photo);
      await request<void>((store, setResult, reject) => {
        const result = store.put({
          key: entryKey(ownerKey, placeId),
          ownerKey,
          placeId,
          blob: photo.file.slice(0, photo.file.size, mimeType),
          fileName: safeFileName(photo.file.name, mimeType),
          mimeType,
          processingState: photo.processingState ?? "raw",
        } satisfies StoredBrowserPhoto);
        result.onerror = () => reject(result.error);
        result.onsuccess = () => setResult();
      });
    },
    async load(ownerKey, placeId) {
      if (!isDurablePhotoOwner(ownerKey)) return null;
      return request<StoredBrowserPhoto | undefined>((store, setResult, reject) => {
        const result = store.get(entryKey(ownerKey, placeId));
        result.onerror = () => reject(result.error);
        result.onsuccess = () => setResult(result.result as StoredBrowserPhoto | undefined);
      }).then((saved) => {
        if (!saved) return null;
        const blob = saved.blob.slice(0, saved.blob.size, saved.mimeType);
        return { file: new File([blob], saved.fileName, { type: saved.mimeType }), mimeType: saved.mimeType, processingState: saved.processingState === "prepared" ? "prepared" : "raw" };
      });
    },
    async remove(ownerKey, placeId) {
      if (!isDurablePhotoOwner(ownerKey)) return;
      await request<void>((store, setResult, reject) => {
        const result = store.delete(entryKey(ownerKey, placeId));
        result.onerror = () => reject(result.error);
        result.onsuccess = () => setResult();
      });
    },
    async clearOwner(ownerKey) {
      if (!isDurablePhotoOwner(ownerKey)) return;
      const saved = await request<StoredBrowserPhoto[]>((store, setResult, reject) => {
        const result = store.getAll();
        result.onerror = () => reject(result.error);
        result.onsuccess = () => setResult(result.result as StoredBrowserPhoto[]);
      });
      const ownerEntries = saved.filter((photo) => photo.ownerKey === ownerKey).map((photo) => photo.key);
      for (const key of ownerEntries) {
        await request<void>((store, setResult, reject) => {
          const result = store.delete(key);
          result.onerror = () => reject(result.error);
          result.onsuccess = () => setResult();
        });
      }
    },
  });
}

/** Browser fallback: same-origin IndexedDB, with an in-memory fallback if unavailable. */
export function createBrowserPhotoRetryStore(): PhotoRetryStore {
  if (typeof indexedDB !== "undefined") return indexedDbPhotoRetryStore(indexedDB);
  return memoryPhotoRetryStore();
}

function nativePhotoRetryStore(filesystem: Pick<FilesystemPlugin, "readFile" | "writeFile" | "deleteFile" | "rmdir">, directory: Directory, utf8: Encoding): PhotoRetryStore {
  const pathFor = (ownerKey: string, placeId: string, fileName: string) => `${entryDirectory(ownerKey, placeId)}/${fileName}`;
  const legacyMetadataFor = (ownerKey: string, placeId: string) => pathFor(ownerKey, placeId, METADATA_FILE);
  const legacyPhotoFor = (ownerKey: string, placeId: string) => pathFor(ownerKey, placeId, PHOTO_FILE);
  const slotPathFor = (ownerKey: string, placeId: string, slot: typeof NATIVE_SLOTS[number], fileName: string) => pathFor(ownerKey, placeId, `${slot}/${fileName}`);
  const slotMetadataFor = (ownerKey: string, placeId: string, slot: typeof NATIVE_SLOTS[number]) => slotPathFor(ownerKey, placeId, slot, METADATA_FILE);
  const slotPhotoFor = (ownerKey: string, placeId: string, slot: typeof NATIVE_SLOTS[number]) => slotPathFor(ownerKey, placeId, slot, PHOTO_FILE);
  const deleteIfPresent = async (path: string) => {
    try {
      await filesystem.deleteFile({ path, directory });
    } catch (error) {
      if (!isMissingFilesystemError(error)) throw error;
    }
  };
  const removePair = async (photoPath: string, metadataPath: string) => {
    await deleteIfPresent(photoPath);
    await deleteIfPresent(metadataPath);
  };
  const removeEntry = async (ownerKey: string, placeId: string) => {
    await removePair(legacyPhotoFor(ownerKey, placeId), legacyMetadataFor(ownerKey, placeId));
    for (const slot of NATIVE_SLOTS) {
      await removePair(slotPhotoFor(ownerKey, placeId, slot), slotMetadataFor(ownerKey, placeId, slot));
    }
    try {
      await filesystem.rmdir({ path: entryDirectory(ownerKey, placeId), directory, recursive: true });
    } catch (error) {
      if (!isMissingFilesystemError(error)) throw error;
    }
  };
  const parseMetadata = (result: { data: string | Blob }, requireVersion: boolean): PhotoRetryMetadata | null => {
    try {
      const parsed = JSON.parse(typeof result.data === "string" ? result.data : "") as Partial<PhotoRetryMetadata>;
      if (typeof parsed.mimeType !== "string" || !parsed.mimeType.startsWith("image/") || typeof parsed.fileName !== "string") return null;
      if (requireVersion && (![2, 3].includes(Number(parsed.version)) || !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 1)) return null;
      return {
        mimeType: parsed.mimeType,
        fileName: parsed.fileName,
        processingState: parsed.version === 3 && parsed.processingState === "prepared" ? "prepared" : "raw",
        generation: parsed.generation,
        version: parsed.version,
      };
    } catch {
      return null;
    }
  };
  const readMetadata = async (path: string, requireVersion: boolean) => {
    try {
      return parseMetadata(await filesystem.readFile({ path, directory, encoding: utf8 }), requireVersion);
    } catch (error) {
      if (isMissingFilesystemError(error)) return null;
      throw error;
    }
  };
  const readCandidate = async (
    photoPath: string,
    metadataPath: string,
    requireVersion: boolean,
  ): Promise<{ asset: PhotoAsset; generation: number } | null> => {
    const metadata = await readMetadata(metadataPath, requireVersion);
    if (!metadata) {
      await removePair(photoPath, metadataPath).catch(() => undefined);
      return null;
    }
    let content: { data: string | Blob };
    try {
      content = await filesystem.readFile({ path: photoPath, directory });
    } catch (error) {
      if (isMissingFilesystemError(error)) {
        await removePair(photoPath, metadataPath).catch(() => undefined);
        return null;
      }
      throw error;
    }
    try {
      const blob = asBlob(content.data, metadata.mimeType);
      if (blob.size > MAX_RAW_PHOTO_STAGING_BYTES) throw new Error("The saved photo is too large to retry.");
      return {
        asset: { file: new File([blob], metadata.fileName, { type: metadata.mimeType }), mimeType: metadata.mimeType, processingState: metadata.processingState ?? "raw" },
        generation: metadata.generation ?? 0,
      };
    } catch {
      await removePair(photoPath, metadataPath).catch(() => undefined);
      return null;
    }
  };

  return queueMutations({
    async save(ownerKey, placeId, photo, options) {
      requireDurableOwner(ownerKey);
      assertSaveable(photo, options);
      const mimeType = normalizedMimeType(photo);
      const committed = [] as Array<{ slot: typeof NATIVE_SLOTS[number]; generation: number }>;
      for (const slot of NATIVE_SLOTS) {
        const metadata = await readMetadata(slotMetadataFor(ownerKey, placeId, slot), true);
        if (metadata) committed.push({ slot, generation: metadata.generation ?? 0 });
      }
      const active = committed.sort((left, right) => right.generation - left.generation)[0];
      const targetSlot = active?.slot === "slot-a" ? "slot-b" : "slot-a";
      const nextGeneration = (active?.generation ?? 0) + 1;
      const photoPath = slotPhotoFor(ownerKey, placeId, targetSlot);
      const metadataPath = slotMetadataFor(ownerKey, placeId, targetSlot);
      try {
        await filesystem.writeFile({ path: photoPath, directory, data: await base64For(photo.file), recursive: true });
        await filesystem.writeFile({
          path: metadataPath,
          directory,
          data: JSON.stringify({ mimeType, fileName: safeFileName(photo.file.name, mimeType), processingState: photo.processingState ?? "raw", generation: nextGeneration, version: 3 } satisfies PhotoRetryMetadata),
          encoding: utf8,
          recursive: true,
        });
      } catch (error) {
        // The target slot is not committed until its metadata write succeeds.
        // Removing only that slot preserves the previously committed photo.
        await removePair(photoPath, metadataPath).catch(() => undefined);
        throw error;
      }
      for (const slot of NATIVE_SLOTS) {
        if (slot !== targetSlot) await removePair(slotPhotoFor(ownerKey, placeId, slot), slotMetadataFor(ownerKey, placeId, slot)).catch(() => undefined);
      }
      await removePair(legacyPhotoFor(ownerKey, placeId), legacyMetadataFor(ownerKey, placeId)).catch(() => undefined);
    },
    async load(ownerKey, placeId) {
      if (!isDurablePhotoOwner(ownerKey)) return null;
      const candidates = [] as Array<{ slot: typeof NATIVE_SLOTS[number]; asset: PhotoAsset; generation: number }>;
      for (const slot of NATIVE_SLOTS) {
        const candidate = await readCandidate(slotPhotoFor(ownerKey, placeId, slot), slotMetadataFor(ownerKey, placeId, slot), true);
        if (candidate) candidates.push({ slot, ...candidate });
      }
      const selected = candidates.sort((left, right) => right.generation - left.generation)[0];
      if (selected) {
        for (const candidate of candidates) {
          if (candidate.slot !== selected.slot) await removePair(slotPhotoFor(ownerKey, placeId, candidate.slot), slotMetadataFor(ownerKey, placeId, candidate.slot)).catch(() => undefined);
        }
        await removePair(legacyPhotoFor(ownerKey, placeId), legacyMetadataFor(ownerKey, placeId)).catch(() => undefined);
        return selected.asset;
      }
      const legacy = await readCandidate(legacyPhotoFor(ownerKey, placeId), legacyMetadataFor(ownerKey, placeId), false);
      return legacy?.asset ?? null;
    },
    async remove(ownerKey, placeId) {
      if (!isDurablePhotoOwner(ownerKey)) return;
      await removeEntry(ownerKey, placeId);
    },
    async clearOwner(ownerKey) {
      if (!isDurablePhotoOwner(ownerKey)) return;
      try {
        await filesystem.rmdir({ path: ownerDirectory(ownerKey), directory, recursive: true });
      } catch (error) {
        if (!isMissingFilesystemError(error)) throw error;
      }
    },
  });
}

/** Factory used by the Capacitor bridge; kept here to make native storage easy to test. */
export function createNativePhotoRetryStore(filesystem: Parameters<typeof nativePhotoRetryStore>[0], directory: Directory, utf8: Encoding) {
  return nativePhotoRetryStore(filesystem, directory, utf8);
}
