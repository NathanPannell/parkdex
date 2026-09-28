import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Connectivity,
  ContentChannel,
  ContentFile,
  ContentManifest,
  ContentRuntime,
  ContentRuntimeOptions,
  ContentSnapshot,
  ContentStore,
  RetainedPark,
  StoredRelease,
} from "./contracts";
import { sha256Hex } from "./manifest";
import { createContentRuntime } from "./runtime";
import { resetAllowedMapChunks } from "../offlineTiles";

const mapMock = vi.hoisted(() => ({
  calls: [] as { releaseId: string; detail: string }[],
  pauseNext: false,
  onPause: null as null | (() => void),
  releasePause: null as null | (() => void),
}));

vi.mock("./map-downloads", () => ({
  prefetchMapArea: async (
    runtime: ContentRuntime,
    releaseId: string,
    _point: [number, number],
    detail: string,
    signal?: AbortSignal,
    snapshotOverride?: ContentSnapshot,
  ) => {
    mapMock.calls.push({ releaseId, detail });
    if (!snapshotOverride || snapshotOverride.releaseId !== releaseId) throw new Error("candidate prefetch requires a private matching snapshot");
    if (runtime.getStatus().snapshot?.releaseId === releaseId) throw new Error("candidate snapshot was published before map verification");
    if (mapMock.pauseNext) {
      mapMock.pauseNext = false;
      await new Promise<void>((resolve) => {
        mapMock.releasePause = resolve;
        mapMock.onPause?.();
      });
    }
    await runtime.ensureFile(releaseId, "map/island/000.bin", "nearby", signal);
    return { releaseId, detail, chunkIds: [0], allowedChunkIds: [0] };
  },
}));

const DISCOVERY_URL = "https://parkdex.example.test/api/content/current";
const PARK_FIELDS = {
  category: "provincial",
  region: "South Island",
  lat: 48.4,
  lng: -123.4,
  biome: "coast",
  shape: "circle",
  rarity: "common",
  seed: 17,
  blurb: "A coastal park.",
};

function toBytes(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function makeRelease(id: string, generation: number, parkId: string, scene: string) {
  const park = { id: parkId, name: `${parkId} park`, short: parkId, ...PARK_FIELDS, scene };
  const boundaries = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { id: parkId, biome: park.biome },
      geometry: { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    }],
  };
  const drive = { hubs: [{ name: "Victoria", lng: -123.3, lat: 48.4 }], parks: { [parkId]: { drive: [null], walkM: 0 } } };
  const mapIndex = { size: 8, chunkBytes: 4, count: 2 };
  const entries: Array<[string, ArrayBuffer]> = [
    ["data/parks.json", toBytes([park])],
    ["data/drive.json", toBytes(drive)],
    ["boundaries.geojson", toBytes(boundaries)],
    [`art/badges/scenes/${scene}.webp`, toBytes(`scene:${scene}`)],
    ["map/island/manifest.json", toBytes(mapIndex)],
    ["map/island/000.bin", new Uint8Array([1, 2, 3, 4]).buffer],
    ["map/island/001.bin", new Uint8Array([5, 6, 7, 8]).buffer],
    ["map/fonts/Noto Sans Regular/0-255.pbf", new Uint8Array([9, 10, 11]).buffer],
  ];
  const files: ContentFile[] = [];
  const content = new Map<string, ArrayBuffer>();
  for (const [path, bytes] of entries) {
    const sha256 = await sha256Hex(bytes);
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const content_type = path.endsWith(".geojson") ? "application/geo+json"
      : path.endsWith(".webp") ? "image/webp"
        : path.endsWith(".pbf") ? "application/x-protobuf"
          : path.endsWith(".bin") ? "application/octet-stream" : "application/json";
    files.push({
      path,
      key: `releases/${id}/${path}`,
      url: `https://kip-assets.parkdex.app/releases/${id}/${encodedPath}`,
      sha256,
      byte_size: bytes.byteLength,
      content_type,
    });
    content.set(files[files.length - 1]!.url, bytes.slice(0));
  }
  const rawManifest = {
    version: id,
    sourceCommit: "c".repeat(40),
    cdnOrigin: "https://kip-assets.parkdex.app",
    files,
    parkIds: [parkId],
    boundaryIds: [parkId],
    mapManifest: { size: 8, chunkBytes: 4, count: 2 },
  };
  const manifestBytes = toBytes(rawManifest);
  const channel: ContentChannel = {
    schema: "parkdex.content-channel/v1",
    environment: "staging",
    generation,
    releaseId: id,
    manifestUrl: `https://kip-assets.parkdex.app/releases/${id}/manifest.json`,
    manifestSha256: await sha256Hex(manifestBytes),
    minimumReaderVersion: 1,
  };
  content.set(channel.manifestUrl, manifestBytes);
  return { channel, rawManifest: rawManifest as ContentManifest, content, park };
}

