import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Connectivity,
  ArchivedScene,
  ContentChangeBatch,
  ContentChannel,
  ContentEnvironment,
  ContentFile,
  ContentMapInventory,
  ContentMapPointer,
  ContentManifest,
  ContentRuntime,
  ContentRuntimeOptions,
  ContentSnapshot,
  ContentStore,
  ContentSyncCursor,
  ContentSyncState,
  RetainedPark,
  StoredRelease,
} from "./contracts";
import { applyContentChangeBatch, parseContentSnapshot, sha256Hex } from "./manifest";
import { ArchivedSceneRestoreDeferredError, ContentUnavailableOfflineError, createContentRuntime } from "./runtime";
import { CONTENT_CDN_ORIGIN } from "./contracts";
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
} as const;

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

async function makeArchivedRelease(parkId: string, scene: string) {
  const draft = await makeRelease("0".repeat(64), 1, parkId, scene);
  const rawManifest = structuredClone(draft.rawManifest);
  const inventory = rawManifest.files
    .map(({ path, byte_size, sha256 }) => ({ byte_size, path, sha256 }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const releaseId = await sha256Hex(toBytes(inventory));
  const files = rawManifest.files.map((file) => {
    const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
    return {
      ...file,
      key: `releases/${releaseId}/${file.path}`,
      url: `${CONTENT_CDN_ORIGIN}/releases/${releaseId}/${encodedPath}`,
    };
  });
  rawManifest.version = releaseId;
  rawManifest.files = files;
  const content = new Map<string, ArrayBuffer>();
  for (let index = 0; index < files.length; index += 1) {
    const source = draft.rawManifest.files[index]!;
    const bytes = draft.content.get(source.url);
    if (!bytes) throw new Error(`Archive fixture is missing ${source.path}`);
    content.set(files[index]!.url, bytes.slice(0));
  }
  const manifestBytes = toBytes(rawManifest);
  const channel: ContentChannel = {
    ...draft.channel,
    releaseId,
    manifestUrl: `${CONTENT_CDN_ORIGIN}/releases/${releaseId}/manifest.json`,
    manifestSha256: await sha256Hex(manifestBytes),
  };
  content.set(channel.manifestUrl, manifestBytes);
  return { channel, rawManifest: rawManifest as ContentManifest, content, park: draft.park };
}


class MemoryContentStore implements ContentStore {
  activeId: string | null = null;
  releases = new Map<string, StoredRelease>();
  files = new Map<string, ArrayBuffer>();
  deletedFiles: string[] = [];
  retained = new Map<string, RetainedPark>();
  archived = new Map<string, ArchivedScene>();
  sync = new Map<ContentEnvironment, ContentSyncState>();
  inventories = new Map<string, ContentMapInventory>();
  cachedMapPointers = new Map<ContentEnvironment, ContentMapPointer>();
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
  async clearActiveRelease(expectedActiveId: string) {
    if (this.activeId !== expectedActiveId) throw new Error("Active content changed before its legacy pointer could be cleared");
    this.activeId = null;
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
    for (const scene of this.archived.values()) if (scene.file.sha256 === hash) throw new Error("File is referenced by archived scene");
    this.deletedFiles.push(hash);
    this.files.delete(hash);
  }
  async getRetainedParks() { return [...this.retained.values()].map((value) => structuredClone(value)); }
  async retainParks(parks: RetainedPark[]) { for (const entry of parks) this.retained.set(entry.park.id, structuredClone(entry)); }
  async getArchivedScene(releaseId: string, scene: string) { const value = this.archived.get(`${releaseId}:${scene}`); return value ? structuredClone(value) : undefined; }
  async retainArchivedScene(scene: ArchivedScene) { this.archived.set(`${scene.releaseId}:${scene.scene}`, structuredClone(scene)); }
  async listArchivedScenes() { return [...this.archived.values()].map((value) => structuredClone(value)); }
  async getSyncCursor(environment: ContentEnvironment): Promise<ContentSyncCursor | null> {
    const state = this.sync.get(environment);
    return state ? { revision: state.revision, sourceId: state.sourceId ?? "" } : null;
  }
  async getSyncState(environment: ContentEnvironment) { const value = this.sync.get(environment); return value ? structuredClone(value) : null; }
  async replaceSyncState(environment: ContentEnvironment, expectedRevision: number | null, state: ContentSyncState, sourceId: string, expectedSourceId: string | null, resetCursor = false) {
    const current = this.sync.get(environment);
    if ((current?.revision ?? null) !== expectedRevision || (current?.sourceId ?? null) !== expectedSourceId) throw new Error("Content sync cursor changed before the snapshot could be committed");
    if (!resetCursor && current && state.revision < current.revision) throw new Error("Content snapshot cannot move the sync cursor backwards");
    this.sync.set(environment, structuredClone({ ...state, sourceId }));
    if (state.map) this.cachedMapPointers.set(environment, structuredClone(state.map));
  }
  async applySyncBatch(environment: ContentEnvironment, expectedRevision: number, batch: ContentChangeBatch, sourceId: string) {
    const current = this.sync.get(environment);
    if (!current || current.revision !== expectedRevision || current.sourceId !== sourceId) throw new Error("Content sync cursor changed before the batch could be committed");
    this.sync.set(environment, structuredClone(applyContentChangeBatch(current, batch)));
    if (batch.changes.some((change) => change.entity === "map" && change.op === "upsert" && change.value)) {
      const change = batch.changes.find((entry) => entry.entity === "map" && entry.op === "upsert" && entry.value);
      if (change?.entity === "map" && change.value) this.cachedMapPointers.set(environment, structuredClone(change.value));
    }
  }
  async advanceSyncRevision(environment: ContentEnvironment, expectedRevision: number, revision: number, sourceId: string) {
    const current = this.sync.get(environment);
    if (!current || current.revision !== expectedRevision || current.sourceId !== sourceId) throw new Error("Content sync cursor changed before the revision could advance");
    this.sync.set(environment, { ...current, revision });
  }
  async getMapInventory(version: string) { const value = this.inventories.get(version); return value ? structuredClone(value) : null; }
  async putMapInventory(inventory: ContentMapInventory) { this.inventories.set(inventory.version, structuredClone(inventory)); }
  async pruneMapInventories(keepVersions: readonly string[]) { const keep = new Set(keepVersions); for (const version of this.inventories.keys()) if (!keep.has(version)) this.inventories.delete(version); }
  async getCachedMapPointer(environment: ContentEnvironment) { const value = this.cachedMapPointers.get(environment); return value ? structuredClone(value) : null; }
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

type TestSyncPark = Omit<Awaited<ReturnType<typeof makeRelease>>["park"], "scene"> & { scene: string | null };

function contentSyncSnapshot(revision: number, park: TestSyncPark, assets: ContentFile[]) {
  return {
    schema: "parkdex.content-sync/v1",
    revision,
    parks: [park],
    boundaries: {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { id: park.id, biome: park.biome },
        geometry: { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
      }],
    },
    drive: {
      hubs: [{ name: "Victoria", lng: -123.3, lat: 48.4 }],
      parks: { [park.id]: { drive: [null], walkM: 0 } },
    },
    assets,
    map: null,
  };
}

async function makeSceneAsset(version: string, scene: string, content: string) {
  const path = `art/badges/scenes/${scene}.webp`;
  const bytes = toBytes(content);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const file: ContentFile = {
    path,
    key: `releases/${version}/${path}`,
    url: `https://kip-assets.parkdex.app/releases/${version}/${encodedPath}`,
    sha256: await sha256Hex(bytes),
    byte_size: bytes.byteLength,
    content_type: "image/webp",
  };
  return { file, bytes };
}

function contentSyncServer(
  snapshot: ReturnType<typeof contentSyncSnapshot>,
  deltas = new Map<number, unknown>(),
  sceneLookups = new Map<string, ContentFile>(),
  files = new Map<string, ArrayBuffer>(),
) {
  const calls: string[] = [];
  const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.pathname === "/api/content/snapshot") return Response.json(snapshot);
    if (url.pathname === "/api/content/changes") {
      const after = Number(url.searchParams.get("after"));
      const explicit = deltas.get(after);
      return Response.json(explicit ?? {
        schema: "parkdex.content-sync/v1",
        fromRevision: after,
        throughRevision: after,
        headRevision: after,
        hasMore: false,
        batches: [],
      });
    }
    if (url.pathname === "/api/content/scene") {
      const releaseId = url.searchParams.get("releaseId") ?? "";
      const scene = url.searchParams.get("scene") ?? "";
      const file = sceneLookups.get(`${releaseId}:${scene}`);
      return file ? Response.json({ schema: "parkdex.scene-asset/v1", file }) : new Response("missing", { status: 404 });
    }
    const bytes = files.get(url.href);
    return bytes ? new Response(bytes.slice(0), { status: 200 }) : new Response("missing", { status: 404 });
  });
  return { calls, fetcher };
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

