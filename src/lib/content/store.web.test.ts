import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchivedScene, ContentSyncState, RetainedPark, StoredRelease } from "./contracts";
import { WebContentStore } from "./store.web";

const DATABASE = "parkdex-content-v1";
const EMPTY_MANIFEST = {
  version: "1",
  sourceCommit: "test",
  cdnOrigin: "https://kip-assets.parkdex.app",
  files: [],
  parkIds: [],
  boundaryIds: [],
  mapManifest: { size: 0, chunkBytes: 1, count: 0 },
};

function release(id: string): StoredRelease {
  return {
    id,
    channel: {
      schema: "parkdex.content-channel/v1",
      environment: "staging",
      generation: 1,
      releaseId: id,
      manifestUrl: "https://kip-assets.parkdex.app/manifest.json",
      manifestSha256: "0".repeat(64),
      minimumReaderVersion: 1,
    },
    manifest: EMPTY_MANIFEST,
    readiness: "candidate",
    healthy: false,
  };
}

function emptyState(revision: number, sourceId = "test-source"): ContentSyncState {
  return {
    revision,
    sourceId,
    parks: [],
    boundaries: { type: "FeatureCollection", features: [] },
    drive: { hubs: [{ name: "Victoria", lng: -123.3656, lat: 48.4284 }], parks: {} },
    assets: [],
    map: null,
  };
}

function park(id: string, name: string): RetainedPark["park"] {
  return {
    id,
    name,
    short: name,
    category: "regional",
    region: "Victoria",
    lat: 48.4,
    lng: -123.3,
    biome: "coast",
    shape: "circle",
    rarity: "common",
    seed: 7,
    blurb: "A retained test park.",
    scene: null,
  };
}

function arrayBuffer(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function hash(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deleteDatabase() {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test content database is blocked"));
  });
}

