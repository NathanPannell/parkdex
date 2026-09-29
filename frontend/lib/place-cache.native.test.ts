import { afterEach, describe, expect, it, vi } from "vitest";

const nativeFiles = vi.hoisted(() => {
  const files = new Map<string, string>();
  const controls = { holdGalleryWrite: null as Promise<void> | null, failGalleryIndex: -1 };
  return {
    files,
    controls,
    writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
      const galleryIndex = Number(path.match(/\.gallery-(\d+)\.photo$/)?.[1] ?? -1);
      if (galleryIndex === 0 && controls.holdGalleryWrite) await controls.holdGalleryWrite;
      if (galleryIndex >= 0 && galleryIndex === controls.failGalleryIndex) {
        controls.failGalleryIndex = -1;
        throw new Error("gallery file write failed");
      }
      files.set(path, data);
      return { uri: path };
    }),
    readFile: vi.fn(async ({ path }: { path: string }) => {
      const data = files.get(path);
      if (data === undefined) throw Object.assign(new Error("File does not exist"), { code: "ENOENT" });
      return { data };
    }),
    deleteFile: vi.fn(async ({ path }: { path: string }) => {
      if (!files.delete(path)) throw Object.assign(new Error("File does not exist"), { code: "ENOENT" });
    }),
    readdir: vi.fn(async ({ path }: { path: string }) => ({
      files: [...files.keys()]
        .filter((filePath) => filePath.startsWith(`${path}/`))
        .map((filePath) => ({ name: filePath.slice(path.length + 1) })),
    })),
  };
});

const nativeStorage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failNextSet: false,
}));

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Encoding: { UTF8: "UTF8" },
  Filesystem: nativeFiles,
}));

vi.mock("./platform-storage", () => ({
  getPlatformStorage: vi.fn(async () => ({
    getItem: async (key: string) => nativeStorage.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (nativeStorage.failNextSet) {
        nativeStorage.failNextSet = false;
        throw new Error("native index write failed");
      }
      nativeStorage.values.set(key, value);
    },
    removeItem: async (key: string) => { nativeStorage.values.delete(key); },
  })),
}));

import {
  createNativeFilesystemRecentPlaceStore,
  resetRecentPlaceCacheForTests,
  type CachedPlaceBundle,
  type RecentPlaceCacheRecord,
} from "./place-cache";
import { getPlaceImages } from "./place-images";
import type { Place } from "./places";

const NATIVE_INDEX_KEY = "parkdex:recent-place-cache:v1";
const NATIVE_CACHE_DIRECTORY = "parkdex-recent-place-cache";

function place(id: string): Place {
  return {
    id,
    name: "Bear Creek Park",
    category: "provincial",
    latitude: 49,
    longitude: -124,
    region: "Coast",
    description: "A public place description.",
    sourceUrl: "https://example.test/place",
    sourceName: "Place source",
  };
}

function record(
  viewedAt: number,
  photoText = "primary full photo",
  placeId = "provincial-bear-creek-park",
): RecentPlaceCacheRecord {
  const images = getPlaceImages("provincial-bear-creek-park");
  const bundle: CachedPlaceBundle = {
    place: place(placeId),
    boundary: null,
    boundaryVersion: "canonical-v2",
    visitorInformation: null,
    image: images[0] ?? null,
    descriptionSource: null,
    area: null,
    sourceAttribution: {
      place: { name: "Place source", url: "https://example.test/place" },
      boundary: null,
      photo: images[0] ? {
        creator: images[0].creator,
        license: images[0].license,
        licenseUrl: images[0].licenseUrl,
        sourceUrl: images[0].sourceUrl,
        originalUrl: images[0].originalUrl,
      } : null,
    },
    photo: new Blob([photoText], { type: "image/webp" }),
    photoError: null,
    galleryPhotos: images.slice(1).map((image) => ({
      image,
      photo: new Blob(["alternate full photo"], { type: "image/webp" }),
      photoError: null,
    })),
    viewedAt,
  };
  return { placeId, viewedAt, bundle };
}

afterEach(() => {
  nativeFiles.files.clear();
  nativeFiles.writeFile.mockClear();
  nativeFiles.readFile.mockClear();
  nativeFiles.deleteFile.mockClear();
  nativeFiles.readdir.mockClear();
  nativeFiles.controls.holdGalleryWrite = null;
  nativeFiles.controls.failGalleryIndex = -1;
  nativeStorage.values.clear();
  nativeStorage.failNextSet = false;
  resetRecentPlaceCacheForTests();
});

