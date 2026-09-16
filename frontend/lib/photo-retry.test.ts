// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Directory, Encoding } from "@capacitor/filesystem";
import { IDBFactory, IDBDatabase } from "fake-indexeddb";
import { createBrowserPhotoRetryStore, createNativePhotoRetryStore, MAX_PHOTO_RETRY_BYTES } from "./photo-retry";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function photo(contents = "private photo") {
  const file = new File([contents], "field-note.jpg", { type: "image/jpeg" });
  return { file, mimeType: file.type };
}

describe("photo retry storage", () => {
  it("stores binary data by account and place and removes only the requested entry", async () => {
    const store = createBrowserPhotoRetryStore();

    await store.save("account:first", "place-a", photo());
    await store.save("account:first", "place-b", photo("second"));
    await store.save("account:second", "place-a", photo("other account"));

    await expect(store.load("account:first", "place-a")).resolves.toMatchObject({ file: expect.any(File), mimeType: "image/jpeg" });
    await expect(store.load("account:first", "place-a").then((value) => value?.file.text())).resolves.toBe("private photo");
    await expect(store.load("account:second", "place-a").then((value) => value?.file.text())).resolves.toBe("other account");

    await store.remove("account:first", "place-a");
    await expect(store.load("account:first", "place-a")).resolves.toBeNull();
    await expect(store.load("account:first", "place-b")).resolves.toMatchObject({ mimeType: "image/jpeg" });
    await expect(store.load("account:second", "place-a")).resolves.toMatchObject({ mimeType: "image/jpeg" });
  });

  it("clears one account without exposing guest or temporary owners", async () => {
    const store = createBrowserPhotoRetryStore();

    await expect(store.save("guest:shared-device", "place-a", photo())).rejects.toThrow(/authenticated account owner/i);
    await expect(store.save("account:current", "place-a", photo())).rejects.toThrow(/authenticated account owner/i);
    await store.save("account:first", "place-a", photo());
    await store.save("account:second", "place-a", photo("keep"));

    await store.clearOwner("account:first");

    await expect(store.load("account:first", "place-a")).resolves.toBeNull();
    await expect(store.load("account:second", "place-a").then((value) => value?.file.text())).resolves.toBe("keep");
    await expect(store.load("guest:shared-device", "place-a")).resolves.toBeNull();
    await expect(store.load("account:current", "place-a")).resolves.toBeNull();
  });

  it("does not retain oversized inputs", async () => {
    const store = createBrowserPhotoRetryStore();
    const oversized = new File([new Uint8Array(MAX_PHOTO_RETRY_BYTES + 1)], "large.jpg", { type: "image/jpeg" });

    await expect(store.save("account:first", "place-a", { file: oversized, mimeType: oversized.type })).rejects.toThrow(/too large/i);
    await expect(store.load("account:first", "place-a")).resolves.toBeNull();
  });

  it("waits for IndexedDB transaction completion and rejects aborted operations", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const originalTransaction = IDBDatabase.prototype.transaction;
    let abortNextTransaction = false;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
      const transaction = originalTransaction.apply(this, args);
      if (!abortNextTransaction) return transaction;
      abortNextTransaction = false;
      const originalObjectStore = transaction.objectStore.bind(transaction);
      transaction.objectStore = (name) => {
        const store = originalObjectStore(name);
        const methods = store as unknown as Record<string, (...operationArgs: unknown[]) => IDBRequest>;
        for (const method of ["put", "get", "delete", "getAll"] as const) {
          const originalOperation = methods[method].bind(store);
          methods[method] = (...operationArgs) => {
            const request = originalOperation(...operationArgs);
            request.addEventListener("success", () => transaction.abort(), { once: true });
            return request;
          };
        }
        return store;
      };
      return transaction;
    });
    const store = createBrowserPhotoRetryStore();

    await store.save("account:first", "place-a", photo());
    abortNextTransaction = true;
    await expect(store.save("account:first", "place-b", photo("aborted"))).rejects.toThrow(/storage failed/i);
    await store.save("account:first", "place-a", photo());
    abortNextTransaction = true;
    await expect(store.load("account:first", "place-a")).rejects.toThrow(/storage failed/i);
    abortNextTransaction = true;
    await expect(store.remove("account:first", "place-a")).rejects.toThrow(/storage failed/i);

    await store.save("account:first", "place-b", photo("second"));
    abortNextTransaction = true;
    await expect(store.clearOwner("account:first")).rejects.toThrow(/storage failed/i);
    await store.clearOwner("account:first");
    await expect(store.load("account:first", "place-a")).resolves.toBeNull();
    await expect(store.load("account:first", "place-b")).resolves.toBeNull();
  });

  it("keeps native photo bytes in Filesystem Data instead of Preferences", async () => {
    const files = new Map<string, { data: string; encoding?: Encoding }>();
    const filesystem = {
      writeFile: vi.fn(async ({ path, data, encoding }: { path: string; data: string; encoding?: Encoding }) => { files.set(path, { data, encoding }); return { uri: `file://${path}` }; }),
      readFile: vi.fn(async ({ path }: { path: string }) => {
        const saved = files.get(path);
        if (!saved) throw new Error("not found");
        return { data: saved.data };
      }),
      deleteFile: vi.fn(async ({ path }: { path: string }) => { files.delete(path); }),
      rmdir: vi.fn(async ({ path }: { path: string }) => { for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key); }),
    };
    const store = createNativePhotoRetryStore(filesystem as never, Directory.Data, Encoding.UTF8);

    await store.save("account:first", "place-a", photo());

    expect([...files.keys()]).toEqual(expect.arrayContaining([
      "parkdex-photo-retry-v1/account%3Afirst/place-a/photo.bin",
      "parkdex-photo-retry-v1/account%3Afirst/place-a/metadata.json",
    ]));
    await expect(store.load("account:first", "place-a").then((value) => value?.file.text())).resolves.toBe("private photo");
    await store.remove("account:first", "place-a");
    expect(files).toHaveLength(0);
  });

  it("removes an interrupted photo-only write when native metadata is missing", async () => {
    const files = new Map<string, { data: string; encoding?: Encoding }>();
    const filesystem = {
      writeFile: vi.fn(async ({ path, data, encoding }: { path: string; data: string; encoding?: Encoding }) => { files.set(path, { data, encoding }); return { uri: `file://${path}` }; }),
      readFile: vi.fn(async ({ path }: { path: string }) => {
        const saved = files.get(path);
        if (!saved) throw new Error("not found");
        return { data: saved.data };
      }),
      deleteFile: vi.fn(async ({ path }: { path: string }) => { files.delete(path); }),
      rmdir: vi.fn(async ({ path }: { path: string }) => { for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key); }),
    };
    const store = createNativePhotoRetryStore(filesystem as never, Directory.Data, Encoding.UTF8);
    const photoPath = "parkdex-photo-retry-v1/account%3Afirst/place-a/photo.bin";
    files.set(photoPath, { data: "interrupted-binary" });

    await expect(store.load("account:first", "place-a")).resolves.toBeNull();
    expect(files).toHaveLength(0);
    expect(filesystem.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: photoPath, directory: Directory.Data }));
  });

  it("keeps the native copy when a read or delete fails transiently", async () => {
    const files = new Map<string, { data: string; encoding?: Encoding }>();
    let readFailure: Error | undefined;
    let deleteFailure: Error | undefined;
    const removeDirectoryFailure: { error?: Error } = {};
    const filesystem = {
      writeFile: vi.fn(async ({ path, data, encoding }: { path: string; data: string; encoding?: Encoding }) => { files.set(path, { data, encoding }); return { uri: `file://${path}` }; }),
      readFile: vi.fn(async ({ path }: { path: string }) => {
        if (readFailure && path.endsWith("/photo.bin")) throw readFailure;
        const saved = files.get(path);
        if (!saved) throw new Error("not found");
        return { data: saved.data };
      }),
      deleteFile: vi.fn(async ({ path }: { path: string }) => {
        if (deleteFailure) throw deleteFailure;
        if (!files.has(path)) throw new Error("not found");
        files.delete(path);
      }),
      rmdir: vi.fn(async ({ path }: { path: string }) => {
        if (removeDirectoryFailure.error) throw removeDirectoryFailure.error;
        for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      }),
    };
    const store = createNativePhotoRetryStore(filesystem as never, Directory.Data, Encoding.UTF8);
    const photoPath = "parkdex-photo-retry-v1/account%3Afirst/place-a/photo.bin";

    await store.save("account:first", "place-a", photo());
    readFailure = new Error("temporarily unavailable");
    await expect(store.load("account:first", "place-a")).rejects.toThrow("temporarily unavailable");
    expect(files.has(photoPath)).toBe(true);

    readFailure = undefined;
    deleteFailure = new Error("permission denied");
    await expect(store.remove("account:first", "place-a")).rejects.toThrow("permission denied");
    expect(files.has(photoPath)).toBe(true);

    deleteFailure = undefined;
    removeDirectoryFailure.error = new Error("filesystem busy");
    await expect(store.clearOwner("account:first")).rejects.toThrow("filesystem busy");
    expect(files.has(photoPath)).toBe(true);
  });
});