class MemoryContentStore implements ContentStore {
  activeId: string | null = null;
  releases = new Map<string, StoredRelease>();
  files = new Map<string, ArrayBuffer>();
  retained = new Map<string, RetainedPark>();
  beforeActivation?: (id: string, expected: string | null) => void;
  initialized = false;
  closed = false;

  async initialize() { this.initialized = true; }
  async getActiveId() { return this.activeId; }
  async getRelease(id: string) { const value = this.releases.get(id); return value ? structuredClone(value) : undefined; }
  async listReleases() { return [...this.releases.values()].map((value) => structuredClone(value)); }
  async putRelease(release: StoredRelease) { this.releases.set(release.id, structuredClone(release)); }
  async activateRelease(id: string, expectedActiveId: string | null) {
    this.beforeActivation?.(id, expectedActiveId);
    if (this.activeId !== expectedActiveId) throw new Error("Content release activation compare-and-swap failed");
    if (!this.releases.has(id)) throw new Error("Content release is missing");
    this.activeId = id;
  }
  async deleteRelease(id: string) {
    if (this.activeId === id) throw new Error("Cannot delete active content release");
    this.releases.delete(id);
  }
  async hasFile(hash: string, expectedSize: number) {
    const bytes = this.files.get(hash);
    return !!bytes && bytes.byteLength === expectedSize && await sha256Hex(bytes) === hash;
  }
  async putFile(hash: string, bytes: ArrayBuffer) {
    if (await sha256Hex(bytes) !== hash) throw new Error("Content storage rejected a hash mismatch");
    this.files.set(hash, bytes.slice(0));
  }
  async readFile(hash: string, offset = 0, length?: number) {
    const bytes = this.files.get(hash);
    if (!bytes) throw new Error("File is missing");
    return bytes.slice(offset, length === undefined ? undefined : offset + length);
  }
  async fileUrl(hash: string) { return `content-store://${hash}`; }
  async listFiles() { return [...this.files.entries()].map(([hash, bytes]) => ({ hash, size: bytes.byteLength })); }
  async deleteFile(hash: string) {
    for (const release of this.releases.values()) {
      if (release.id === this.activeId && release.manifest.files.some((file) => file.sha256 === hash)) throw new Error("File is referenced by active release");
    }
    for (const entry of this.retained.values()) if (entry.sceneFile?.sha256 === hash) throw new Error("File is referenced by retained park");
    this.files.delete(hash);
  }
  async getRetainedParks() { return [...this.retained.values()].map((value) => structuredClone(value)); }
  async retainParks(parks: RetainedPark[]) { for (const entry of parks) this.retained.set(entry.park.id, structuredClone(entry)); }
  async close() { this.closed = true; }
}