describe("native recent place photo storage", () => {
  it("round-trips the full primary and alternate photos while metadata-only listing skips photo files", async () => {
    const store = createNativeFilesystemRecentPlaceStore();
    const saved = record(42);
    await store.saveAndPrune(saved);
    const manifest = JSON.parse(nativeStorage.values.get(NATIVE_INDEX_KEY) ?? "{}") as {
      entries: Array<{ path: string; photoPath: string | null; galleryPhotoPaths?: Array<string | null>; fileId?: string }>;
    };
    const entry = manifest.entries[0];

    expect(entry.fileId).toMatch(/^[a-z0-9-]+$/);
    expect(entry.galleryPhotoPaths).toHaveLength(1);
    expect(nativeFiles.files.has(entry.path)).toBe(true);
    expect(entry.photoPath && nativeFiles.files.has(entry.photoPath)).toBe(true);
    expect(entry.galleryPhotoPaths?.[0] && nativeFiles.files.has(entry.galleryPhotoPaths[0])).toBe(true);

    nativeFiles.readFile.mockClear();
    const metadata = await store.listMetadata();
    expect(metadata).toHaveLength(1);
    expect(nativeFiles.readFile.mock.calls.every(([call]) => call.path.endsWith(".json"))).toBe(true);
    expect("photo" in metadata[0]!).toBe(false);

    const reopened = await store.get(saved.placeId);
    expect(await reopened?.bundle.photo?.text()).toBe("primary full photo");
    expect(await reopened?.bundle.galleryPhotos[0]?.photo?.text()).toBe("alternate full photo");
    expect(reopened?.bundle.galleryPhotos[0]?.image.creator).toBe(saved.bundle.galleryPhotos[0]?.image.creator);
  });

  it("keeps exactly 20 native place bundles and removes every file for the evicted gallery", async () => {
    const store = createNativeFilesystemRecentPlaceStore();
    for (let index = 0; index < 21; index += 1) {
      await store.saveAndPrune(record(index + 1, `photo-${index}`, `native-place-${index}`));
    }
    const manifest = JSON.parse(nativeStorage.values.get(NATIVE_INDEX_KEY) ?? "{}") as {
      entries: Array<{ placeId: string }>;
    };
    const evictedPrefix = `${NATIVE_CACHE_DIRECTORY}/native-place-0-1-`;

    expect(manifest.entries).toHaveLength(20);
    expect(manifest.entries.some((entry) => entry.placeId === "native-place-0")).toBe(false);
    expect([...nativeFiles.files.keys()].some((path) => path.startsWith(evictedPrefix))).toBe(false);
    expect(await store.get("native-place-0")).toBeNull();
    expect((await store.get("native-place-20"))?.bundle.galleryPhotos).toHaveLength(1);
  });

  it("keeps the previous bundle and its photo files intact if replacement index commit fails", async () => {
    const store = createNativeFilesystemRecentPlaceStore();
    const saved = record(42, "previous primary photo");
    await store.saveAndPrune(saved);
    const oldManifest = nativeStorage.values.get(NATIVE_INDEX_KEY);
    const oldPaths = [...nativeFiles.files.keys()];

    nativeStorage.failNextSet = true;
    await expect(store.saveAndPrune(record(42, "replacement primary photo"))).rejects.toThrow("index write failed");

    expect(nativeStorage.values.get(NATIVE_INDEX_KEY)).toBe(oldManifest);
    expect([...nativeFiles.files.keys()].sort()).toEqual(oldPaths.sort());
    expect(await (await store.get(saved.placeId))?.bundle.photo?.text()).toBe("previous primary photo");
  });

  it("waits for every gallery write to settle before cleaning up a failed replacement", async () => {
    const store = createNativeFilesystemRecentPlaceStore();
    const saved = record(42);
    await store.saveAndPrune(saved);
    const oldPaths = [...nativeFiles.files.keys()].sort();
    const replacement = record(42, "replacement primary photo");
    replacement.bundle.galleryPhotos.push({
      ...replacement.bundle.galleryPhotos[0]!,
      photo: new Blob(["second alternate full photo"], { type: "image/webp" }),
    });
    nativeFiles.controls.failGalleryIndex = 1;
    let releaseFirstGalleryWrite!: () => void;
    nativeFiles.controls.holdGalleryWrite = new Promise<void>((resolve) => { releaseFirstGalleryWrite = resolve; });

    let settled = false;
    const pending = store.saveAndPrune(replacement).finally(() => { settled = true; });
    await vi.waitFor(() => expect(nativeFiles.writeFile.mock.calls.some(([call]) => call.path.includes(".gallery-1.photo"))).toBe(true));
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFirstGalleryWrite();

    await expect(pending).rejects.toThrow("gallery file write failed");
    expect([...nativeFiles.files.keys()].sort()).toEqual(oldPaths);
    expect(await (await store.get(saved.placeId))?.bundle.galleryPhotos).toHaveLength(1);
  });

  it("reads legacy v1 manifests and bundles that contain only a primary photo", async () => {
    const placeId = "provincial-bear-creek-park";
    const legacyName = `${encodeURIComponent(placeId)}-7`;
    const recordPath = `${NATIVE_CACHE_DIRECTORY}/${legacyName}.json`;
    const photoPath = `${NATIVE_CACHE_DIRECTORY}/${legacyName}.photo`;
    const legacy = record(7);
    const legacyBundle: Partial<CachedPlaceBundle> = { ...legacy.bundle };
    delete legacyBundle.photo;
    delete legacyBundle.galleryPhotos;
    nativeStorage.values.set(NATIVE_INDEX_KEY, JSON.stringify({
      version: 1,
      lastViewedAt: 7,
      entries: [{ placeId, viewedAt: 7, path: recordPath, photoPath }],
    }));
    nativeFiles.files.set(recordPath, JSON.stringify({
      record: { ...legacy, bundle: legacyBundle },
      photoType: "image/webp",
    }));
    nativeFiles.files.set(photoPath, btoa("legacy full photo"));

    const reopened = await createNativeFilesystemRecentPlaceStore().get(placeId);

    expect(await reopened?.bundle.photo?.text()).toBe("legacy full photo");
    expect(reopened?.bundle.galleryPhotos).toEqual([]);
  });
});
