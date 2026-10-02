import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentChangeBatch, ContentFile, ContentSyncState } from "./contracts";
import { applyContentChangeBatch } from "./manifest";
import type { Park } from "../parks";
import { WebContentStore } from "./store.web";

const DATABASE = "parkdex-content-v1";
const ENVIRONMENT = "staging" as const;
const SOURCE = "staging-api-a";
const PARK_ID = "regional-content-sync-test";
const HUBS = [{ name: "Victoria", lng: -123.3656, lat: 48.4284 }];

function park(scene: string | null, blurb = "A sync fixture park."): Park {
  return {
    id: PARK_ID,
    name: "Content Sync Fixture Park",
    short: "Sync Fixture",
    category: "regional",
    region: "Victoria",
    lat: 48.4,
    lng: -123.3,
    biome: "forest",
    shape: "circle",
    rarity: "common",
    scene,
    seed: 42,
    blurb,
  };
}

function boundary(): ContentSyncState["boundaries"]["features"][number] {
  const west = -123.31;
  const south = 48.39;
  return {
    type: "Feature",
    properties: { id: PARK_ID, biome: "forest" },
    geometry: {
      type: "MultiPolygon",
      coordinates: [[[[west, south], [west + 0.01, south], [west + 0.01, south + 0.01], [west, south]]]],
    },
  };
}

function sceneFile(scene: string, hashChar: string): ContentFile {
  const path = `art/badges/scenes/${scene}.webp`;
  const sha256 = hashChar.repeat(64);
  const key = `releases/${sha256}/${path}`;
  return {
    path,
    key,
    url: `https://kip-assets.parkdex.app/${key}`,
    sha256,
    byte_size: 12,
    content_type: "image/webp",
  };
}

function syncState(revision: number, scene: string | null, sourceId = SOURCE): ContentSyncState {
  const currentPark = park(scene);
  return {
    revision,
    sourceId,
    parks: [currentPark],
    boundaries: { type: "FeatureCollection", features: [boundary()] },
    drive: { hubs: HUBS, parks: { [PARK_ID]: { drive: [[12, 8]], walkM: 250 } } },
    assets: scene ? [sceneFile(scene, scene === "old-scene" ? "a" : "b")] : [],
    map: null,
  };
}

function emptyState(revision: number, sourceId = SOURCE): ContentSyncState {
  return {
    revision,
    sourceId,
    parks: [],
    boundaries: { type: "FeatureCollection", features: [] },
    drive: { hubs: HUBS, parks: {} },
    assets: [],
    map: null,
  };
}

function deleteDatabase() {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test content database is blocked"));
  });
}

