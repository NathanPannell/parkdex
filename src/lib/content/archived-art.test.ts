import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_CDN_ORIGIN } from "./contracts";
import { restoreArchivedScene } from "./archived-art";
import { sha256Hex } from "./manifest";
import { WebContentStore } from "./store.web";

const DATABASE = "parkdex-content-v1";

type Fixture = {
  releaseId: string;
  manifest: Record<string, unknown>;
  sceneBytes: ArrayBuffer;
  scenePath: string;
};

function bytes(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function contentType(path: string) {
  if (path.endsWith(".geojson")) return "application/geo+json";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".pbf")) return "application/x-protobuf";
  if (path.endsWith(".bin")) return "application/octet-stream";
  return "application/json";
}

async function fixture(scene: string, sceneBytes: ArrayBuffer): Promise<Fixture> {
  const scenePath = `art/badges/scenes/${scene}.webp`;
  const contents = new Map<string, ArrayBuffer>([
    ["data/parks.json", bytes("parks")],
    ["data/drive.json", bytes("drive")],
    ["boundaries.geojson", bytes("boundaries")],
    [scenePath, sceneBytes],
    ["map/island/manifest.json", bytes("map")],
    ["map/island/000.bin", bytes("x")],
    ["map/fonts/Test Font/0-255.pbf", bytes("font")],
  ]);
  const inventoryFiles = await Promise.all(
    [...contents].map(async ([path, content]) => ({
      path,
      byte_size: content.byteLength,
      sha256: await sha256Hex(content),
    })),
  );
  const inventory = inventoryFiles
    .map(({ path, byte_size, sha256 }) => ({ byte_size, path, sha256 }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const releaseId = await sha256Hex(bytes(JSON.stringify(inventory)));
  const files = inventoryFiles.map(({ path, byte_size, sha256 }) => ({
    path,
    key: `releases/${releaseId}/${path}`,
    url: `${CONTENT_CDN_ORIGIN}/releases/${releaseId}/${path.split("/").map(encodeURIComponent).join("/")}`,
    sha256,
    byte_size,
    content_type: contentType(path),
  }));
  return {
    releaseId,
    scenePath,
    sceneBytes,
    manifest: {
      version: releaseId,
      sourceCommit: "b".repeat(40),
      cdnOrigin: CONTENT_CDN_ORIGIN,
      files,
      parkIds: ["provincial-one-park"],
      boundaryIds: ["provincial-one-park"],
      mapManifest: { size: 1, chunkBytes: 1, count: 1 },
    },
  };
}

function imageBytes(marker: string): ArrayBuffer {
  const markerBytes = new TextEncoder().encode(marker);
  const image = new Uint8Array(12 + markerBytes.length);
  image.set([0x52, 0x49, 0x46, 0x46], 0);
  image[4] = markerBytes.length + 4;
  image.set([0x57, 0x45, 0x42, 0x50], 8);
  image.set(markerBytes, 12);
  return image.buffer;
}

function responseFor(bytesOrText: ArrayBuffer | string, type: string) {
  return new Response(bytesOrText, { status: 200, headers: { "content-type": type } });
}

function fetchArchive(archive: Fixture, calls: { url: string; init?: RequestInit }[] = []) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${CONTENT_CDN_ORIGIN}/releases/${archive.releaseId}/manifest.json`) {
      return responseFor(JSON.stringify(archive.manifest), "application/json; charset=utf-8");
    }
    if (url === `${CONTENT_CDN_ORIGIN}/releases/${archive.releaseId}/${archive.scenePath}`) {
      return responseFor(archive.sceneBytes, "image/webp");
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as unknown as typeof fetch;
}

function deleteDatabase() {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test content database is blocked"));
  });
}

describe("restoreArchivedScene", () => {
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

  it("verifies the publisher inventory, downloads the exact scene, and persists each release vintage", async () => {
    const first = await fixture("coast-a", imageBytes("first"));
    const second = await fixture("coast-a", imageBytes("second"));
    expect(first.releaseId).not.toBe(second.releaseId);
    const firstCalls: { url: string; init?: RequestInit }[] = [];
    const secondCalls: { url: string; init?: RequestInit }[] = [];
    const persistenceOrder: string[] = [];
    const retainArchivedScene = store.retainArchivedScene.bind(store);
    const putFile = store.putFile.bind(store);
    vi.spyOn(store, "retainArchivedScene").mockImplementation(async (entry) => {
      persistenceOrder.push("descriptor");
      await retainArchivedScene(entry);
    });
    vi.spyOn(store, "putFile").mockImplementation(async (hash, content) => {
      persistenceOrder.push("bytes");
      await putFile(hash, content);
    });

    const firstFile = await restoreArchivedScene(first.releaseId, "coast-a", store, fetchArchive(first, firstCalls));
    const secondFile = await restoreArchivedScene(second.releaseId, "coast-a", store, fetchArchive(second, secondCalls));

    expect(firstCalls.map(({ url }) => url)).toEqual([
      `${CONTENT_CDN_ORIGIN}/releases/${first.releaseId}/manifest.json`,
      `${CONTENT_CDN_ORIGIN}/releases/${first.releaseId}/${first.scenePath}`,
    ]);
    expect(secondCalls.map(({ url }) => url)).toEqual([
      `${CONTENT_CDN_ORIGIN}/releases/${second.releaseId}/manifest.json`,
      `${CONTENT_CDN_ORIGIN}/releases/${second.releaseId}/${second.scenePath}`,
    ]);
    for (const call of [...firstCalls, ...secondCalls]) {
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.credentials).toBe("omit");
      expect(call.init?.cache).toBe("no-store");
    }
    expect(await store.readFile(firstFile.sha256)).toEqual(first.sceneBytes);
    expect(await store.readFile(secondFile.sha256)).toEqual(second.sceneBytes);
    expect(persistenceOrder).toEqual(["descriptor", "bytes", "descriptor", "bytes"]);
    expect(await store.listArchivedScenes()).toHaveLength(2);
    await expect(store.deleteFile(firstFile.sha256)).rejects.toThrow(/active or retained content/);
    await expect(store.deleteFile(secondFile.sha256)).rejects.toThrow(/active or retained content/);

    await store.close();
    store = new WebContentStore();
    await store.initialize();
    const cachedCalls = vi.fn();
    const cached = await restoreArchivedScene(first.releaseId, "coast-a", store, cachedCalls as unknown as typeof fetch);
    expect(cached).toEqual(firstFile);
    expect(cachedCalls).not.toHaveBeenCalled();
  });

  it("rejects a schema-valid manifest whose inventory digest does not match the requested release", async () => {
    const archive = await fixture("coast-a", imageBytes("trusted"));
    const wrongReleaseId = "f".repeat(64);
    const wrongManifest = {
      ...archive.manifest,
      version: wrongReleaseId,
      files: (archive.manifest.files as Record<string, unknown>[]).map((file) => ({
        ...file,
        key: `releases/${wrongReleaseId}/${String(file.path)}`,
        url: `${CONTENT_CDN_ORIGIN}/releases/${wrongReleaseId}/${String(file.path).split("/").map(encodeURIComponent).join("/")}`,
      })),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== `${CONTENT_CDN_ORIGIN}/releases/${wrongReleaseId}/manifest.json`) throw new Error("unexpected asset request");
      return responseFor(JSON.stringify(wrongManifest), "application/json");
    }) as unknown as typeof fetch;

    await expect(restoreArchivedScene(wrongReleaseId, "coast-a", store, fetcher)).rejects.toThrow(/inventory does not match/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await store.listArchivedScenes()).toEqual([]);
  });

  it("rejects art that does not match the manifest byte length and SHA-256", async () => {
    const archive = await fixture("coast-a", imageBytes("trusted"));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${CONTENT_CDN_ORIGIN}/releases/${archive.releaseId}/manifest.json`) {
        return responseFor(JSON.stringify(archive.manifest), "application/json");
      }
      return responseFor(imageBytes("tampered"), "image/webp");
    }) as unknown as typeof fetch;

    await expect(restoreArchivedScene(archive.releaseId, "coast-a", store, fetcher)).rejects.toThrow(/byte length|SHA-256/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await store.listArchivedScenes()).toEqual([]);
  });

  it("rejects redirects, oversized bodies, and malformed manifests before saving art", async () => {
    const archive = await fixture("coast-a", imageBytes("trusted"));
    const redirectingFetch = vi.fn(async () => {
      const response = new Response("", { status: 200, headers: { "content-type": "application/json" } });
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: "https://evil.example/manifest.json" },
      });
      return response;
    }) as unknown as typeof fetch;
    await expect(restoreArchivedScene(archive.releaseId, "coast-a", store, redirectingFetch)).rejects.toThrow(/redirected/);

    const oversizedFetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) },
        }),
    ) as unknown as typeof fetch;
    await expect(restoreArchivedScene(archive.releaseId, "coast-a", store, oversizedFetch)).rejects.toThrow(/exceeds the permitted size/);

    const oversizedStreamFetch = vi.fn(
      async () =>
        new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    await expect(restoreArchivedScene(archive.releaseId, "coast-a", store, oversizedStreamFetch)).rejects.toThrow(/exceeds the permitted size/);

    const malformedFetch = vi.fn(async () =>
      responseFor(JSON.stringify({ ...archive.manifest, cdnOrigin: "https://evil.example" }), "application/json"),
    ) as unknown as typeof fetch;
    await expect(restoreArchivedScene(archive.releaseId, "coast-a", store, malformedFetch)).rejects.toThrow(/CDN origin/);
    expect(await store.listArchivedScenes()).toEqual([]);
  });

  it("repairs a pinned descriptor whose bytes were lost before an interrupted restore", async () => {
    const archive = await fixture("coast-a", imageBytes("recovered"));
    const fetcher = fetchArchive(archive);
    const file = (archive.manifest.files as { path: string; key: string; url: string; sha256: string; byte_size: number; content_type: string }[]).find(
      (entry) => entry.path === archive.scenePath,
    )!;
    await store.retainArchivedScene({ releaseId: archive.releaseId, scene: "coast-a", file });
    expect(await store.getArchivedScene(archive.releaseId, "coast-a")).toBeDefined();

    await expect(store.hasFile(file.sha256, file.byte_size)).resolves.toBe(false);
    await expect(restoreArchivedScene(archive.releaseId, "coast-a", store, fetcher)).resolves.toEqual(file);
    expect(await store.readFile(file.sha256)).toEqual(archive.sceneBytes);
  });
});