function createSyncRuntime(
  store: MemoryContentStore,
  fetcher: typeof fetch,
  connectivity: Connectivity,
  claimedParkIds: string[] = [],
  apiUrl: string | null = "https://parkdex.example.test/api/content/current",
  environment: ContentEnvironment = "staging",
) {
  return createContentRuntime({
    store,
    fetch: fetcher,
    apiUrl,
    environment,
    claimedParkIds: () => claimedParkIds,
    connectivity,
  } satisfies ContentRuntimeOptions);
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
    await vi.waitFor(async () => expect(await store.getActiveId()).toBe(b.channel.releaseId));
    const snapshot = runtime.getStatus().snapshot!;
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

describe("legacy archived art compatibility", () => {
  it("restores exact archived badge art, publishes its URL, and keeps the pinned hash through offline GC", async () => {
    const current = await makeRelease("b".repeat(64), 2, "current-park", "current-scene");
    const archived = await makeArchivedRelease("retired-park", "retired-scene");
    const server = contentServer(current);
    server.add(archived);
    const archivedRequests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(`${CONTENT_CDN_ORIGIN}/releases/${archived.channel.releaseId}/`)) archivedRequests.push(url);
      return server.fetcher(input, init);
    };
    const store = new MemoryContentStore();
    const runtime = track(createRuntime(store, fetcher, { connected: true, wifi: true }));
    await runtime.start();
    expect(runtime.getStatus().snapshot?.parkById.has("retired-park")).toBe(false);

    const archivedFile = archived.rawManifest.files.find((file) => file.path === "art/badges/scenes/retired-scene.webp")!;
    const url = await runtime.ensureArchivedScene(archived.channel.releaseId, "retired-scene");
    expect(url).toBe(`content-store://${archivedFile.sha256}`);
    expect(await store.getArchivedScene(archived.channel.releaseId, "retired-scene")).toEqual({
      releaseId: archived.channel.releaseId, scene: "retired-scene", file: archivedFile,
    });
    expect(await store.hasFile(archivedFile.sha256, archivedFile.byte_size)).toBe(true);
    expect(archivedRequests).toContain(archived.channel.manifestUrl);
    expect(archivedRequests).toContain(archivedFile.url);
    expect(runtime.getStatus().snapshot?.retainedSceneUrls.get(`${archived.channel.releaseId}:retired-scene`)).toBe(url);
    expect(runtime.getStatus().snapshot?.parks.map((park) => park.id)).toEqual(["current-park"]);
    const networkCount = archivedRequests.length;
    await expect(runtime.ensureArchivedScene(archived.channel.releaseId, "retired-scene")).resolves.toBe(url);
    expect(archivedRequests).toHaveLength(networkCount);

    await runtime.stop();
    const orphan = toBytes("unreferenced old content");
    const orphanHash = await sha256Hex(orphan);
    store.files.set(orphanHash, orphan);
    const offline = track(createRuntime(store, fetcher, { connected: false, wifi: false }));
    await offline.start();
    expect(offline.getStatus().snapshot?.releaseId).toBe(current.channel.releaseId);
    expect(store.deletedFiles).toContain(orphanHash);
    expect(store.deletedFiles).not.toContain(archivedFile.sha256);
    const beforeOfflineResolve = archivedRequests.length;
    await expect(offline.ensureArchivedScene(archived.channel.releaseId, "retired-scene")).resolves.toBe(url);
    expect(archivedRequests).toHaveLength(beforeOfflineResolve);
    expect(offline.getStatus().snapshot?.retainedSceneUrls.get(`${archived.channel.releaseId}:retired-scene`)).toBe(url);
    expect(offline.getStatus().snapshot?.parkById.has("retired-park")).toBe(false);
  });

  it("does not fetch archived art offline or while backgrounded", async () => {
    const archived = await makeArchivedRelease("retired-park", "retired-scene");
    const fetcher = vi.fn(async () => new Response("missing", { status: 404 })) as unknown as typeof fetch;
    const runtime = track(createRuntime(new MemoryContentStore(), fetcher, { connected: false, wifi: false }));
    await runtime.start();

    await expect(runtime.ensureArchivedScene(archived.channel.releaseId, "retired-scene")).rejects.toBeInstanceOf(ContentUnavailableOfflineError);
    expect(fetcher).not.toHaveBeenCalled();
    runtime.setForeground(false);
    runtime.setConnectivity({ connected: true, wifi: false });
    await expect(runtime.ensureArchivedScene(archived.channel.releaseId, "retired-scene")).rejects.toBeInstanceOf(ArchivedSceneRestoreDeferredError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aborts an in-flight archived restore when the runtime stops", async () => {
    const current = await makeRelease("c".repeat(64), 3, "current-park", "current-scene");
    const archived = await makeArchivedRelease("retired-park", "retired-scene");
    const server = contentServer(current);
    server.add(archived);
    let signal: AbortSignal | undefined;
    let manifestStarted!: () => void;
    const started = new Promise<void>((resolve) => { manifestStarted = resolve; });
    const fetcher: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === archived.channel.manifestUrl) {
        signal = init?.signal ?? undefined;
        manifestStarted();
        return new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return server.fetcher(input, init);
    };
    const runtime = track(createRuntime(new MemoryContentStore(), fetcher, { connected: true, wifi: true }));
    await runtime.start();
    const pending = runtime.ensureArchivedScene(archived.channel.releaseId, "retired-scene");
    await started;
    await runtime.stop();
    await expect(pending).rejects.toThrow("Content runtime is stopped");
    expect(signal?.aborted).toBe(true);
  });


});