function contentServer(initial: Awaited<ReturnType<typeof makeRelease>>) {
  let current = initial.channel;
  const corruptUrls = new Set<string>();
  const redirectUrls = new Map<string, string>();
  const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === DISCOVERY_URL) return new Response(JSON.stringify(current), { status: 200 });
    const release = [initial, ...serverReleases].find((candidate) => candidate.channel.manifestUrl === url || candidate.content.has(url));
    if (!release) return new Response("missing", { status: 404 });
    const bytes = release.content.get(url);
    if (!bytes) return new Response("missing", { status: 404 });
    const response = corruptUrls.has(url)
      ? new Response(new Uint8Array([255, 1, 2]).buffer, { status: 200 })
      : new Response(bytes.slice(0), { status: 200 });
    const destination = redirectUrls.get(url);
    if (destination) Object.defineProperty(response, "url", { value: destination });
    return response;
  });
  const serverReleases = [initial];
  return {
    fetcher,
    add(release: Awaited<ReturnType<typeof makeRelease>>) { serverReleases.push(release); },
    setCurrent(channel: ContentChannel) { current = channel; },
    corrupt(url: string) { corruptUrls.add(url); },
    redirect(url: string, destination: string) { redirectUrls.set(url, destination); },
  };
}

function createRuntime(store: MemoryContentStore, fetcher: typeof fetch, connectivity: Connectivity, claimedParkIds: string[] = []) {
  const runtime = createContentRuntime({
    store,
    fetch: fetcher,
    discoveryUrl: DISCOVERY_URL,
    environment: "staging",
    claimedParkIds: () => claimedParkIds,
    connectivity,
  } satisfies ContentRuntimeOptions);
  return runtime;
}

const runtimes: ContentRuntime[] = [];
function track(runtime: ContentRuntime) { runtimes.push(runtime); return runtime; }

beforeEach(() => {
  mapMock.calls.length = 0;
  mapMock.pauseNext = false;
  mapMock.onPause = null;
  mapMock.releasePause = null;
  resetAllowedMapChunks("a".repeat(64));
  resetAllowedMapChunks("b".repeat(64));
  resetAllowedMapChunks("c".repeat(64));
});

afterEach(async () => {
  mapMock.releasePause?.();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  vi.restoreAllMocks();
});

