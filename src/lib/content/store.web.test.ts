import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchivedScene, RetainedPark, StoredRelease } from "./contracts";
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

    const attempts = await Promise.allSettled([
      store.activateRelease("release-a", null),
      store.activateRelease("release-b", null),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(["release-a", "release-b"]).toContain(await store.getActiveId());
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