function arrayBuffer(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function hash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("WebContentStore sync persistence", () => {
  let store: WebContentStore;

  beforeEach(async () => {
    await deleteDatabase();
    store = new WebContentStore();
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    await deleteDatabase();
  });

  it("commits every change in a revision batch with its cursor across restart", async () => {
    const previous = syncState(20, "old-scene");
    await store.replaceSyncState(ENVIRONMENT, null, previous, SOURCE, null);
    const nextPark = park("new-scene", "Updated in one content revision.");
    const nextFile = sceneFile("new-scene", "b");
    const batch: ContentChangeBatch = {
      revision: 21,
      changes: [
        { entity: "park", op: "upsert", id: PARK_ID, value: nextPark },
        { entity: "asset", op: "delete", id: "art/badges/scenes/old-scene.webp" },
        { entity: "asset", op: "upsert", id: nextFile.path, value: nextFile },
      ],
    };

    await store.applySyncBatch(ENVIRONMENT, 20, batch, SOURCE);
    const committed = await store.getSyncState(ENVIRONMENT);

    expect(committed?.revision).toBe(21);
    expect(committed?.sourceId).toBe(SOURCE);
    expect(committed?.parks[0]?.scene).toBe("new-scene");
    expect(committed?.assets).toEqual([nextFile]);

    await store.close();
    store = new WebContentStore();
    await store.initialize();
    await expect(store.getSyncState(ENVIRONMENT)).resolves.toMatchObject({
      revision: 21,
      sourceId: SOURCE,
      parks: [{ id: PARK_ID, scene: "new-scene" }],
      assets: [nextFile],
    });
  });

  it("rolls back rows and cursor together when a later row write fails", async () => {
    const previous = syncState(5, "old-scene");
    await store.replaceSyncState(ENVIRONMENT, null, previous, SOURCE, null);
    const before = await store.getSyncState(ENVIRONMENT);
    const batch: ContentChangeBatch = {
      revision: 6,
      changes: [
        { entity: "park", op: "upsert", id: PARK_ID, value: park("new-scene") },
        { entity: "asset", op: "upsert", id: "art/badges/scenes/new-scene.webp", value: sceneFile("new-scene", "b") },
      ],
    };
    const putDescriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put");
    if (!putDescriptor?.value) throw new Error("IndexedDB put method is unavailable in this test environment");
    let rowWrites = 0;

    try {
      Object.defineProperty(IDBObjectStore.prototype, "put", {
        ...putDescriptor,
        value: function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
          if (this.name === "syncRows" && ++rowWrites === 2) throw new Error("injected row write failure");
          return Reflect.apply(putDescriptor.value, this, key === undefined ? [value] : [value, key]) as IDBRequest<IDBValidKey>;
        },
      });

      await expect(store.applySyncBatch(ENVIRONMENT, 5, batch, SOURCE)).rejects.toThrow();
    } finally {
      Object.defineProperty(IDBObjectStore.prototype, "put", putDescriptor);
    }

    await expect(store.getSyncState(ENVIRONMENT)).resolves.toEqual(before);
    await expect(store.getSyncCursor(ENVIRONMENT)).resolves.toEqual({ revision: 5, sourceId: SOURCE, readerVersion: 2 });
  });

  it("rejects stale cursor revisions and source IDs without changing saved rows", async () => {
    const previous = syncState(8, "old-scene");
    await store.replaceSyncState(ENVIRONMENT, null, previous, SOURCE, null);
    const before = await store.getSyncState(ENVIRONMENT);
    const staleBatch: ContentChangeBatch = {
      revision: 10,
      changes: [{ entity: "park", op: "upsert", id: PARK_ID, value: park("new-scene") }],
    };

    await expect(store.applySyncBatch(ENVIRONMENT, 7, staleBatch, SOURCE)).rejects.toThrow(/cursor changed/);
    await expect(store.applySyncBatch(ENVIRONMENT, 8, { ...staleBatch, revision: 9 }, "other-source")).rejects.toThrow(/cursor changed/);
    await expect(store.replaceSyncState(ENVIRONMENT, 8, syncState(9, "new-scene", "other-source"), "other-source", "stale-source", true)).rejects.toThrow(/cursor changed/);

    await expect(store.getSyncState(ENVIRONMENT)).resolves.toEqual(before);
  });

  it("prunes a former scene descriptor when the park scene is removed", async () => {
    const previous = syncState(3, "old-scene");
    await store.replaceSyncState(ENVIRONMENT, null, previous, SOURCE, null);
    const batch: ContentChangeBatch = {
      revision: 4,
      changes: [
        { entity: "park", op: "upsert", id: PARK_ID, value: park(null) },
        { entity: "asset", op: "delete", id: "art/badges/scenes/old-scene.webp" },
      ],
    };

    await store.applySyncBatch(ENVIRONMENT, 3, batch, SOURCE);
    const state = await store.getSyncState(ENVIRONMENT);

    expect(state?.parks[0]?.scene).toBeNull();
    expect(state?.assets).toEqual([]);
    expect(state?.revision).toBe(4);
  });

  it("advances the cursor for an inactive registration-only asset revision without storing the descriptor", async () => {
    const previous = syncState(11, null);
    await store.replaceSyncState(ENVIRONMENT, null, previous, SOURCE, null);
    const newFile = sceneFile("not-active-yet", "c");
    const registrationBatch: ContentChangeBatch = {
      revision: 12,
      changes: [{ entity: "asset", op: "upsert", id: newFile.path, value: newFile }],
    };
    const candidate = applyContentChangeBatch(previous, registrationBatch);
    expect(candidate.assets).toEqual([]);

    // Runtime filters the unreferenced upsert but still commits its revision.
    await store.applySyncBatch(ENVIRONMENT, 11, { revision: 12, changes: [] }, SOURCE);

    await expect(store.getSyncState(ENVIRONMENT)).resolves.toMatchObject({ revision: 12, sourceId: SOURCE, assets: [] });
  });

  it("restores an empty catalogue after the store is reopened", async () => {
    await store.replaceSyncState(ENVIRONMENT, null, emptyState(0), SOURCE, null);

    await store.close();
    store = new WebContentStore();
    await store.initialize();

    await expect(store.getSyncState(ENVIRONMENT)).resolves.toEqual({
      revision: 0,
      sourceId: SOURCE,
      parks: [],
      boundaries: { type: "FeatureCollection", features: [] },
      drive: { hubs: HUBS, parks: {} },
      assets: [],
      map: null,
    });
  });

  it("preserves archived earned art and bytes through a source reset to an empty catalogue", async () => {
    const previous = syncState(30, "earned-scene");
    await store.replaceSyncState(ENVIRONMENT, null, previous, SOURCE, null);
    const bytes = arrayBuffer("earned badge bytes");
    const digest = await hash(bytes);
    const releaseId = "d".repeat(64);
    const path = "art/badges/scenes/earned-scene.webp";
    const archivedFile: ContentFile = {
      path,
      key: `releases/${releaseId}/${path}`,
      url: `https://kip-assets.parkdex.app/releases/${releaseId}/${path}`,
      sha256: digest,
      byte_size: bytes.byteLength,
      content_type: "image/webp",
    };
    await store.putFile(digest, bytes);
    await store.retainArchivedScene({ releaseId, scene: "earned-scene", file: archivedFile });

    await store.replaceSyncState(ENVIRONMENT, 30, emptyState(0, "staging-api-b"), "staging-api-b", SOURCE, true);
    await expect(store.deleteFile(digest)).rejects.toThrow(/active or retained content/);

    await store.close();
    store = new WebContentStore();
    await store.initialize();

    await expect(store.getSyncState(ENVIRONMENT)).resolves.toMatchObject({ revision: 0, sourceId: "staging-api-b", parks: [], assets: [] });
    await expect(store.getArchivedScene(releaseId, "earned-scene")).resolves.toEqual({ releaseId, scene: "earned-scene", file: archivedFile });
    await expect(store.hasFile(digest, bytes.byteLength)).resolves.toBe(true);
  });
});
