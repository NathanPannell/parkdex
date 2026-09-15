import type { Directory, Encoding, FilesystemPlugin } from "@capacitor/filesystem";
import type { PhotoAsset } from "./native-capabilities";

/** The server rejects larger inputs; keep the local retry bounded as well. */
export const MAX_PHOTO_RETRY_BYTES = 8 * 1024 * 1024;

const ROOT_DIRECTORY = "parkdex-photo-retry-v1";
const PHOTO_FILE = "photo.bin";
const METADATA_FILE = "metadata.json";
const DATABASE_NAME = "parkdex-photo-retry-v1";
const DATABASE_VERSION = 1;
const DATABASE_STORE = "photos";

type PhotoRetryMetadata = {
  mimeType: string;
  fileName: string;
};

type StoredBrowserPhoto = {
  key: string;
  ownerKey: string;
  placeId: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
};

export type PhotoRetryStore = {
  save(ownerKey: string, placeId: string, photo: PhotoAsset): Promise<void | boolean>;
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

function assertSaveable(photo: PhotoAsset) {
  if (!photo.file || photo.file.size > MAX_PHOTO_RETRY_BYTES) {
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
    save: (ownerKey, placeId, photo) => serial(() => store.save(ownerKey, placeId, photo)),
    load: (ownerKey, placeId) => serial(() => store.load(ownerKey, placeId)),
    remove: (ownerKey, placeId) => serial(() => store.remove(ownerKey, placeId)),
    clearOwner: (ownerKey) => serial(() => store.clearOwner(ownerKey)),
  };
}

function memoryPhotoRetryStore(): PhotoRetryStore {
  const photos = new Map<string, StoredBrowserPhoto>();
  return queueMutations({
    async save(ownerKey, placeId, photo) {
      requireDurableOwner(ownerKey);
      assertSaveable(photo);
      const mimeType = normalizedMimeType(photo);
      photos.set(entryKey(ownerKey, placeId), {
        key: entryKey(ownerKey, placeId),
        ownerKey,
        placeId,
        blob: photo.file.slice(0, photo.file.size, mimeType),
        fileName: safeFileName(photo.file.name, mimeType),
        mimeType,
      });
    },
    async load(ownerKey, placeId) {
      if (!isDurablePhotoOwner(ownerKey)) return null;
      const saved = photos.get(entryKey(ownerKey, placeId));
      if (!saved) return null;
      const blob = saved.blob.slice(0, saved.blob.size, saved.mimeType);
      return { file: new File([blob], saved.fileName, { type: saved.mimeType }), mimeType: saved.mimeType };
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
    async save(ownerKey, placeId, photo) {
      requireDurableOwner(ownerKey);
      assertSaveable(photo);
      const mimeType = normalizedMimeType(photo);
      await request<void>((store, setResult, reject) => {
        const result = store.put({
          key: entryKey(ownerKey, placeId),
          ownerKey,
          placeId,
          blob: photo.file.slice(0, photo.file.size, mimeType),
          fileName: safeFileName(photo.file.name, mimeType),
          mimeType,
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
        return { file: new File([blob], saved.fileName, { type: saved.mimeType }), mimeType: saved.mimeType };
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
  const metadataFor = (ownerKey: string, placeId: string) => pathFor(ownerKey, placeId, METADATA_FILE);
  const photoFor = (ownerKey: string, placeId: string) => pathFor(ownerKey, placeId, PHOTO_FILE);
  const deleteIfPresent = async (path: string) => {
    try {
      await filesystem.deleteFile({ path, directory });
    } catch (error) {
      if (!isMissingFilesystemError(error)) throw error;
    }
  };
  const removeEntry = async (ownerKey: string, placeId: string) => {
    await deleteIfPresent(photoFor(ownerKey, placeId));
    await deleteIfPresent(metadataFor(ownerKey, placeId));
    try {
      await filesystem.rmdir({ path: entryDirectory(ownerKey, placeId), directory, recursive: true });
    } catch (error) {
      if (!isMissingFilesystemError(error)) throw error;
    }
  };

  return queueMutations({
    async save(ownerKey, placeId, photo) {
      requireDurableOwner(ownerKey);
      assertSaveable(photo);
      const mimeType = normalizedMimeType(photo);
      const photoPath = photoFor(ownerKey, placeId);
      const metadataPath = metadataFor(ownerKey, placeId);
      try {
        await filesystem.writeFile({ path: photoPath, directory, data: await base64For(photo.file), recursive: true });
        await filesystem.writeFile({
          path: metadataPath,
          directory,
          data: JSON.stringify({ mimeType, fileName: safeFileName(photo.file.name, mimeType) } satisfies PhotoRetryMetadata),
          encoding: utf8,
          recursive: true,
        });
      } catch (error) {
        await removeEntry(ownerKey, placeId).catch(() => undefined);
        throw error;
      }
    },
    async load(ownerKey, placeId) {
      if (!isDurablePhotoOwner(ownerKey)) return null;
      const metadataPath = metadataFor(ownerKey, placeId);
      const photoPath = photoFor(ownerKey, placeId);
      let metadata: PhotoRetryMetadata;
      let metadataResult: { data: string | Blob };
      try {
        metadataResult = await filesystem.readFile({ path: metadataPath, directory, encoding: utf8 });
      } catch (error) {
        if (isMissingFilesystemError(error)) {
          // A photo without its metadata is an interrupted two-file write. It
          // is not a usable retry, so remove the orphaned binary as well.
          await removeEntry(ownerKey, placeId);
          return null;
        }
        throw error;
      }
      try {
        const parsed = JSON.parse(typeof metadataResult.data === "string" ? metadataResult.data : "") as Partial<PhotoRetryMetadata>;
        if (typeof parsed.mimeType !== "string" || !parsed.mimeType.startsWith("image/") || typeof parsed.fileName !== "string") throw new Error("Invalid photo retry metadata.");
        metadata = { mimeType: parsed.mimeType, fileName: parsed.fileName };
      } catch {
        await removeEntry(ownerKey, placeId);
        return null;
      }
      let content: { data: string | Blob };
      try {
        content = await filesystem.readFile({ path: photoPath, directory });
      } catch (error) {
        if (isMissingFilesystemError(error)) {
          await deleteIfPresent(metadataPath);
          return null;
        }
        throw error;
      }
      try {
        const blob = asBlob(content.data, metadata.mimeType);
        if (blob.size > MAX_PHOTO_RETRY_BYTES) throw new Error("The saved photo is too large to retry.");
        return { file: new File([blob], metadata.fileName, { type: metadata.mimeType }), mimeType: metadata.mimeType };
      } catch {
        await removeEntry(ownerKey, placeId);
        return null;
      }
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
