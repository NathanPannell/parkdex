// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeFilesystem = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
      files.set(path, data);
      return { uri: `file://${path}` };
    }),
    readFile: vi.fn(async ({ path }: { path: string }) => {
      const data = files.get(path);
      if (data === undefined) {
        const error = new Error(`File does not exist: ${path}`) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      return { data };
    }),
    deleteFile: vi.fn(async ({ path }: { path: string }) => {
      files.delete(path);
    }),
    readdir: vi.fn(async ({ path }: { path: string }) => {
      const prefix = `${path}/`;
      return {
        files: [...files.keys()]
          .filter((filePath) => filePath.startsWith(prefix))
          .map((filePath) => ({ name: filePath.slice(prefix.length) })),
      };
    }),
  };
});

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    writeFile: nativeFilesystem.writeFile,
    readFile: nativeFilesystem.readFile,
    deleteFile: nativeFilesystem.deleteFile,
    readdir: nativeFilesystem.readdir,
  },
}));

import {
  createNativeFilesystemRecentPlaceStore,
  resetRecentPlaceCacheForTests,
  type RecentPlaceCacheRecord,
} from "./place-cache";
import { registerNativePlatformStorage, resetPlatformStorageForTests, type KeyValueStore } from "./platform-storage";
import type { Place } from "./places";
import { parsePlaceVisitorDetails, type PlaceVisitorDetails } from "./visitor-details";

function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
  };
}

function reviewedDetails(): PlaceVisitorDetails {
  const reviewed = JSON.parse(readFileSync(resolve(process.cwd(), "../data/park-details.reviewed.json"), "utf8")) as {
    places: Array<{ placeId: string; visitorDetails: unknown }>;
  };
  const details = parsePlaceVisitorDetails(reviewed.places[0].visitorDetails);
  if (!details) throw new Error("The first reviewed place detail did not pass public validation.");
  return details;
}

function placeWithDetails(visitorDetails: PlaceVisitorDetails): Place {
  return {
    id: "island-banks-island",
    name: "Banks Island",
    category: "island",
    latitude: 53.3802,
    longitude: -129.7833,
    region: "North Coast",
    description: "An island in coastal British Columbia.",
    sourceUrl: "https://example.test/place",
    sourceName: "Example catalogue",
    visitorDetails,
  };
}

function cachedRecord(place: Place): RecentPlaceCacheRecord {
  return {
    placeId: place.id,
    viewedAt: 100,
    bundle: {
      place,
      boundary: null,
      boundaryVersion: "canonical-v1",
      visitorInformation: null,
      image: null,
      descriptionSource: null,
      area: null,
      sourceAttribution: {
        place: { name: place.sourceName, url: place.sourceUrl },
        boundary: null,
        photo: null,
      },
      photo: null,
      photoError: null,
      galleryPhotos: [],
      viewedAt: 100,
    },
  };
}

afterEach(() => {
  resetRecentPlaceCacheForTests();
  resetPlatformStorageForTests();
  nativeFilesystem.files.clear();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Reflect.deleteProperty(globalThis, "Capacitor");
});

describe("native recent place cache", () => {
  it("persists reviewed visitor details in the full app-private bundle and omits them from the geometry index", async () => {
    Object.defineProperty(globalThis, "Capacitor", {
      configurable: true,
      value: { isNativePlatform: () => true },
    });
    registerNativePlatformStorage(async () => ({ credentials: memoryStore(), journal: memoryStore() }));

    const sourcePlace = placeWithDetails(reviewedDetails());
    const firstStore = createNativeFilesystemRecentPlaceStore();
    await firstStore.saveAndPrune(cachedRecord(sourcePlace));

    // A new store instance exercises reading the serialized native file after an app restart.
    const reloadedStore = createNativeFilesystemRecentPlaceStore();
    const reloaded = await reloadedStore.get(sourcePlace.id);
    const geometry = await reloadedStore.listMetadata();

    expect(reloaded?.bundle.place.visitorDetails).toEqual(sourcePlace.visitorDetails);
    expect(reloaded?.bundle.boundaryVersion).toBe("canonical-v1");
    expect(geometry).toHaveLength(1);
    expect(geometry[0].place).not.toHaveProperty("visitorDetails");
    expect(geometry[0].boundaryVersion).toBe("canonical-v1");
  });
});