describe("content runtime", () => {
  it("keeps the first-install snapshot private until core and the Victoria starter are verified", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const server = contentServer(a);
    const store = new MemoryContentStore();
    const runtime = track(createRuntime(store, server.fetcher, { connected: true, wifi: true }));
    const paused = new Promise<void>((resolve) => { mapMock.onPause = resolve; });
    mapMock.pauseNext = true;

    const start = runtime.start();
    await paused;
    expect(runtime.getStatus().snapshot).toBeNull();
    expect(await store.getActiveId()).toBeNull();
    expect(mapMock.calls).toContainEqual({ releaseId: a.channel.releaseId, detail: "starter" });

    mapMock.releasePause?.();
    await start;
    expect(runtime.getStatus().snapshot?.releaseId).toBe(a.channel.releaseId);
    expect(await store.getActiveId()).toBe(a.channel.releaseId);
    expect(runtime.getStatus().phase).toBe("ready");
    expect(mapMock.calls.map((call) => call.detail)).toEqual(["starter"]);
  });

  it("hydrates a verified active snapshot offline on the next startup without discovery", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const server = contentServer(a);
    const store = new MemoryContentStore();
    const first = track(createRuntime(store, server.fetcher, { connected: true, wifi: true }));
    await first.start();
    expect(first.getStatus().snapshot?.releaseId).toBe(a.channel.releaseId);
    const discoveryRequests = () => (server.fetcher as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => String(call[0]) === DISCOVERY_URL).length;
    const requestsAtLaunch = discoveryRequests();
    first.setForeground(false);
    first.setForeground(true);
    first.setConnectivity({ connected: false, wifi: false });
    first.setConnectivity({ connected: true, wifi: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discoveryRequests()).toBe(requestsAtLaunch);

    const second = track(createRuntime(store, server.fetcher, { connected: false, wifi: false }));
    await second.start();
    expect(second.getStatus().phase).toBe("offline");
    expect(second.getStatus().snapshot?.releaseId).toBe(a.channel.releaseId);
    expect(second.getStatus().snapshot?.assetUrls.has("data/parks.json")).toBe(true);
    expect(discoveryRequests()).toBe(requestsAtLaunch);
  });

  it("rebuilds the active payload from hash-verified source files instead of trusting a mutable stored copy", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const server = contentServer(a);
    const store = new MemoryContentStore();
    const first = track(createRuntime(store, server.fetcher, { connected: true, wifi: true }));
    await first.start();

    const saved = store.releases.get(a.channel.releaseId)!;
    store.releases.set(a.channel.releaseId, {
      ...saved,
      payload: {
        ...saved.payload!,
        parks: [{ ...saved.payload!.parks[0]!, name: "Tampered cached name" }],
      },
    });
    const second = track(createRuntime(store, server.fetcher, { connected: false, wifi: false }));
    await second.start();

    expect(second.getStatus().snapshot?.parks[0]?.name).toBe("provincial-a-park park");
    expect((await store.getRelease(a.channel.releaseId))?.payload?.parks[0]?.name).toBe("provincial-a-park park");
  });

  it("leaves a visible setup error on first install when offline and does not invent bundled content", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const server = contentServer(a);
    const store = new MemoryContentStore();
    const runtime = track(createRuntime(store, server.fetcher, { connected: false, wifi: false }));

    await runtime.start();
    expect(runtime.getStatus().phase).toBe("error");
    expect(runtime.getStatus().snapshot).toBeNull();
    expect(runtime.getStatus().error).toMatch(/Connect to the internet/);
    expect(await store.getActiveId()).toBeNull();
    expect(server.fetcher).not.toHaveBeenCalled();
  });

  it("rejects a CDN manifest response redirected away from its immutable HTTPS URL", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const server = contentServer(a);
    server.redirect(a.channel.manifestUrl, "https://evil.example/manifest.json");
    const store = new MemoryContentStore();
    const runtime = track(createRuntime(store, server.fetcher, { connected: true, wifi: true }));

    await runtime.start();

    expect(runtime.getStatus().phase).toBe("error");
    expect(runtime.getStatus().snapshot).toBeNull();
    expect(runtime.getStatus().error).toMatch(/redirected away/);
    expect(await store.getActiveId()).toBeNull();
  });

  it("rejects a checksum failure and keeps the previously active release visible", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const b = await makeRelease("b".repeat(64), 2, "provincial-b-park", "scene-b");
    const server = contentServer(a);
    server.add(b);
    const store = new MemoryContentStore();
    const runtime = track(createRuntime(store, server.fetcher, { connected: true, wifi: true }));
    await runtime.start();

    server.corrupt(b.rawManifest.files.find((file) => file.path === "data/parks.json")!.url);
    server.setCurrent(b.channel);
    await runtime.retry();

    expect(await store.getActiveId()).toBe(a.channel.releaseId);
    expect(runtime.getStatus().snapshot?.releaseId).toBe(a.channel.releaseId);
    expect(runtime.getStatus().phase).toBe("error");
    expect(runtime.getStatus().error).toMatch(/SHA-256|byte length/);
  });

  it("waits for Wi-Fi to stage all update chunks, retains claimed retired scenes, and delays old-release GC", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const b = await makeRelease("b".repeat(64), 2, "provincial-b-park", "scene-b");
    const server = contentServer(a);
    server.add(b);
    const store = new MemoryContentStore();
    const runtime = track(createRuntime(store, server.fetcher, { connected: true, wifi: true }, ["provincial-a-park"]));
    await runtime.start();
    server.setCurrent(b.channel);
    runtime.setConnectivity({ connected: true, wifi: false });

    const update = runtime.retry();
    await vi.waitFor(() => expect(runtime.getStatus().waitingForWifi).toBe(true));
    expect(await store.getActiveId()).toBe(a.channel.releaseId);
    expect(runtime.getStatus().snapshot?.releaseId).toBe(a.channel.releaseId);

    runtime.setConnectivity({ connected: true, wifi: true });
    await update;
    const snapshot = runtime.getStatus().snapshot!;
    expect(await store.getActiveId()).toBe(b.channel.releaseId);
    expect(snapshot.releaseId).toBe(b.channel.releaseId);
    expect(snapshot.parks.map((park) => park.id)).toEqual(["provincial-b-park"]);
    expect(snapshot.retiredParks.map((park) => park.id)).toEqual(["provincial-a-park"]);
    expect(snapshot.parkById.has("provincial-a-park")).toBe(true);
    expect(snapshot.retainedSceneUrls.has("provincial-a-park")).toBe(true);
    expect(await store.getRelease(a.channel.releaseId)).toBeDefined();

    const oldScene = (await store.getRetainedParks())[0]!.sceneFile!;
    const nextStartup = track(createRuntime(store, server.fetcher, { connected: true, wifi: true }, ["provincial-a-park"]));
    await nextStartup.start();
    expect(await store.getRelease(a.channel.releaseId)).toBeUndefined();
    expect(await store.hasFile(oldScene.sha256, oldScene.byte_size)).toBe(true);
    expect(nextStartup.getStatus().snapshot?.parks.map((park) => park.id)).toEqual(["provincial-b-park"]);
    expect(nextStartup.getStatus().snapshot?.retiredParks.map((park) => park.id)).toEqual(["provincial-a-park"]);
  });

  it("keeps a fully staged busy-deferred release and its files through offline startup GC", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const b = await makeRelease("b".repeat(64), 2, "provincial-b-park", "scene-b");
    const server = contentServer(a);
    server.add(b);
    const store = new MemoryContentStore();
    const first = track(createRuntime(store, server.fetcher, { connected: true, wifi: true }));
    await first.start();
    first.setBusy(true);
    server.setCurrent(b.channel);
    await first.retry();

    expect(await store.getActiveId()).toBe(a.channel.releaseId);
    expect((await store.getRelease(b.channel.releaseId))?.readiness).toBe("complete");
    const stagedHashes = (await store.getRelease(b.channel.releaseId))!.manifest.files.map((file) => file.sha256);

    const offline = track(createRuntime(store, server.fetcher, { connected: false, wifi: false }));
    await offline.start();
    expect(offline.getStatus().snapshot?.releaseId).toBe(a.channel.releaseId);
    expect(await store.getRelease(b.channel.releaseId)).toBeDefined();
    for (const hash of stagedHashes) expect(await store.listFiles()).toContainEqual(expect.objectContaining({ hash }));
  });

  it("does not publish a candidate after an activation compare-and-swap conflict", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const b = await makeRelease("b".repeat(64), 2, "provincial-b-park", "scene-b");
    const c = await makeRelease("c".repeat(64), 3, "provincial-c-park", "scene-c");
    const server = contentServer(a);
    server.add(b);
    const store = new MemoryContentStore();
    const runtime = track(createRuntime(store, server.fetcher, { connected: true, wifi: true }));
    await runtime.start();
    await store.putRelease({ id: c.channel.releaseId, channel: c.channel, manifest: c.rawManifest, readiness: "complete", healthy: true });

    store.beforeActivation = (id) => {
      if (id !== b.channel.releaseId) return;
      store.beforeActivation = undefined;
      store.activeId = "c".repeat(64);
    };
    server.setCurrent(b.channel);
    await runtime.retry();

    expect(await store.getActiveId()).toBe("c".repeat(64));
    expect(runtime.getStatus().snapshot?.releaseId).toBe(a.channel.releaseId);
    expect(runtime.getStatus().phase).toBe("error");
    expect(runtime.getStatus().error).toMatch(/compare-and-swap/);
  });

  it("does not reopen a Wi-Fi-only chunk queue on a background network event", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const server = contentServer(a);
    const store = new MemoryContentStore();
    const runtime = track(createRuntime(store, server.fetcher, { connected: true, wifi: false }));
    await runtime.start();
    await vi.waitFor(() => expect(runtime.getStatus().waitingForWifi).toBe(true));

    runtime.setForeground(false);
    runtime.setConnectivity({ connected: true, wifi: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondChunkUrl = a.rawManifest.files.find((file) => file.path === "map/island/001.bin")!.url;
    expect((server.fetcher as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]))).not.toContain(secondChunkUrl);

    runtime.setForeground(true);
    await vi.waitFor(() => expect((server.fetcher as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]))).toContain(secondChunkUrl));
    const secondChunk = a.rawManifest.files.find((file) => file.path === "map/island/001.bin")!;
    await vi.waitFor(async () => expect(await store.hasFile(secondChunk.sha256, 4)).toBe(true));
  });
});