describe("WebContentStore", () => {
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

  it("uses a transactional compare-and-swap for the active release", async () => {
    await Promise.all([store.putRelease(release("release-a")), store.putRelease(release("release-b"))]);

    const attempts = await Promise.allSettled([store.activateRelease("release-a", null), store.activateRelease("release-b", null)]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(["release-a", "release-b"]).toContain(await store.getActiveId());
  });

  it("migrates the old cursor source field and repairs only an absent or malformed cursor", async () => {
    await store.close();
    await deleteDatabase();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 3);
      request.onupgradeneeded = () => request.result.createObjectStore("syncCursors", { keyPath: "environment" });
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("syncCursors", "readwrite");
        tx.objectStore("syncCursors").put({ environment: "staging", revision: 12, source: "legacy-source" });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    store = new WebContentStore();
    await store.initialize();
    await expect(store.getSyncCursor("staging")).resolves.toEqual({ revision: 12, sourceId: "legacy-source", readerVersion: 1 });

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("syncCursors", "readwrite");
      tx.objectStore("syncCursors").put({ environment: "staging", revision: "corrupt", sourceId: 9 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await expect(store.getSyncState("staging")).resolves.toBeNull();
    await expect(store.getSyncCursor("staging")).resolves.toBeNull();
    await store.replaceSyncState("staging", null, emptyState(13), "recovered-source", null, true);
    await expect(store.getSyncCursor("staging")).resolves.toEqual({ revision: 13, sourceId: "recovered-source", readerVersion: 3 });

    const concurrentDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = concurrentDb.transaction("syncCursors", "readwrite");
      tx.objectStore("syncCursors").put({ environment: "staging", revision: 14, sourceId: "newer-source" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    concurrentDb.close();
    await expect(store.replaceSyncState("staging", null, emptyState(15), "stale-reset", null, true)).rejects.toThrow(/cursor changed/);
    await expect(store.getSyncCursor("staging")).resolves.toEqual({ revision: 14, sourceId: "newer-source", readerVersion: 1 });
  });

  it("treats a cursor without its required hubs record as an invalid cache", async () => {
    await store.replaceSyncState("staging", null, emptyState(3), "source", null);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("syncRows", "readwrite");
      tx.objectStore("syncRows").delete("staging\u0000hubs\u0000default");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    await expect(store.getSyncState("staging")).resolves.toBeNull();
  });

  it("skips malformed optional descriptors while retaining their possible blob references", async () => {
    await store.putRelease(release("good-release"));
    const bytes = arrayBuffer("retained public art");
    const digest = await hash(bytes);
    const sceneFile = {
      path: "art/badges/scenes/retained.webp",
      key: "retained-scene",
      url: "https://kip-assets.parkdex.app/retained.webp",
      sha256: digest,
      byte_size: bytes.byteLength,
      content_type: "image/webp",
    };
    await store.putFile(digest, bytes);

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["releases", "retainedParks"], "readwrite");
      tx.objectStore("releases").put({ id: "broken-release" });
      tx.objectStore("retainedParks").put({ parkId: "broken-park", park: { id: "broken-park" }, sceneFile });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    await expect(store.getRelease("broken-release")).resolves.toBeUndefined();
    await expect(store.listReleases()).resolves.toEqual([release("good-release")]);
    await expect(store.getRetainedParks()).resolves.toEqual([]);
    await expect(store.deleteFile(digest)).rejects.toThrow(/active or retained content/);
    await expect(store.hasFile(digest, bytes.byteLength)).resolves.toBe(true);
  });

  it("rejects corrupt or incorrectly addressed content and can recover on a correct retry", async () => {
    const content = arrayBuffer("verified offline content");
    const digest = await hash(content);
    await expect(store.putFile("f".repeat(64), content)).rejects.toThrow(/SHA-256/);
    expect(await store.hasFile(digest, content.byteLength)).toBe(false);

    await store.putFile(digest, content);
    expect(await store.hasFile(digest, content.byteLength)).toBe(true);
    expect(await store.readFile(digest, 2, 5)).toEqual(arrayBuffer("rified").slice(0, 5));

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put({ hash: digest, size: 5, bytes: new Blob([arrayBuffer("wrong")]) });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    expect(await store.hasFile(digest, 5)).toBe(false);
    await expect(store.readFile(digest)).rejects.toThrow(/SHA-256 verification/);
    await store.putFile(digest, content);
    expect(await store.hasFile(digest, content.byteLength)).toBe(true);
  });

  it("keeps active-release and retained earned-scene blobs out of garbage collection", async () => {
    const bytes = arrayBuffer("do not collect");
    const digest = await hash(bytes);
    const sceneFile = {
      path: "art/badges/scenes/earned.webp",
      key: "scene-earned",
      url: "https://kip-assets.parkdex.app/earned.webp",
      sha256: digest,
      byte_size: bytes.byteLength,
      content_type: "image/webp",
    };
    await store.putFile(digest, bytes);
    const activeRelease = release("active");
    activeRelease.manifest.files = [sceneFile];
    await store.putRelease(activeRelease);
    await store.activateRelease("active", null);
    await expect(store.deleteFile(digest)).rejects.toThrow(/active or retained content/);

    await store.putRelease(release("empty"));
    await store.activateRelease("empty", "active");
    await store.retainParks([{ park: park("earned", "Earned Park"), sceneFile }]);
    await expect(store.deleteFile(digest)).rejects.toThrow(/active or retained content/);
    expect(await store.hasFile(digest, bytes.byteLength)).toBe(true);
  });

  it("persists retained parks across store recreation without dropping older earned records", async () => {
    const earnedScene = {
      path: "art/badges/scenes/earned.webp",
      key: "scene-earned",
      url: "https://kip-assets.parkdex.app/earned.webp",
      sha256: "a".repeat(64),
      byte_size: 10,
      content_type: "image/webp",
    };
    await store.retainParks([{ park: park("earned", "Earned Park"), sceneFile: earnedScene }]);
    await store.retainParks([{ park: park("new", "New Park") }]);

    await store.close();
    store = new WebContentStore();
    await store.initialize();
    await store.retainParks([{ park: park("earned", "Renamed Earned Park") }]);

    const retained = await store.getRetainedParks();
    expect(retained.map(({ park: item }) => item.id)).toEqual(["earned", "new"]);
    expect(retained[0].park.name).toBe("Renamed Earned Park");
    expect(retained[0].sceneFile).toEqual(earnedScene);
  });

  it("removes a referenced detailed map chunk only when asked to drop optional coverage", async () => {
    const chunkBytes = arrayBuffer("map chunk bytes");
    const glyphBytes = arrayBuffer("glyph bytes");
    const chunkHash = await hash(chunkBytes);
    const glyphHash = await hash(glyphBytes);
    const file = (path: string, sha256: string, byte_size: number, content_type: string) => ({
      path,
      key: `releases/map/${path}`,
      url: `https://kip-assets.parkdex.app/releases/map/${path}`,
      sha256,
      byte_size,
      content_type,
    });
    await store.putFile(chunkHash, chunkBytes);
    await store.putFile(glyphHash, glyphBytes);
    const active = release("map-release");
    active.manifest.files = [
      file("map/island/0123.bin", chunkHash, chunkBytes.byteLength, "application/octet-stream"),
      file("map/fonts/Noto Sans Regular/0-255.pbf", glyphHash, glyphBytes.byteLength, "application/x-protobuf"),
    ];
    await store.putRelease(active);
    await store.activateRelease("map-release", null);

    await expect(store.deleteFile(chunkHash)).rejects.toThrow(/active or retained content/);
    await expect(store.deleteFile(glyphHash, { optionalMapChunk: true })).rejects.toThrow(/active or retained content/);
    await store.deleteFile(chunkHash, { optionalMapChunk: true });
    expect(await store.hasFile(chunkHash, chunkBytes.byteLength)).toBe(false);
    expect(await store.hasFile(glyphHash, glyphBytes.byteLength)).toBe(true);

    // Maps from the combined BC and Nova Scotia release keep their chunks in map/detail/.
    await store.putFile(chunkHash, chunkBytes);
    active.manifest.files[0] = file("map/detail/0123.bin", chunkHash, chunkBytes.byteLength, "application/octet-stream");
    await store.putRelease(active);
    await expect(store.deleteFile(chunkHash)).rejects.toThrow(/active or retained content/);
    await store.deleteFile(chunkHash, { optionalMapChunk: true });
    expect(await store.hasFile(chunkHash, chunkBytes.byteLength)).toBe(false);
  });

  it("removes badge art the catalogue lists only when asked, but never retained art", async () => {
    const artBytes = arrayBuffer("far badge art");
    const keptBytes = arrayBuffer("earned badge art");
    const artHash = await hash(artBytes);
    const keptHash = await hash(keptBytes);
    const art = (scene: string, sha256: string, byte_size: number) => ({
      path: `art/badges/scenes/${scene}.webp`,
      key: `releases/${"a".repeat(64)}/art/badges/scenes/${scene}.webp`,
      url: `https://kip-assets.parkdex.app/releases/${"a".repeat(64)}/art/badges/scenes/${scene}.webp`,
      sha256,
      byte_size,
      content_type: "image/webp",
    });
    await store.putFile(artHash, artBytes);
    await store.putFile(keptHash, keptBytes);
    const farPark = { ...park("far-park", "Far"), scene: "far" };
    await store.replaceSyncState(
      "staging",
      null,
      {
        ...emptyState(3),
        parks: [farPark],
        boundaries: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { id: "far-park", biome: "coast" },
              geometry: {
                type: "MultiPolygon",
                coordinates: [
                  [
                    [
                      [0, 0],
                      [1, 0],
                      [1, 1],
                      [0, 0],
                    ],
                  ],
                ],
              },
            },
          ],
        },
        drive: { hubs: emptyState(3).drive.hubs, parks: { "far-park": { drive: [null], walkM: 0 } } },
        assets: [art("far", artHash, artBytes.byteLength)],
      },
      "test-source",
      null,
    );
    await store.retainParks([{ park: { ...park("earned", "Earned"), scene: "earned" }, sceneFile: art("earned", keptHash, keptBytes.byteLength) }]);

    await expect(store.deleteFile(artHash)).rejects.toThrow(/active or retained content/);
    await store.deleteFile(artHash, { optionalArt: true });
    expect(await store.hasFile(artHash, artBytes.byteLength)).toBe(false);
    await expect(store.deleteFile(keptHash, { optionalArt: true, optionalMapChunk: true })).rejects.toThrow(/active or retained content/);
  });

  it("keeps a lean catalogue's chunk list with its boundaries", async () => {
    const catalogue = {
      version: "a".repeat(64),
      revision: 2,
      chunks: [
        {
          path: "catalogue/boundaries/000.json",
          url: `https://kip-assets.parkdex.app/releases/${"a".repeat(64)}/catalogue/boundaries/000.json`,
          sha256: "b".repeat(64),
          byte_size: 10,
          parkIds: ["far-park"],
          bbox: null,
        },
      ],
      loaded: [],
      pinned: [],
    };
    await store.replaceSyncState(
      "staging",
      null,
      {
        ...emptyState(3),
        parks: [park("far-park", "Far")],
        drive: { hubs: emptyState(3).drive.hubs, parks: { "far-park": { drive: [null], walkM: 0 } } },
        catalogue,
      },
      "test-source",
      null,
    );
    await store.close();
    store = new WebContentStore();
    const stored = await store.getSyncState("staging");
    expect(stored?.catalogue).toEqual(catalogue);
    expect(stored?.boundaries.features).toEqual([]);
  });

  it("pins archived scene blobs by release and scene across recreation", async () => {
    const firstBytes = arrayBuffer("vintage one art");
    const secondBytes = arrayBuffer("vintage two art");
    const firstHash = await hash(firstBytes);
    const secondHash = await hash(secondBytes);
    const makeArchived = (releaseId: string, sha256: string, byte_size: number): ArchivedScene => ({
      releaseId,
      scene: "coast-a",
      file: {
        path: "art/badges/scenes/coast-a.webp",
        key: `releases/${releaseId}/art/badges/scenes/coast-a.webp`,
        url: `https://kip-assets.parkdex.app/releases/${releaseId}/art/badges/scenes/coast-a.webp`,
        sha256,
        byte_size,
        content_type: "image/webp",
      },
    });
    const first = makeArchived("a".repeat(64), firstHash, firstBytes.byteLength);
    const second = makeArchived("b".repeat(64), secondHash, secondBytes.byteLength);

    await store.putFile(firstHash, firstBytes);
    await store.retainArchivedScene(first);
    await store.putFile(secondHash, secondBytes);
    await store.retainArchivedScene(second);
    await expect(store.deleteFile(firstHash)).rejects.toThrow(/active or retained content/);
    await expect(store.deleteFile(secondHash)).rejects.toThrow(/active or retained content/);

    await store.close();
    store = new WebContentStore();
    await store.initialize();
    expect(await store.getArchivedScene(first.releaseId, first.scene)).toEqual(first);
    expect(await store.getArchivedScene(second.releaseId, second.scene)).toEqual(second);
    expect(await store.listArchivedScenes()).toEqual([first, second]);
    expect(await store.readFile(firstHash)).toEqual(firstBytes);
    expect(await store.readFile(secondHash)).toEqual(secondBytes);
  });
});