describe("incremental content sync", () => {
  it("keeps skeleton parks in the catalogue, skips map traffic for a null pointer, and reuses an unchanged cursor", async () => {
    const release = await makeRelease("a".repeat(64), 1, "municipal-skeleton-park", "scene-a");
    const skeleton = { ...release.park, scene: null };
    const snapshot = contentSyncSnapshot(7, skeleton, []);
    const server = contentSyncServer(snapshot);
    const store = new MemoryContentStore();
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: true }));

    await runtime.start();

    const active = runtime.getStatus().snapshot!;
    expect(active.parks.map((park) => park.id)).toEqual([skeleton.id]);
    expect(active.parks[0]?.scene).toBeNull();
    expect(active.liveParks).toEqual([]);
    expect((await store.getSyncState("staging"))?.revision).toBe(7);
    expect((await store.getSyncState("staging"))?.sourceId).toBe("staging|https://parkdex.example.test/api/content");
    expect(server.calls.filter((url) => new URL(url).pathname.endsWith("/snapshot"))).toHaveLength(1);
    expect(server.calls.filter((url) => new URL(url).pathname.endsWith("/changes"))).toHaveLength(1);
    expect(server.calls.some((url) => new URL(url).pathname.includes("/map/"))).toBe(false);
  });

  it("hides a source-mismatched cached catalogue offline and snapshots instead of sending its old cursor", async () => {
    const previousRelease = await makeRelease("b".repeat(64), 1, "municipal-old-park", "scene-old");
    const previous = parseContentSnapshot(contentSyncSnapshot(11, { ...previousRelease.park, scene: null }, []));
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...previous, sourceId: "staging|https://old.example.test/api/content" });
    const currentRelease = await makeRelease("c".repeat(64), 2, "municipal-current-park", "scene-current");
    const server = contentSyncServer(contentSyncSnapshot(2, { ...currentRelease.park, scene: null }, []));
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: false, wifi: false }));

    await runtime.start();
    expect(runtime.getStatus().snapshot).toBeNull();
    expect(server.calls).toEqual([]);

    runtime.setConnectivity({ connected: true, wifi: true });
    await vi.waitFor(() => expect(runtime.getStatus().snapshot?.parks[0]?.id).toBe("municipal-current-park"));
    expect(server.calls.some((url) => new URL(url).pathname.endsWith("/snapshot"))).toBe(true);
    expect(server.calls.some((url) => new URL(url).pathname.endsWith("/changes") && new URL(url).searchParams.get("after") === "11")).toBe(false);
    expect((await store.getSyncCursor("staging"))?.sourceId).toBe("staging|https://parkdex.example.test/api/content");
  });

  it("shows a configuration error without requests when the main API origin is missing", async () => {
    const store = new MemoryContentStore();
    const fetcher = vi.fn(async () => new Response("unexpected", { status: 500 })) as typeof fetch;
    const runtime = track(createSyncRuntime(store, fetcher, { connected: true, wifi: true }, [], null, "main"));

    await runtime.start();

    expect(runtime.getStatus().syncStage).toBe("error");
    expect(runtime.getStatus().error).toMatch(/API is not configured/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("archives every claimed scene version before same-slug art changes", async () => {
    const release = await makeRelease("d".repeat(64), 1, "municipal-earned-park", "scene-a");
    const oldAsset = await makeSceneAsset("d".repeat(64), "scene-a", "old claimed badge art");
    const middleAsset = await makeSceneAsset("e".repeat(64), "scene-a", "middle claimed badge art");
    const currentAsset = await makeSceneAsset("f".repeat(64), "scene-a", "current badge art");
    const park = release.park;
    const snapshot = contentSyncSnapshot(1, park, [oldAsset.file]);
    const second: ContentChangeBatch = {
      revision: 2,
      changes: [
        { entity: "park", op: "upsert", id: park.id, value: park },
        { entity: "asset", op: "upsert", id: middleAsset.file.path, value: middleAsset.file },
      ],
    };
    const third: ContentChangeBatch = {
      revision: 3,
      changes: [
        { entity: "park", op: "upsert", id: park.id, value: park },
        { entity: "asset", op: "upsert", id: currentAsset.file.path, value: currentAsset.file },
      ],
    };
    const deltas = new Map<number, unknown>([
      [1, { schema: "parkdex.content-sync/v1", fromRevision: 1, throughRevision: 2, headRevision: 3, hasMore: true, batches: [second] }],
      [2, { schema: "parkdex.content-sync/v1", fromRevision: 2, throughRevision: 3, headRevision: 3, hasMore: false, batches: [third] }],
    ]);
    const files = new Map<string, ArrayBuffer>([
      [oldAsset.file.url, oldAsset.bytes],
      [middleAsset.file.url, middleAsset.bytes],
      [currentAsset.file.url, currentAsset.bytes],
    ]);
    const server = contentSyncServer(snapshot, deltas, new Map(), files);
    const store = new MemoryContentStore();
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: true }, [park.id]));

    await runtime.start();

    expect((await store.getSyncCursor("staging"))?.revision).toBe(3);
    expect(await store.getArchivedScene("d".repeat(64), "scene-a")).toEqual({ releaseId: "d".repeat(64), scene: "scene-a", file: oldAsset.file });
    expect(await store.getArchivedScene("e".repeat(64), "scene-a")).toEqual({ releaseId: "e".repeat(64), scene: "scene-a", file: middleAsset.file });
    expect(await store.hasFile(oldAsset.file.sha256, oldAsset.file.byte_size)).toBe(true);
    expect(await store.hasFile(middleAsset.file.sha256, middleAsset.file.byte_size)).toBe(true);
    expect(runtime.getSceneAssetVersion(park.id, "scene-a")).toBe("f".repeat(64));
  });

  it("restores an archived descriptor and bytes through the Wi-Fi content API", async () => {
    const currentRelease = await makeRelease("1".repeat(64), 1, "municipal-current-park", "scene-current");
    const currentSceneFile = currentRelease.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-current.webp")!;
    const snapshot = contentSyncSnapshot(1, currentRelease.park, [currentSceneFile]);
    const archivedAsset = await makeSceneAsset("2".repeat(64), "scene-archived", "restored badge bytes");
    const server = contentSyncServer(
      snapshot,
      new Map(),
      new Map([[`2`.repeat(64) + ":scene-archived", archivedAsset.file]]),
      new Map([
        [currentSceneFile.url, currentRelease.content.get(currentSceneFile.url)!],
        [archivedAsset.file.url, archivedAsset.bytes],
      ]),
    );
    const store = new MemoryContentStore();
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: true }));
    await runtime.start();
    expect(runtime.getStatus().error).toBeNull();
    expect(runtime.getStatus().snapshot).not.toBeNull();

    const url = await runtime.ensureArchivedScene("2".repeat(64), "scene-archived");

    expect(url).toBe(`content-store://${archivedAsset.file.sha256}`);
    expect(await store.getArchivedScene("2".repeat(64), "scene-archived")).toEqual({ releaseId: "2".repeat(64), scene: "scene-archived", file: archivedAsset.file });
    expect(await store.hasFile(archivedAsset.file.sha256, archivedAsset.file.byte_size)).toBe(true);
    expect(runtime.getStatus().snapshot?.retainedSceneUrls.get(`${"2".repeat(64)}:scene-archived`)).toBe(url);
    expect(server.calls.some((entry) => new URL(entry).pathname.endsWith("/scene") && new URL(entry).searchParams.get("releaseId") === "2".repeat(64))).toBe(true);

    runtime.setConnectivity({ connected: false, wifi: false });
    await expect(runtime.ensureArchivedScene("2".repeat(64), "scene-archived")).resolves.toBe(url);
    expect(runtime.getStatus().snapshot?.retainedSceneUrls.get(`${"2".repeat(64)}:scene-archived`)).toBe(url);
  });

  it("defers an uncached archive restore while backgrounded before checking Wi-Fi", async () => {
    const store = new MemoryContentStore();
    const fetcher = vi.fn(async () => new Response("unexpected", { status: 500 })) as typeof fetch;
    const runtime = track(createSyncRuntime(store, fetcher, { connected: false, wifi: false }));
    await runtime.start();
    runtime.setForeground(false);

    await expect(runtime.ensureArchivedScene("3".repeat(64), "scene-background"))
      .rejects.toBeInstanceOf(ArchivedSceneRestoreDeferredError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes an in-flight archive restore aborted by runtime stop", async () => {
    const currentRelease = await makeRelease("4".repeat(64), 1, "municipal-current-park", "scene-current");
    const snapshot = contentSyncSnapshot(1, currentRelease.park, [currentRelease.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-current.webp")!]);
    const archivedAsset = await makeSceneAsset("5".repeat(64), "scene-stopping", "stopped badge bytes");
    const server = contentSyncServer(
      snapshot,
      new Map(),
      new Map([[`${"5".repeat(64)}:scene-stopping`, archivedAsset.file]]),
      new Map([[archivedAsset.file.url, archivedAsset.bytes]]),
    );
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    let requestSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/content/scene") {
        requestSignal = init?.signal ?? undefined;
        resolveStarted();
        return new Promise<Response>((_resolve, reject) => {
          if (requestSignal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return server.fetcher(input, init);
    };
    const runtime = track(createSyncRuntime(new MemoryContentStore(), fetcher, { connected: true, wifi: true }));
    await runtime.start();
    const pending = runtime.ensureArchivedScene("5".repeat(64), "scene-stopping");
    await started;

    const stopped = runtime.stop();
    await expect(pending).rejects.toThrow("Content runtime is stopped");
    expect(requestSignal?.aborted).toBe(true);
    await stopped;
  });
});
