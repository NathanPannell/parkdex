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
import { ArchivedSceneRestoreDeferredError, ContentUnavailableOfflineError, createContentRuntime, mapAnchorFor } from "./runtime";
import { CONTENT_CDN_ORIGIN, CONTENT_READER_VERSION, contentTransportPausedError } from "./contracts";
import { contentGateView } from "../../components/contentGateState";
import { getAllowedMapChunks, resetAllowedMapChunks } from "../offlineTiles";

const mapMock = vi.hoisted(() => ({
  calls: [] as { releaseId: string; detail: string }[],
  onCall: null as null | ((detail: string) => void),
  pauseNext: false,
  onPause: null as null | (() => void),
  releasePause: null as null | (() => void),
  pauseNearby: false,
  nearbySignals: [] as Array<AbortSignal | undefined>,
  onNearbyPause: null as null | (() => void),
  releaseNearby: null as null | (() => void),
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
    if (detail === "nearby") mapMock.nearbySignals.push(signal);
    if (!snapshotOverride || snapshotOverride.releaseId !== releaseId) throw new Error("candidate prefetch requires a private matching snapshot");
    if (!releaseId.startsWith("sync-") && runtime.getStatus().snapshot?.releaseId === releaseId) throw new Error("candidate snapshot was published before map verification");
    mapMock.onCall?.(detail);
    if (mapMock.pauseNext) {
      mapMock.pauseNext = false;
      await new Promise<void>((resolve) => {
        mapMock.releasePause = resolve;
        mapMock.onPause?.();
      });
    }
    if (detail === "nearby" && mapMock.pauseNearby) {
      mapMock.pauseNearby = false;
      await new Promise<void>((resolve) => {
        mapMock.releaseNearby = resolve;
        mapMock.onNearbyPause?.();
      });
    }
    const { mapChunkPath, mapFolder } = await import("./contracts");
    await runtime.ensureFile(releaseId, mapChunkPath(0, mapFolder(snapshotOverride.manifest.files)), "nearby", signal);
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

async function makeRelease(id: string, generation: number, parkId: string, scene: string, mapFolder = "island") {
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
    [`map/${mapFolder}/manifest.json`, toBytes(mapIndex)],
    [`map/${mapFolder}/000.bin`, new Uint8Array([1, 2, 3, 4]).buffer],
    [`map/${mapFolder}/001.bin`, new Uint8Array([5, 6, 7, 8]).buffer],
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
  readerVersions = new Map<ContentEnvironment, number>();
  async getSyncCursor(environment: ContentEnvironment): Promise<ContentSyncCursor | null> {
    const state = this.sync.get(environment);
    const readerVersion = this.readerVersions.get(environment);
    return state ? { revision: state.revision, sourceId: state.sourceId ?? "", readerVersion: readerVersion ?? CONTENT_READER_VERSION } : null;
  }
  async getSyncState(environment: ContentEnvironment) { const value = this.sync.get(environment); return value ? structuredClone(value) : null; }
  async replaceSyncState(environment: ContentEnvironment, expectedRevision: number | null, state: ContentSyncState, sourceId: string, expectedSourceId: string | null, resetCursor = false) {
    const current = this.sync.get(environment);
    if ((current?.revision ?? null) !== expectedRevision || (current?.sourceId ?? null) !== expectedSourceId) throw new Error("Content sync cursor changed before the snapshot could be committed");
    if (!resetCursor && current && state.revision < current.revision) throw new Error("Content snapshot cannot move the sync cursor backwards");
    this.sync.set(environment, structuredClone({ ...state, sourceId }));
    this.readerVersions.delete(environment);
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

function contentSyncSnapshot(revision: number, park: TestSyncPark, assets: ContentFile[]): ContentSyncState & { schema: "parkdex.content-sync/v1" } {
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
  mapPointer?: ContentMapPointer,
) {
  return createContentRuntime({
    store,
    fetch: fetcher,
    apiUrl,
    environment,
    claimedParkIds: () => claimedParkIds,
    connectivity,
    ...(mapPointer ? { mapPointer } : {}),
  } satisfies ContentRuntimeOptions);
}

const runtimes: ContentRuntime[] = [];
function track(runtime: ContentRuntime) { runtimes.push(runtime); return runtime; }

beforeEach(() => {
  mapMock.calls.length = 0;
  mapMock.onCall = null;
  mapMock.pauseNext = false;
  mapMock.onPause = null;
  mapMock.releasePause = null;
  mapMock.pauseNearby = false;
  mapMock.nearbySignals.length = 0;
  mapMock.onNearbyPause = null;
  mapMock.releaseNearby = null;
  resetAllowedMapChunks("a".repeat(64));
  resetAllowedMapChunks("b".repeat(64));
  resetAllowedMapChunks("c".repeat(64));
  resetAllowedMapChunks("d".repeat(64));
  resetAllowedMapChunks("e".repeat(64));
});

afterEach(async () => {
  mapMock.releasePause?.();
  mapMock.releaseNearby?.();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  vi.restoreAllMocks();
});

describe("starter map anchor", () => {
  it("follows the visitor inside a province and the nearest province's town outside them", () => {
    const halifax: [number, number] = [-63.58, 44.65];
    expect(mapAnchorFor(halifax, halifax)).toEqual(halifax);
    // Toronto is nearer Nova Scotia than BC; Seattle is nearer BC.
    expect(mapAnchorFor(null, [-79.38, 43.65])).toEqual([-63.5752, 44.6488]);
    expect(mapAnchorFor(null, [-122.33, 47.61])).toEqual([-123.3656, 48.4284]);
    // Before any location, Victoria as before.
    expect(mapAnchorFor(null, null)).toEqual([-123.3656, 48.4284]);
  });
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

  it("ends the transfer indicator after file bytes arrive, before local storage work", async () => {
    const release = await makeRelease("d".repeat(64), 1, "municipal-transfer-park", "scene-transfer");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-transfer.webp")!;
    const server = contentServer(release);
    const sceneBytes = release.content.get(sceneFile.url)!;
    const store = new MemoryContentStore();
    let storeSceneWriteStarted!: () => void;
    const storeSceneStarted = new Promise<void>((resolve) => { storeSceneWriteStarted = resolve; });
    let releaseSceneWrite!: () => void;
    const sceneWriteGate = new Promise<void>((resolve) => { releaseSceneWrite = resolve; });
    const originalPutFile = store.putFile.bind(store);
    store.putFile = async (hash, bytes) => {
      if (hash === sceneFile.sha256) {
        storeSceneWriteStarted();
        await sceneWriteGate;
      }
      await originalPutFile(hash, bytes);
    };
    let releaseSceneFetch!: () => void;
    let signalSceneFetchStarted!: () => void;
    const sceneFetchStarted = new Promise<void>((resolve) => { signalSceneFetchStarted = resolve; });
    const fetcher: typeof fetch = (input, init) => {
      if (String(input) === sceneFile.url) {
        signalSceneFetchStarted();
        return new Promise<Response>((resolve, reject) => {
          releaseSceneFetch = () => resolve(new Response(sceneBytes.slice(0)));
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return server.fetcher(input, init);
    };
    const runtime = track(createRuntime(store, fetcher, { connected: true, wifi: true }));
    const start = runtime.start();

    await sceneFetchStarted;
    expect(runtime.getStatus().activeDownloads).toBeGreaterThan(0);
    releaseSceneFetch();
    await storeSceneStarted;
    await vi.waitFor(() => expect(runtime.getStatus().activeDownloads).toBe(0));
    releaseSceneWrite();
    await start;
    expect(runtime.getStatus().activeDownloads).toBe(0);
  });

  it("hydrates a verified snapshot offline and checks for updates when internet returns", async () => {
    const a = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const server = contentServer(a);
    const store = new MemoryContentStore();
    const first = track(createRuntime(store, server.fetcher, { connected: true, wifi: true }));
    await first.start();
    expect(first.getStatus().snapshot?.releaseId).toBe(a.channel.releaseId);
    const discoveryRequests = () => (server.fetcher as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => String(call[0]) === DISCOVERY_URL).length;
    const requestsAtLaunch = discoveryRequests();
    const mapPrefetchesAtLaunch = mapMock.calls.length;
    first.setForeground(false);
    first.setForeground(true);
    first.setConnectivity({ connected: false, wifi: false });
    first.setConnectivity({ connected: true, wifi: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discoveryRequests()).toBe(requestsAtLaunch + 1);
    const requestsAfterReconnect = discoveryRequests();

    const second = track(createRuntime(store, server.fetcher, { connected: false, wifi: false }));
    await second.start();
    expect(second.getStatus().phase).toBe("offline");
    expect(second.getStatus().snapshot?.releaseId).toBe(a.channel.releaseId);
    expect(second.getStatus().snapshot?.assetUrls.has("data/parks.json")).toBe(true);
    expect(discoveryRequests()).toBe(requestsAfterReconnect);
    expect(mapMock.calls).toHaveLength(mapPrefetchesAtLaunch);
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

  it("uses the build's pinned map instead of the server's map pointer", async () => {
    const release = await makeRelease("d".repeat(64), 1, "provincial-pinned-map-park", "scene-pinned");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-pinned.webp")!;
    const mapFiles = release.rawManifest.files.filter((file) => file.path.startsWith("map/"));
    const inventory: ContentMapInventory = {
      schema: "parkdex.content-map/v1",
      version: release.channel.releaseId,
      mapManifest: release.rawManifest.mapManifest,
      files: mapFiles,
    };
    const inventoryBytes = toBytes(inventory);
    const pinned: ContentMapPointer = {
      version: release.channel.releaseId,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${release.channel.releaseId}/map/manifest.json`,
      manifestSha256: await sha256Hex(inventoryBytes),
    };
    const serverVersion = "e".repeat(64);
    const serverPointer: ContentMapPointer = {
      version: serverVersion,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${serverVersion}/map/manifest.json`,
      manifestSha256: "f".repeat(64),
    };
    const snapshot = { ...contentSyncSnapshot(9, release.park, [sceneFile]), map: serverPointer };
    const remoteFiles = new Map<string, ArrayBuffer>([[pinned.manifestUrl, inventoryBytes]]);
    for (const file of mapFiles) remoteFiles.set(file.url, release.content.get(file.url)!.slice(0));
    remoteFiles.set(sceneFile.url, release.content.get(sceneFile.url)!.slice(0));
    const server = contentSyncServer(snapshot, new Map(), new Map(), remoteFiles);
    const store = new MemoryContentStore();
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: false }, [], undefined, "staging", pinned));
    await runtime.start();

    await vi.waitFor(() => expect(runtime.getStatus().mapDetailReady).toBe(true));
    expect(runtime.getStatus().snapshot?.releaseId).toBe(`sync-staging-9-${pinned.version}`);
    expect(server.calls).toContain(pinned.manifestUrl);
    expect(server.calls).not.toContain(serverPointer.manifestUrl);
    expect((await store.getSyncState("staging"))?.map).toEqual(pinned);
  });

  it("reads a pinned map whose chunks are in map/detail/, like the combined BC and Nova Scotia map", async () => {
    const release = await makeRelease("d".repeat(64), 1, "provincial-detail-map-park", "scene-detail", "detail");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-detail.webp")!;
    const mapFiles = release.rawManifest.files.filter((file) => file.path.startsWith("map/"));
    const inventory: ContentMapInventory = {
      schema: "parkdex.content-map/v1",
      version: release.channel.releaseId,
      mapManifest: release.rawManifest.mapManifest,
      files: mapFiles,
    };
    const inventoryBytes = toBytes(inventory);
    const pinned: ContentMapPointer = {
      version: release.channel.releaseId,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${release.channel.releaseId}/map/manifest.json`,
      manifestSha256: await sha256Hex(inventoryBytes),
    };
    const snapshot = contentSyncSnapshot(9, release.park, [sceneFile]);
    const remoteFiles = new Map<string, ArrayBuffer>([[pinned.manifestUrl, inventoryBytes]]);
    for (const file of mapFiles) remoteFiles.set(file.url, release.content.get(file.url)!.slice(0));
    remoteFiles.set(sceneFile.url, release.content.get(sceneFile.url)!.slice(0));
    const server = contentSyncServer(snapshot, new Map(), new Map(), remoteFiles);
    const store = new MemoryContentStore();
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: false }, [], undefined, "staging", pinned));
    await runtime.start();

    await vi.waitFor(() => expect(runtime.getStatus().mapDetailReady).toBe(true));
    const releaseId = runtime.getStatus().snapshot!.releaseId;
    const firstChunk = mapFiles.find((file) => file.path === "map/detail/000.bin")!;
    await vi.waitFor(async () => expect(await store.hasFile(firstChunk.sha256, firstChunk.byte_size)).toBe(true));
    expect(server.calls).not.toContain(mapFiles.find((file) => file.path === "map/detail/001.bin")!.url);
    expect(await runtime.hasLocalFile?.(releaseId, "map/detail/000.bin")).toBe(true);
    expect([...new Uint8Array((await runtime.readLocalMapFile?.(pinned.version, "map/detail/000.bin"))!)]).toEqual([1, 2, 3, 4]);
    await runtime.deleteMapChunk?.(releaseId, "map/detail/000.bin");
    expect(await store.hasFile(firstChunk.sha256, firstChunk.byte_size)).toBe(false);
  });

  it("downloads nearby detail on mobile data and never fetches the whole map", async () => {
    const release = await makeRelease("a".repeat(64), 1, "provincial-a-park", "scene-a");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-a.webp")!;
    const mapFiles = release.rawManifest.files.filter((file) => file.path.startsWith("map/"));
    const inventory: ContentMapInventory = {
      schema: "parkdex.content-map/v1",
      version: release.channel.releaseId,
      mapManifest: release.rawManifest.mapManifest,
      files: mapFiles,
    };
    const inventoryBytes = toBytes(inventory);
    const pointer: ContentMapPointer = {
      version: release.channel.releaseId,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${release.channel.releaseId}/map/manifest.json`,
      manifestSha256: await sha256Hex(inventoryBytes),
    };
    const snapshot = { ...contentSyncSnapshot(7, release.park, [sceneFile]), map: pointer };
    const remoteFiles = new Map<string, ArrayBuffer>([[pointer.manifestUrl, inventoryBytes]]);
    for (const file of mapFiles) remoteFiles.set(file.url, release.content.get(file.url)!.slice(0));
    const server = contentSyncServer(snapshot, new Map(), new Map(), remoteFiles);
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...parseContentSnapshot(snapshot), sourceId: "staging|https://parkdex.example.test/api/content" });
    store.files.set(sceneFile.sha256, release.content.get(sceneFile.url)!.slice(0));
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: false }));
    await runtime.start();
    const firstChunk = mapFiles.find((file) => file.path === "map/island/000.bin")!;
    const secondChunkUrl = mapFiles.find((file) => file.path === "map/island/001.bin")!.url;
    await vi.waitFor(async () => expect(await store.hasFile(firstChunk.sha256, firstChunk.byte_size)).toBe(true));
    expect(runtime.getStatus().waitingForWifi).toBe(false);

    runtime.setConnectivity({ connected: true, wifi: true });
    runtime.setForeground(false);
    runtime.setForeground(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.calls).not.toContain(secondChunkUrl);
    expect(runtime.getStatus().waitingForWifi).toBe(false);
  });;
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
  it("waits for required cached badge art but keeps detailed map verification in the background", async () => {
    const release = await makeRelease("e".repeat(64), 1, "municipal-cached-park", "scene-cached");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-cached.webp")!;
    const sceneBytes = release.content.get(sceneFile.url)!;
    const inventoryFiles = release.rawManifest.files.filter((file) => file.path.startsWith("map/"));
    const inventory: ContentMapInventory = {
      schema: "parkdex.content-map/v1",
      version: release.channel.releaseId,
      mapManifest: release.rawManifest.mapManifest,
      files: inventoryFiles,
    };
    const mapPointer = {
      version: release.channel.releaseId,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${release.channel.releaseId}/map/manifest.json`,
      manifestSha256: "f".repeat(64),
    };
    const state = parseContentSnapshot({
      ...contentSyncSnapshot(14, release.park, [sceneFile]),
      map: mapPointer,
    });
    const sourceId = "staging|https://parkdex.example.test/api/content";
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...state, sourceId });
    store.inventories.set(inventory.version, inventory);
    store.files.set(sceneFile.sha256, sceneBytes.slice(0));
    for (const file of inventoryFiles) {
      const bytes = release.content.get(file.url);
      if (!bytes) throw new Error(`Cached map fixture is missing ${file.path}`);
      store.files.set(file.sha256, bytes.slice(0));
    }

    let releaseSceneCheck!: () => void;
    let releaseChunkCheck!: () => void;
    let releaseFileIndex!: (files: { hash: string; size: number }[]) => void;
    let sceneCheckStarted = false;
    let chunkCheckStarted = false;
    let fileIndexStarted = false;
    const sceneGate = new Promise<void>((resolve) => { releaseSceneCheck = resolve; });
    const chunkGate = new Promise<void>((resolve) => { releaseChunkCheck = resolve; });
    const originalHasFile = store.hasFile.bind(store);
    store.hasFile = async (hash, size) => {
      if (hash === sceneFile.sha256) {
        sceneCheckStarted = true;
        await sceneGate;
      }
      const chunk = inventoryFiles.find((file) => file.path === "map/island/000.bin");
      if (hash === chunk?.sha256) {
        chunkCheckStarted = true;
        await chunkGate;
      }
      return originalHasFile(hash, size);
    };
    store.listFiles = () => {
      fileIndexStarted = true;
      return new Promise((resolve) => { releaseFileIndex = resolve; });
    };

    let changesStarted!: () => void;
    const changesGate = new Promise<void>((resolve) => { changesStarted = resolve; });
    const fetcher: typeof fetch = (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/changes")) {
        changesStarted();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return Promise.reject(new Error(`Unexpected request while rehydrating cached content: ${String(input)}`));
    };
    const runtime = track(createSyncRuntime(store, fetcher, {
      connected: true,
      wifi: false,
      contentDownloadAllowed: true,
    }));
    const start = runtime.start();

    await vi.waitFor(() => expect(sceneCheckStarted).toBe(true));
    expect(runtime.getStatus().snapshot).toBeNull();
    releaseSceneCheck();
    await Promise.all([changesGate, vi.waitFor(() => expect(chunkCheckStarted).toBe(true)), vi.waitFor(() => expect(fileIndexStarted).toBe(true))]);
    const cached = runtime.getStatus().snapshot!;
    expect(cached.releaseId).toBe(`sync-staging-14-${release.channel.releaseId}`);
    expect(cached.assetUrls.get(sceneFile.path)).toBe(`content-store://${sceneFile.sha256}`);
    expect(runtime.getStatus().fullMapReady).toBe(false);
    expect(runtime.getStatus().activeDownloads).toBe(0);
    expect(getAllowedMapChunks(cached.releaseId)).toEqual([]);

    releaseChunkCheck();
    releaseFileIndex([...store.files.entries()].map(([hash, bytes]) => ({ hash, size: bytes.byteLength })));
    await vi.waitFor(() => {
      expect(runtime.getStatus().snapshot?.assetUrls.get(sceneFile.path)).toBe(`content-store://${sceneFile.sha256}`);
      expect(runtime.getStatus().fullMapReady).toBe(true);
    });
    expect(getAllowedMapChunks(cached.releaseId)).toEqual([0, 1]);
    await runtime.stop();
    await start;
  });

  it("keeps a verified saved map available on cellular while Wi-Fi-only downloads wait", async () => {
    const release = await makeRelease("a".repeat(64), 1, "municipal-cellular-cache-park", "scene-cellular");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-cellular.webp")!;
    const mapFiles = release.rawManifest.files.filter((file) => file.path.startsWith("map/"));
    const inventory: ContentMapInventory = {
      schema: "parkdex.content-map/v1",
      version: release.channel.releaseId,
      mapManifest: release.rawManifest.mapManifest,
      files: mapFiles,
    };
    const pointer = {
      version: release.channel.releaseId,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${release.channel.releaseId}/map/manifest.json`,
      manifestSha256: "e".repeat(64),
    };
    const state = parseContentSnapshot({
      ...contentSyncSnapshot(18, release.park, [sceneFile]),
      map: pointer,
    });
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...state, sourceId: "staging|https://parkdex.example.test/api/content" });
    store.files.set(sceneFile.sha256, release.content.get(sceneFile.url)!.slice(0));
    store.inventories.set(inventory.version, inventory);
    for (const file of mapFiles) store.files.set(file.sha256, release.content.get(file.url)!.slice(0));
    const chunkZero = mapFiles.find((file) => file.path === "map/island/000.bin")!;
    const originalHasFile = store.hasFile.bind(store);
    let releaseChunkCheck!: () => void;
    let signalChunkCheckStarted!: () => void;
    const chunkGate = new Promise<void>((resolve) => { releaseChunkCheck = resolve; });
    const chunkCheckStarted = new Promise<void>((resolve) => { signalChunkCheckStarted = resolve; });
    store.hasFile = async (hash, size) => {
      if (hash === chunkZero.sha256) {
        signalChunkCheckStarted();
        await chunkGate;
      }
      return originalHasFile(hash, size);
    };
    const fetcher = vi.fn(async () => new Response("unexpected network request", { status: 500 })) as typeof fetch;
    const runtime = track(createSyncRuntime(store, fetcher, {
      connected: true,
      wifi: false,
      contentDownloadAllowed: false,
    }));

    await runtime.start();
    await chunkCheckStarted;
    const snapshot = runtime.getStatus().snapshot!;
    expect(snapshot.parks[0]?.id).toBe("municipal-cellular-cache-park");
    expect(snapshot.releaseId).toBe(`sync-staging-18-${release.channel.releaseId}`);
    expect(runtime.getStatus()).toMatchObject({ phase: "ready", activeDownloads: 0, waitingForWifi: false });
    expect(runtime.getStatus().mapDetailReady).toBe(true);
    expect(getAllowedMapChunks(snapshot.releaseId)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    releaseChunkCheck();
    await vi.waitFor(() => expect(getAllowedMapChunks(snapshot.releaseId)).toEqual([0, 1]));
    expect([...new Uint8Array(await runtime.readFile(snapshot.releaseId, "map/island/000.bin"))]).toEqual([1, 2, 3, 4]);
    expect(runtime.getStatus().fullMapReady).toBe(true);
  });

  it("does not publish a cached catalogue with only some required badges verified", async () => {
    const slowPark = { id: "municipal-slow-cached-art-park", name: "Slow art park", short: "Slow Art", ...PARK_FIELDS, scene: "slow-cached-scene" };
    const fastPark = { id: "municipal-fast-cached-art-park", name: "Fast art park", short: "Fast Art", ...PARK_FIELDS, scene: "fast-cached-scene" };
    const slowAsset = await makeSceneAsset("a".repeat(64), slowPark.scene, "slow cached scene art");
    const fastAsset = await makeSceneAsset("b".repeat(64), fastPark.scene, "fast cached scene art");
    const firstParkSnapshot = contentSyncSnapshot(1, slowPark, [slowAsset.file, fastAsset.file]);
    const secondParkSnapshot = contentSyncSnapshot(1, fastPark, []);
    const cachedState = parseContentSnapshot({
      ...firstParkSnapshot,
      parks: [slowPark, fastPark],
      boundaries: {
        type: "FeatureCollection",
        features: [...firstParkSnapshot.boundaries.features, ...secondParkSnapshot.boundaries.features],
      },
      drive: {
        hubs: firstParkSnapshot.drive.hubs,
        parks: { ...firstParkSnapshot.drive.parks, ...secondParkSnapshot.drive.parks },
      },
    });
    const delta = {
      schema: "parkdex.content-sync/v1",
      fromRevision: 1,
      throughRevision: 2,
      headRevision: 2,
      hasMore: false,
      batches: [{
        revision: 2,
        changes: [
          { entity: "park", op: "upsert", id: slowPark.id, value: { ...slowPark, scene: null } },
          { entity: "asset", op: "delete", id: slowAsset.file.path },
        ],
      }],
    };
    const deltas = new Map<number, unknown>();
    const server = contentSyncServer(firstParkSnapshot, deltas);
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...cachedState, sourceId: "staging|https://parkdex.example.test/api/content" });
    store.files.set(slowAsset.file.sha256, slowAsset.bytes.slice(0));
    store.files.set(fastAsset.file.sha256, fastAsset.bytes.slice(0));
    const originalHasFile = store.hasFile.bind(store);
    let releaseSlowVerification!: () => void;
    let signalSlowVerification!: () => void;
    const slowVerificationGate = new Promise<void>((resolve) => { releaseSlowVerification = resolve; });
    const slowVerificationStarted = new Promise<void>((resolve) => { signalSlowVerification = resolve; });
    store.hasFile = async (hash, size) => {
      if (hash === slowAsset.file.sha256) {
        signalSlowVerification();
        await slowVerificationGate;
      }
      return originalHasFile(hash, size);
    };
    const originalFileUrl = store.fileUrl.bind(store);
    let signalSlowUrlCreated!: () => void;
    const slowUrlCreated = new Promise<void>((resolve) => { signalSlowUrlCreated = resolve; });
    store.fileUrl = async (hash) => {
      const url = await originalFileUrl(hash);
      if (hash === slowAsset.file.sha256) signalSlowUrlCreated();
      return url;
    };
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: false, wifi: false }));

    const start = runtime.start();
    await slowVerificationStarted;
    expect(runtime.getStatus().snapshot).toBeNull();
    expect(server.fetcher).not.toHaveBeenCalled();
    releaseSlowVerification();
    await slowUrlCreated;
    await start;
    const snapshot = runtime.getStatus().snapshot!;
    expect(snapshot.assetUrls.get(slowAsset.file.path)).toBe(`content-store://${slowAsset.file.sha256}`);
    expect(snapshot.assetUrls.get(fastAsset.file.path)).toBe(`content-store://${fastAsset.file.sha256}`);
    expect(deltas.size).toBe(0);
  });

  it("refreshes a cache written by an older content reader from one full snapshot", async () => {
    const cachedPark = { id: "municipal-upgrade-park", name: "Old name", short: "Upgrade", ...PARK_FIELDS, scene: null };
    const cached = parseContentSnapshot(contentSyncSnapshot(4, cachedPark, []));
    const server = contentSyncServer(contentSyncSnapshot(4, { ...cachedPark, name: "Refreshed name" }, []));
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...cached, sourceId: "staging|https://parkdex.example.test/api/content" });
    store.readerVersions.set("staging", 0);
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: true }));

    await runtime.start();
    await vi.waitFor(() => expect(runtime.getStatus().snapshot?.parks[0]?.name).toBe("Refreshed name"));
    expect(server.calls.filter((url) => url.includes("/api/content/snapshot"))).toHaveLength(1);
    expect(store.readerVersions.has("staging")).toBe(false);
  });

  it("keeps using incremental changes when the cache was written by the current reader", async () => {
    const cachedPark = { id: "municipal-current-park", name: "Cached name", short: "Current", ...PARK_FIELDS, scene: null };
    const cached = parseContentSnapshot(contentSyncSnapshot(4, cachedPark, []));
    const server = contentSyncServer(contentSyncSnapshot(4, { ...cachedPark, name: "Snapshot name" }, []));
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...cached, sourceId: "staging|https://parkdex.example.test/api/content" });
    store.readerVersions.set("staging", CONTENT_READER_VERSION);
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: true }));

    await runtime.start();
    await vi.waitFor(() => expect(server.calls.some((url) => url.includes("/api/content/changes"))).toBe(true));
    expect(server.calls.some((url) => url.includes("/api/content/snapshot"))).toBe(false);
    expect(runtime.getStatus().snapshot?.parks[0]?.name).toBe("Cached name");
  });

  it("retries failed required badge art before publishing and starts map work afterward", async () => {
    const release = await makeRelease("7".repeat(64), 1, "municipal-startup-order-park", "scene-startup-order");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-startup-order.webp")!;
    const mapFiles = release.rawManifest.files.filter((file) => file.path.startsWith("map/"));
    const inventory: ContentMapInventory = {
      schema: "parkdex.content-map/v1",
      version: release.channel.releaseId,
      mapManifest: release.rawManifest.mapManifest,
      files: mapFiles,
    };
    const inventoryBytes = toBytes(inventory);
    const pointer = {
      version: release.channel.releaseId,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${release.channel.releaseId}/map/manifest.json`,
      manifestSha256: await sha256Hex(inventoryBytes),
    };
    const files = new Map<string, ArrayBuffer>([[pointer.manifestUrl, inventoryBytes]]);
    for (const file of mapFiles) files.set(file.url, release.content.get(file.url)!.slice(0));
    files.set(sceneFile.url, release.content.get(sceneFile.url)!.slice(0));
    const server = contentSyncServer({ ...contentSyncSnapshot(41, release.park, [sceneFile]), map: pointer }, new Map(), new Map(), files);
    const events: string[] = [];
    let releaseFirstArt!: () => void;
    let signalFirstArt!: () => void;
    const firstArtGate = new Promise<void>((resolve) => { releaseFirstArt = resolve; });
    const firstArtStarted = new Promise<void>((resolve) => { signalFirstArt = resolve; });
    let artAttempts = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === sceneFile.url) {
        artAttempts += 1;
        events.push(`art-${artAttempts}-started`);
        if (artAttempts === 1) {
          signalFirstArt();
          await firstArtGate;
          events.push("art-1-failed");
          return new Response("badge temporarily unavailable", { status: 503 });
        }
      }
      if (url === pointer.manifestUrl) events.push("inventory");
      if (mapFiles.some((file) => file.url === url && file.path.startsWith("map/fonts/"))) events.push("glyph-requested");
      return server.fetcher(input, init);
    };
    const store = new MemoryContentStore();
    const glyphHashes = new Set(mapFiles.filter((file) => file.path.startsWith("map/fonts/")).map((file) => file.sha256));
    const originalPutFile = store.putFile.bind(store);
    store.putFile = async (hash, bytes) => {
      await originalPutFile(hash, bytes);
      if (hash === sceneFile.sha256) events.push("art-verified");
      if (glyphHashes.has(hash)) events.push("glyph-verified");
    };
    mapMock.onCall = (detail) => events.push(detail);
    const runtime = track(createSyncRuntime(store, fetcher, { connected: true, wifi: true }, [release.park.id]));
    const start = runtime.start();

    await firstArtStarted;
    expect(runtime.getStatus().snapshot).toBeNull();
    expect(mapMock.calls).toEqual([]);
    expect(events).not.toContain("inventory");
    releaseFirstArt();
    await start;

    expect(runtime.getStatus().snapshot).toBeNull();
    expect(events).toContain("art-1-failed");
    expect(events).not.toContain("inventory");
    await vi.waitFor(() => expect(runtime.getStatus().snapshot?.parks[0]?.id).toBe(release.park.id), { timeout: 4_000 });
    expect(runtime.getStatus().snapshot?.assetUrls.get(sceneFile.path)).toBe(`content-store://${sceneFile.sha256}`);
    expect(runtime.getStatus().error).toBeNull();
    await vi.waitFor(() => expect(runtime.getStatus().mapDetailReady).toBe(true), { timeout: 4_000 });
    await vi.waitFor(() => expect(events).toContain("starter"));
    const artVerifiedIndex = events.indexOf("art-verified");
    const inventoryIndex = events.indexOf("inventory");
    const glyphIndex = events.indexOf("glyph-verified");
    const starterIndex = events.indexOf("starter");
    expect(artVerifiedIndex).toBeGreaterThan(events.indexOf("art-1-failed"));
    expect(inventoryIndex).toBeGreaterThan(artVerifiedIndex);
    expect(glyphIndex).toBeGreaterThan(inventoryIndex);
    expect(starterIndex).toBeGreaterThan(glyphIndex);
    expect(artAttempts).toBe(2);
  });

  it("starts the area around the visitor again when the map release changes at the same location", async () => {
    const firstRelease = await makeRelease("1".repeat(64), 1, "municipal-nearby-release-park", "unused-nearby-scene-a");
    const secondRelease = await makeRelease("2".repeat(64), 1, "municipal-nearby-release-park", "unused-nearby-scene-b");
    const makeMapPointer = async (release: Awaited<ReturnType<typeof makeRelease>>) => {
      const mapFiles = release.rawManifest.files.filter((file) => file.path.startsWith("map/"));
      const inventory: ContentMapInventory = {
        schema: "parkdex.content-map/v1",
        version: release.channel.releaseId,
        mapManifest: release.rawManifest.mapManifest,
        files: mapFiles,
      };
      const bytes = toBytes(inventory);
      const pointer: ContentMapPointer = {
        version: release.channel.releaseId,
        manifestUrl: `https://kip-assets.parkdex.app/releases/${release.channel.releaseId}/map/manifest.json`,
        manifestSha256: await sha256Hex(bytes),
      };
      return { pointer, bytes, mapFiles, content: release.content };
    };
    const firstMap = await makeMapPointer(firstRelease);
    const secondMap = await makeMapPointer(secondRelease);
    const files = new Map<string, ArrayBuffer>([
      [firstMap.pointer.manifestUrl, firstMap.bytes],
      [secondMap.pointer.manifestUrl, secondMap.bytes],
    ]);
    for (const entry of [firstMap, secondMap]) {
      for (const file of entry.mapFiles) files.set(file.url, entry.content.get(file.url)!.slice(0));
    }
    const park = { ...firstRelease.park, scene: null };
    const delta = {
      schema: "parkdex.content-sync/v1",
      fromRevision: 1,
      throughRevision: 2,
      headRevision: 2,
      hasMore: false,
      batches: [{
        revision: 2,
        changes: [{ entity: "map", op: "upsert", id: "default", value: secondMap.pointer }],
      }],
    };
    const deltas = new Map<number, unknown>();
    const server = contentSyncServer(
      { ...contentSyncSnapshot(1, park, []), map: firstMap.pointer },
      deltas,
      new Map(),
      files,
    );
    const runtime = track(createSyncRuntime(new MemoryContentStore(), server.fetcher, { connected: true, wifi: true }));
    const point: [number, number] = [-123.4, 48.4];
    runtime.setLocation(point);

    await runtime.start();
    const firstReleaseId = `sync-staging-1-${firstMap.pointer.version}`;
    // Without offline downloads the area around the visitor is the starter view at their position,
    // after the starter view at the map anchor.
    await vi.waitFor(() => expect(mapMock.calls.filter((call) => call.releaseId === firstReleaseId && call.detail === "starter")).toHaveLength(2));
    expect(mapMock.calls.some((call) => call.detail === "nearby" || call.detail === "surrounding")).toBe(false);

    deltas.set(1, delta);
    await runtime.retry();
    const nextReleaseId = `sync-staging-2-${secondMap.pointer.version}`;
    await vi.waitFor(() => expect(runtime.getStatus().snapshot?.releaseId).toBe(nextReleaseId));
    await vi.waitFor(() => expect(mapMock.calls.filter((call) => call.releaseId === nextReleaseId && call.detail === "starter")).toHaveLength(2));
    expect(mapMock.calls.some((call) => call.detail === "nearby" || call.detail === "surrounding")).toBe(false);
  });

  it("clears retained parks synchronously when the account claim projection changes", async () => {
    const release = await makeRelease("f".repeat(64), 1, "municipal-current-owner-park", "scene-current-owner");
    const retiredA = { ...release.park, id: "retired-owner-a", name: "Retired owner A", short: "owner-a", scene: "owner-a" };
    const retiredB = { ...release.park, id: "retired-owner-b", name: "Retired owner B", short: "owner-b", scene: "owner-b" };
    const assetA = await makeSceneAsset(release.channel.releaseId, "owner-a", "scene:owner-a");
    const assetB = await makeSceneAsset(release.channel.releaseId, "owner-b", "scene:owner-b");
    const cachedState = parseContentSnapshot(contentSyncSnapshot(4, { ...release.park, scene: null }, []));
    const store = new MemoryContentStore();
    store.sync.set("staging", {
      ...cachedState,
      sourceId: "staging|https://parkdex.example.test/api/content",
    });
    store.retained.set(retiredA.id, { park: retiredA, sceneFile: assetA.file });
    store.retained.set(retiredB.id, { park: retiredB, sceneFile: assetB.file });
    store.files.set(assetA.file.sha256, assetA.bytes.slice(0));
    store.files.set(assetB.file.sha256, assetB.bytes.slice(0));

    let claimedIds = [retiredA.id];
    let releaseOwnerBCheck!: () => void;
    let signalOwnerBCheckStarted!: () => void;
    const ownerBGate = new Promise<void>((resolve) => { releaseOwnerBCheck = resolve; });
    const ownerBCheckStarted = new Promise<void>((resolve) => { signalOwnerBCheckStarted = resolve; });
    const originalHasFile = store.hasFile.bind(store);
    store.hasFile = async (hash, size) => {
      if (hash === assetB.file.sha256) {
        signalOwnerBCheckStarted();
        await ownerBGate;
      }
      return originalHasFile(hash, size);
    };
    const fetcher = vi.fn(async () => new Response("unexpected network request", { status: 500 })) as typeof fetch;
    const runtime = track(createSyncRuntime(store, fetcher, {
      connected: false,
      wifi: false,
      contentDownloadAllowed: false,
    }, claimedIds));

    await runtime.start();
    await vi.waitFor(() => {
      expect(runtime.getStatus().snapshot?.parkById.has(retiredA.id)).toBe(true);
      expect(runtime.getStatus().snapshot?.retainedSceneUrls.has(retiredA.id)).toBe(true);
    });

    claimedIds.splice(0, claimedIds.length, retiredB.id);
    runtime.refreshClaimedParks();
    const switchedSnapshot = runtime.getStatus().snapshot!;
    expect(switchedSnapshot.parkById.has(retiredA.id)).toBe(false);
    expect(switchedSnapshot.retiredParks.some((park) => park.id === retiredA.id)).toBe(false);
    expect(switchedSnapshot.retainedSceneUrls.has(retiredA.id)).toBe(false);

    await ownerBCheckStarted;
    expect(runtime.getStatus().snapshot?.parkById.has(retiredB.id)).toBe(false);
    releaseOwnerBCheck();
    await vi.waitFor(() => {
      expect(runtime.getStatus().snapshot?.parkById.has(retiredB.id)).toBe(true);
      expect(runtime.getStatus().snapshot?.retainedSceneUrls.has(retiredB.id)).toBe(true);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not republish a previous owner's retired park when claims change during normal sync publication", async () => {
    const release = await makeRelease("1".repeat(64), 1, "municipal-owner-race-park", "scene-owner-race");
    const currentPark = { ...release.park, scene: null };
    const retiredA = { ...release.park, id: "retired-sync-owner-a", scene: "sync-owner-a" };
    const retiredB = { ...release.park, id: "retired-sync-owner-b", scene: "sync-owner-b" };
    const assetA = await makeSceneAsset(release.channel.releaseId, "sync-owner-a", "owner-a-art");
    const assetB = await makeSceneAsset(release.channel.releaseId, "sync-owner-b", "owner-b-art");
    const store = new MemoryContentStore();
    store.retained.set(retiredA.id, { park: retiredA, sceneFile: assetA.file });
    store.retained.set(retiredB.id, { park: retiredB, sceneFile: assetB.file });
    store.files.set(assetA.file.sha256, assetA.bytes.slice(0));
    store.files.set(assetB.file.sha256, assetB.bytes.slice(0));

    let releaseOldOwnerCheck!: () => void;
    let signalOldOwnerCheckStarted!: () => void;
    const oldOwnerGate = new Promise<void>((resolve) => { releaseOldOwnerCheck = resolve; });
    const oldOwnerCheckStarted = new Promise<void>((resolve) => { signalOldOwnerCheckStarted = resolve; });
    const originalHasFile = store.hasFile.bind(store);
    store.hasFile = async (hash, size) => {
      if (hash === assetA.file.sha256) {
        signalOldOwnerCheckStarted();
        await oldOwnerGate;
      }
      return originalHasFile(hash, size);
    };

    const claimedIds = [retiredA.id];
    const server = contentSyncServer(contentSyncSnapshot(8, currentPark, []));
    const runtime = track(createSyncRuntime(store, server.fetcher, {
      connected: true,
      wifi: false,
      contentDownloadAllowed: true,
    }, claimedIds));
    const start = runtime.start();

    await oldOwnerCheckStarted;
    claimedIds.splice(0, claimedIds.length, retiredB.id);
    runtime.refreshClaimedParks();
    releaseOldOwnerCheck();
    await start;

    expect(runtime.getStatus().snapshot?.parkById.has(retiredA.id)).toBe(false);
    expect(runtime.getStatus().snapshot?.retiredParks.some((park) => park.id === retiredA.id)).toBe(false);
    expect(runtime.getStatus().snapshot?.retainedSceneUrls.has(retiredA.id)).toBe(false);
    await vi.waitFor(() => expect(runtime.getStatus().snapshot?.parkById.has(retiredB.id)).toBe(true));
  });

  it("does not publish cached art hydration after a newer sync revision replaces the park", async () => {
    const release = await makeRelease("b".repeat(64), 1, "municipal-stale-cache-park", "scene-stale-cache");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-stale-cache.webp")!;
    const cachedState = parseContentSnapshot(contentSyncSnapshot(24, release.park, [sceneFile]));
    const sourceId = "staging|https://parkdex.example.test/api/content";
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...cachedState, sourceId });
    store.files.set(sceneFile.sha256, release.content.get(sceneFile.url)!.slice(0));

    let releaseArtCheck!: () => void;
    let artCheckStarted!: () => void;
    const artGate = new Promise<void>((resolve) => { releaseArtCheck = resolve; });
    const artStarted = new Promise<void>((resolve) => { artCheckStarted = resolve; });
    const originalHasFile = store.hasFile.bind(store);
    store.hasFile = async (hash, size) => {
      if (hash === sceneFile.sha256) {
        artCheckStarted();
        await artGate;
      }
      return originalHasFile(hash, size);
    };

    const nextPark = { ...release.park, scene: null };
    const delta = {
      schema: "parkdex.content-sync/v1",
      fromRevision: 24,
      throughRevision: 25,
      headRevision: 25,
      hasMore: false,
      batches: [{
        revision: 25,
        changes: [
          { entity: "park", op: "upsert", id: nextPark.id, value: nextPark },
          { entity: "asset", op: "delete", id: sceneFile.path },
        ],
      }],
    };
    const server = contentSyncServer(contentSyncSnapshot(25, nextPark, []), new Map([[24, delta]]));
    const runtime = track(createSyncRuntime(store, server.fetcher, {
      connected: true,
      wifi: false,
      contentDownloadAllowed: true,
    }));
    const start = runtime.start();

    await artStarted;
    expect(runtime.getStatus().snapshot).toBeNull();
    releaseArtCheck();
    await start;
    expect(runtime.getStatus().snapshot?.generation).toBe(25);
    expect(runtime.getStatus().snapshot?.parks[0]?.scene).toBeNull();
    expect(runtime.getStatus().snapshot?.assetUrls.has(sceneFile.path)).toBe(false);
  });

  it("keeps map release identity stable while a missing inventory is repaired", async () => {
    const release = await makeRelease("c".repeat(64), 1, "municipal-map-repair-park", "scene-map-repair");
    const mapFiles = release.rawManifest.files.filter((file) => file.path.startsWith("map/"));
    const inventory: ContentMapInventory = {
      schema: "parkdex.content-map/v1",
      version: release.channel.releaseId,
      mapManifest: release.rawManifest.mapManifest,
      files: mapFiles,
    };
    const inventoryBytes = toBytes(inventory);
    const pointer = {
      version: release.channel.releaseId,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${release.channel.releaseId}/map/manifest.json`,
      manifestSha256: await sha256Hex(inventoryBytes),
    };
    const state = parseContentSnapshot({
      ...contentSyncSnapshot(31, { ...release.park, scene: null }, []),
      map: pointer,
    });
    const sourceId = "staging|https://parkdex.example.test/api/content";
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...state, sourceId });
    const remoteFiles = new Map<string, ArrayBuffer>([[pointer.manifestUrl, inventoryBytes]]);
    for (const file of mapFiles) {
      const bytes = release.content.get(file.url);
      if (!bytes) throw new Error(`Map repair fixture is missing ${file.path}`);
      remoteFiles.set(file.url, bytes.slice(0));
    }
    const server = contentSyncServer(contentSyncSnapshot(31, { ...release.park, scene: null }, []), new Map(), new Map(), remoteFiles);
    let releaseInventoryRequest!: () => void;
    let inventoryRequestStarted!: () => void;
    const inventoryGate = new Promise<void>((resolve) => { releaseInventoryRequest = resolve; });
    const inventoryStarted = new Promise<void>((resolve) => { inventoryRequestStarted = resolve; });
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input) === pointer.manifestUrl) {
        inventoryRequestStarted();
        await inventoryGate;
      }
      return server.fetcher(input, init);
    };
    const runtime = track(createSyncRuntime(store, fetcher, {
      connected: true,
      wifi: false,
      contentDownloadAllowed: true,
    }));
    const start = runtime.start();

    await inventoryStarted;
    expect(runtime.getStatus().snapshot?.releaseId).toBe(`sync-staging-31-${release.channel.releaseId}`);
    expect(runtime.getStatus().snapshot?.manifest.mapManifest).toEqual({ size: 1, chunkBytes: 1, count: 1 });
    releaseInventoryRequest();
    await start;
    await vi.waitFor(() => expect(runtime.getStatus().snapshot?.releaseId).toBe(`sync-staging-31-${release.channel.releaseId}`));
    await vi.waitFor(() => expect(runtime.getStatus().mapDetailReady).toBe(true));
    // Starter coverage downloads on mobile data; the rest of the archive is never fetched automatically.
    await vi.waitFor(() => expect(mapMock.calls).toContainEqual({ releaseId: runtime.getStatus().snapshot!.releaseId, detail: "starter" }));
    await vi.waitFor(() => expect(getAllowedMapChunks(runtime.getStatus().snapshot!.releaseId)).toEqual([0]));
    expect(runtime.getStatus().waitingForWifi).toBe(false);
    expect(runtime.getStatus().snapshot?.manifest.mapManifest).toEqual(release.rawManifest.mapManifest);
    expect(runtime.getStatus().fullMapReady).toBe(false);
  });

  it("syncs content over an online browser connection without a physical Wi-Fi signal", async () => {
    const release = await makeRelease("a".repeat(64), 1, "municipal-browser-park", "scene-browser");
    const snapshot = contentSyncSnapshot(7, { ...release.park, scene: null }, []);
    const server = contentSyncServer(snapshot);
    const runtime = track(createSyncRuntime(new MemoryContentStore(), server.fetcher, {
      connected: true,
      wifi: false,
      contentDownloadAllowed: true,
    }));

    await runtime.start();

    expect(runtime.getStatus().snapshot?.parks.map((park) => park.id)).toEqual(["municipal-browser-park"]);
    expect(runtime.getStatus().waitingForWifi).toBe(false);
    expect(server.calls.filter((url) => new URL(url).pathname.endsWith("/snapshot"))).toHaveLength(1);
  });

  it("shows offline during a first sync interruption and resumes when an online browser returns", async () => {
    const release = await makeRelease("9".repeat(64), 1, "municipal-resume-park", "scene-resume");
    const snapshot = contentSyncSnapshot(7, { ...release.park, scene: null }, []);
    const server = contentSyncServer(snapshot);
    let blockFirstSnapshot = true;
    let resolveFirstSnapshot!: () => void;
    const firstSnapshotStarted = new Promise<void>((resolve) => { resolveFirstSnapshot = resolve; });
    let snapshotRequests = 0;
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/snapshot")) {
        snapshotRequests += 1;
        if (blockFirstSnapshot) {
          blockFirstSnapshot = false;
          resolveFirstSnapshot();
          return new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) {
              reject(init.signal.reason);
              return;
            }
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        }
      }
      return server.fetcher(input, init);
    };
    const runtime = track(createSyncRuntime(new MemoryContentStore(), fetcher, {
      connected: true,
      wifi: false,
      contentDownloadAllowed: true,
    }));
    const firstStart = runtime.start();

    await firstSnapshotStarted;
    expect(runtime.getStatus().phase).toBe("downloading");
    runtime.setConnectivity({ connected: false, wifi: false, contentDownloadAllowed: false });
    expect(runtime.getStatus().phase).toBe("offline");
    expect(runtime.getStatus().waitingForWifi).toBe(false);
    await firstStart;

    runtime.setConnectivity({ connected: true, wifi: false, contentDownloadAllowed: true });
    await vi.waitFor(() => expect(runtime.getStatus().snapshot?.parks[0]?.id).toBe("municipal-resume-park"));
    expect(snapshotRequests).toBe(2);
    expect(runtime.getStatus().waitingForWifi).toBe(false);
  });

  it("shows no error while a permission dialog pauses the first sync and finishes it on resume", async () => {
    const release = await makeRelease("8".repeat(64), 1, "municipal-dialog-park", "scene-dialog");
    const snapshot = contentSyncSnapshot(7, { ...release.park, scene: null }, []);
    const server = contentSyncServer(snapshot);
    let transportPaused = true;
    let snapshotRequests = 0;
    // The vc14 plugin rejects in-flight and new requests while the Activity is paused.
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/snapshot")) snapshotRequests += 1;
      if (transportPaused) throw contentTransportPausedError();
      return server.fetcher(input, init);
    };
    const runtime = track(createSyncRuntime(new MemoryContentStore(), fetcher, {
      connected: true,
      wifi: true,
      contentDownloadAllowed: true,
    }));

    await runtime.start();

    expect(snapshotRequests).toBe(1);
    expect(runtime.getStatus().error).toBeNull();
    expect(runtime.getStatus().phase).toBe("downloading");
    expect(contentGateView(runtime.getStatus())).toMatchObject({ showError: false, showRetry: false, title: "Getting Parkdex ready…" });

    transportPaused = false;
    runtime.resumeAfterPause?.();
    // Resume restarts at once instead of waiting for the one-second fallback retry.
    await vi.waitFor(() => expect(runtime.getStatus().snapshot?.parks[0]?.id).toBe("municipal-dialog-park"), { timeout: 600 });
    expect(snapshotRequests).toBe(2);
    expect(runtime.getStatus().error).toBeNull();
    expect(runtime.getStatus().phase).toBe("ready");
  });

  it("retries a paused first sync on its own when no resume event arrives", async () => {
    const release = await makeRelease("7".repeat(64), 1, "municipal-backoff-park", "scene-backoff");
    const snapshot = contentSyncSnapshot(7, { ...release.park, scene: null }, []);
    const server = contentSyncServer(snapshot);
    let pausedRequests = 1;
    const fetcher: typeof fetch = async (input, init) => {
      if (pausedRequests > 0) {
        pausedRequests -= 1;
        throw contentTransportPausedError();
      }
      return server.fetcher(input, init);
    };
    const runtime = track(createSyncRuntime(new MemoryContentStore(), fetcher, {
      connected: true,
      wifi: true,
      contentDownloadAllowed: true,
    }));

    await runtime.start();
    expect(runtime.getStatus().error).toBeNull();

    await vi.waitFor(() => expect(runtime.getStatus().snapshot?.parks[0]?.id).toBe("municipal-backoff-park"), { timeout: 3000 });
    expect(runtime.getStatus().error).toBeNull();
  });

  it("ignores resume when nothing was interrupted", async () => {
    const release = await makeRelease("6".repeat(64), 1, "municipal-quiet-park", "scene-quiet");
    const snapshot = contentSyncSnapshot(7, { ...release.park, scene: null }, []);
    const server = contentSyncServer(snapshot);
    const runtime = track(createSyncRuntime(new MemoryContentStore(), server.fetcher, {
      connected: true,
      wifi: true,
      contentDownloadAllowed: true,
    }));
    await runtime.start();
    const requests = server.calls.length;

    runtime.resumeAfterPause?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.calls.length).toBe(requests);
  });

  it("still reports a real sync failure as an error", async () => {
    const runtime = track(createSyncRuntime(new MemoryContentStore(), async () => {
      throw new Error("Content snapshot returned HTTP 500");
    }, { connected: true, wifi: true, contentDownloadAllowed: true }));

    await runtime.start();

    expect(runtime.getStatus().error).toBe("Content snapshot returned HTTP 500");
    expect(contentGateView(runtime.getStatus())).toMatchObject({ showError: true, showRetry: true, title: "Park guides couldn’t be loaded." });
  });

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

    runtime.setConnectivity({ connected: true, wifi: false, contentDownloadAllowed: true });
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

  it("archives the claimed scene that was actually replaced by a multi-page update", async () => {
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
    expect(await store.getArchivedScene("e".repeat(64), "scene-a")).toBeUndefined();
    expect(await store.hasFile(oldAsset.file.sha256, oldAsset.file.byte_size)).toBe(false);
    expect(await store.hasFile(middleAsset.file.sha256, middleAsset.file.byte_size)).toBe(false);
    expect(server.calls).not.toContain(oldAsset.file.url);
    expect(server.calls).not.toContain(middleAsset.file.url);
    expect(runtime.getSceneAssetVersion(park.id, "scene-a")).toBe("f".repeat(64));
  });

  it("keeps the visible snapshot and saved cursor unchanged until every changes page and final badge art are ready", async () => {
    const oldRelease = await makeRelease("6".repeat(64), 1, "municipal-atomic-park", "scene-before-sync");
    const oldAsset = oldRelease.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-before-sync.webp")!;
    const finalPark = { ...oldRelease.park, scene: "scene-after-sync" };
    const finalAsset = await makeSceneAsset("7".repeat(64), finalPark.scene, "fully synced badge bytes");
    const initial = contentSyncSnapshot(1, oldRelease.park, [oldAsset]);
    const firstBatch: ContentChangeBatch = {
      revision: 2,
      changes: [
        { entity: "park", op: "upsert", id: finalPark.id, value: finalPark },
        { entity: "asset", op: "delete", id: oldAsset.path },
        { entity: "asset", op: "upsert", id: finalAsset.file.path, value: finalAsset.file },
      ],
    };
    const secondBatch: ContentChangeBatch = {
      revision: 3,
      changes: [{ entity: "park", op: "upsert", id: finalPark.id, value: finalPark }],
    };
    const deltas = new Map<number, unknown>([
      [1, { schema: "parkdex.content-sync/v1", fromRevision: 1, throughRevision: 2, headRevision: 3, hasMore: true, batches: [firstBatch] }],
      [2, { schema: "parkdex.content-sync/v1", fromRevision: 2, throughRevision: 3, headRevision: 3, hasMore: false, batches: [secondBatch] }],
    ]);
    const server = contentSyncServer(initial, deltas, new Map(), new Map([[finalAsset.file.url, finalAsset.bytes]]));
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...parseContentSnapshot(initial), sourceId: "staging|https://parkdex.example.test/api/content" });
    store.files.set(oldAsset.sha256, oldRelease.content.get(oldAsset.url)!.slice(0));
    let signalAssetStarted!: () => void;
    let releaseAsset!: () => void;
    const assetStarted = new Promise<void>((resolve) => { signalAssetStarted = resolve; });
    const assetGate = new Promise<void>((resolve) => { releaseAsset = resolve; });
    const fetcher: typeof fetch = (input, init) => {
      if (String(input) === finalAsset.file.url) {
        signalAssetStarted();
        return new Promise<Response>((resolve, reject) => {
          void assetGate.then(() => resolve(new Response(finalAsset.bytes.slice(0))));
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return server.fetcher(input, init);
    };
    const runtime = track(createSyncRuntime(store, fetcher, { connected: true, wifi: false }, [oldRelease.park.id]));
    const start = runtime.start();

    await assetStarted;
    expect(runtime.getStatus().snapshot?.generation).toBe(1);
    expect(runtime.getStatus().snapshot?.assetUrls.get(oldAsset.path)).toBe(`content-store://${oldAsset.sha256}`);
    expect((await store.getSyncCursor("staging"))?.revision).toBe(1);
    expect((await store.getSyncState("staging"))?.parks[0]?.scene).toBe("scene-before-sync");
    expect(server.calls.filter((url) => new URL(url).pathname.endsWith("/changes")).map((url) => new URL(url).searchParams.get("after"))).toEqual(["1", "2"]);

    releaseAsset();
    await start;

    expect((await store.getSyncCursor("staging"))?.revision).toBe(3);
    expect(runtime.getStatus().snapshot?.generation).toBe(3);
    expect(runtime.getStatus().snapshot?.assetUrls.get(finalAsset.file.path)).toBe(`content-store://${finalAsset.file.sha256}`);
  });

  it("does not let missing historical claimed art block a healthy update and keeps its recovery descriptors", async () => {
    const oldRelease = await makeRelease("8".repeat(64), 1, "municipal-claimed-recovery-park", "scene-old-claimed");
    const oldAsset = oldRelease.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-old-claimed.webp")!;
    const currentPark = { ...oldRelease.park, scene: "scene-new-claimed" };
    const currentAsset = await makeSceneAsset("9".repeat(64), currentPark.scene, "current claimed badge art");
    const initial = contentSyncSnapshot(1, oldRelease.park, [oldAsset]);
    const batch: ContentChangeBatch = {
      revision: 2,
      changes: [
        { entity: "park", op: "upsert", id: currentPark.id, value: currentPark },
        { entity: "asset", op: "delete", id: oldAsset.path },
        { entity: "asset", op: "upsert", id: currentAsset.file.path, value: currentAsset.file },
      ],
    };
    const deltas = new Map<number, unknown>([[1, {
      schema: "parkdex.content-sync/v1",
      fromRevision: 1,
      throughRevision: 2,
      headRevision: 2,
      hasMore: false,
      batches: [batch],
    }]]);
    const server = contentSyncServer(initial, deltas, new Map(), new Map([[currentAsset.file.url, currentAsset.bytes]]));
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...parseContentSnapshot(initial), sourceId: "staging|https://parkdex.example.test/api/content" });
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: false }, [currentPark.id]));

    await runtime.start();

    expect(runtime.getStatus().snapshot?.parks[0]?.scene).toBe("scene-new-claimed");
    expect(runtime.getStatus().snapshot?.assetUrls.get(currentAsset.file.path)).toBe(`content-store://${currentAsset.file.sha256}`);
    expect((await store.getArchivedScene(oldRelease.channel.releaseId, "scene-old-claimed"))?.file).toEqual(oldAsset);
    expect((await store.getRetainedParks()).find((entry) => entry.park.id === currentPark.id)?.sceneFile).toEqual(oldAsset);
    expect(server.calls).not.toContain(oldAsset.url);
  });

  it("invalidates a same-session cached file marker when URL hydration fails and repairs the art online", async () => {
    const release = await makeRelease("b".repeat(64), 1, "municipal-file-url-repair-park", "scene-file-url-repair");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-file-url-repair.webp")!;
    const snapshot = contentSyncSnapshot(9, release.park, [sceneFile]);
    const server = contentSyncServer(snapshot, new Map(), new Map(), new Map([[sceneFile.url, release.content.get(sceneFile.url)!]]));
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...parseContentSnapshot(snapshot), sourceId: "staging|https://parkdex.example.test/api/content" });
    store.files.set(sceneFile.sha256, release.content.get(sceneFile.url)!.slice(0));
    const originalFileUrl = store.fileUrl.bind(store);
    let failUrlOnce = true;
    store.fileUrl = async (hash) => {
      if (hash === sceneFile.sha256 && failUrlOnce) {
        failUrlOnce = false;
        store.files.delete(sceneFile.sha256);
        throw new Error("Cached badge URL could not be hydrated");
      }
      return originalFileUrl(hash);
    };
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: false }, [release.park.id]));

    await runtime.start();

    expect(runtime.getStatus().snapshot?.parks[0]?.id).toBe(release.park.id);
    expect(runtime.getStatus().snapshot?.assetUrls.get(sceneFile.path)).toBe(`content-store://${sceneFile.sha256}`);
    expect(await store.hasFile(sceneFile.sha256, sceneFile.byte_size)).toBe(true);
    expect(server.calls).toContain(sceneFile.url);
  });

  it("does not overwrite a concurrent cursor advance with a stale completed snapshot", async () => {
    const release = await makeRelease("a".repeat(64), 1, "municipal-cursor-race-park", "scene-cursor-race");
    const sceneAsset = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-cursor-race.webp")!;
    const initial = contentSyncSnapshot(1, release.park, [sceneAsset]);
    const server = contentSyncServer(initial);
    const store = new MemoryContentStore();
    store.sync.set("staging", { ...parseContentSnapshot(initial), sourceId: "staging|https://parkdex.example.test/api/content" });
    store.files.set(sceneAsset.sha256, release.content.get(sceneAsset.url)!.slice(0));
    const replace = store.replaceSyncState.bind(store);
    let raced = false;
    store.replaceSyncState = async (...args) => {
      if (!raced) {
        raced = true;
        const current = store.sync.get("staging")!;
        store.sync.set("staging", { ...current, revision: 2 });
      }
      await replace(...args);
    };
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: true }));

    await runtime.start();

    expect((await store.getSyncCursor("staging"))?.revision).toBe(2);
    expect(runtime.getStatus().snapshot?.generation).toBe(1);
    expect(runtime.getStatus()).toMatchObject({ syncStage: "error", phase: "ready" });
  });

  it("shows far, unclaimed badges from the CDN without downloading their art", async () => {
    const release = await makeRelease("c".repeat(64), 1, "municipal-far-art-park", "scene-far-art");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-far-art.webp")!;
    const server = contentSyncServer(contentSyncSnapshot(5, release.park, [sceneFile]), new Map(), new Map(), new Map([[sceneFile.url, release.content.get(sceneFile.url)!]]));
    const requested: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requested.push(String(input));
      return server.fetcher(input, init);
    };
    const runtime = track(createSyncRuntime(new MemoryContentStore(), fetcher, { connected: true, wifi: true }));
    // Nanaimo, about 95 km from the park.
    runtime.setLocation([-123.94, 49.17]);

    await runtime.start();

    const snapshot = runtime.getStatus().snapshot!;
    expect(snapshot.parks[0]?.id).toBe(release.park.id);
    expect(snapshot.assetUrls.has(sceneFile.path)).toBe(false);
    expect(snapshot.remoteSceneUrls?.get(sceneFile.path)).toBe(sceneFile.url);
    expect(requested).not.toContain(sceneFile.url);
  });

  it("downloads art for parks near the visitor and switches their badges to the saved copy", async () => {
    const release = await makeRelease("d".repeat(64), 1, "municipal-near-art-park", "scene-near-art");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-near-art.webp")!;
    const server = contentSyncServer(contentSyncSnapshot(5, release.park, [sceneFile]), new Map(), new Map(), new Map([[sceneFile.url, release.content.get(sceneFile.url)!]]));
    const runtime = track(createSyncRuntime(new MemoryContentStore(), server.fetcher, { connected: true, wifi: true }));
    await runtime.start();
    expect(runtime.getStatus().snapshot?.assetUrls.has(sceneFile.path)).toBe(false);

    runtime.setLocation([release.park.lng + 0.01, release.park.lat]);

    await vi.waitFor(() => expect(runtime.getStatus().snapshot?.assetUrls.get(sceneFile.path)).toBe(`content-store://${sceneFile.sha256}`));
  });

  async function catalogueRelease(revision: number, parks: TestSyncPark[]) {
    const json = (value: unknown) => toBytes(JSON.stringify(value));
    const features = parks.map((park, index) => ({
      type: "Feature",
      properties: { id: park.id, biome: park.biome },
      geometry: { type: "MultiPolygon", coordinates: [[[[index, 0], [index + 1, 0], [index + 1, 1], [index, 0]]]] },
    }));
    const chunkBytes = [json({ schema: "parkdex.content-boundaries/v1", features: features.slice(0, 1) }), json({ schema: "parkdex.content-boundaries/v1", features: features.slice(1) })];
    const boundaryChunks = await Promise.all(chunkBytes.map(async (bytes, index) => ({
      path: `catalogue/boundaries/00${index}.json`, sha256: await sha256Hex(bytes), byte_size: bytes.byteLength,
      parkIds: (index === 0 ? parks.slice(0, 1) : parks.slice(1)).map((park) => park.id), bbox: [0, 0, 1, 1],
    })));
    const indexBytes = json({
      schema: "parkdex.content-catalogue/v1", revision, parks,
      drive: { hubs: [{ name: "Victoria", lng: -123.3, lat: 48.4 }], parks: Object.fromEntries(parks.map((park) => [park.id, { drive: [null], walkM: 0 }])) },
      assets: [], map: null, boundaryChunks,
    });
    const version = await sha256Hex(indexBytes);
    const base = `https://kip-assets.parkdex.app/releases/${version}/`;
    const files = new Map<string, ArrayBuffer>([[`${base}catalogue/index.json`, indexBytes]]);
    boundaryChunks.forEach((chunk, index) => files.set(`${base}${chunk.path}`, chunkBytes[index]!));
    const pointer = {
      schema: "parkdex.content-sync/v1", revision,
      catalogue: { schema: "parkdex.content-catalogue/v1", version, indexUrl: `${base}catalogue/index.json`, indexSha256: version, indexBytes: indexBytes.byteLength, parkCount: parks.length },
    };
    return { pointer, files, base, boundaryChunks };
  }

  it("loads the whole catalogue from a CDN release when the snapshot API names one, then applies later changes", async () => {
    const first = await makeRelease("a".repeat(64), 1, "municipal-cdn-one", "scene-cdn-one");
    const parks: TestSyncPark[] = [{ ...first.park, scene: null }, { ...first.park, id: "provincial-cdn-two", name: "Two", short: "Two", scene: null }];
    const { pointer, files } = await catalogueRelease(7, parks);
    const renamed = { ...parks[1]!, name: "Two renamed" };
    const deltas = new Map<number, unknown>([[7, {
      schema: "parkdex.content-sync/v1", fromRevision: 7, throughRevision: 8, headRevision: 8, hasMore: false,
      batches: [{ revision: 8, changes: [{ entity: "park", op: "upsert", id: renamed.id, value: renamed }] }],
    }]]);
    const server = contentSyncServer(pointer as unknown as ReturnType<typeof contentSyncSnapshot>, deltas, new Map(), files);
    const runtime = track(createSyncRuntime(new MemoryContentStore(), server.fetcher, { connected: true, wifi: false }));
    await runtime.start();

    const snapshot = runtime.getStatus().snapshot;
    expect(runtime.getStatus().error).toBeNull();
    expect(snapshot?.parks.map((park) => park.id)).toEqual(["municipal-cdn-one", "provincial-cdn-two"]);
    expect(snapshot?.parkById.get("provincial-cdn-two")?.name).toBe("Two renamed");
    expect(snapshot?.boundaries.features).toHaveLength(2);
    expect(server.calls.filter((url) => url.includes("/catalogue/"))).toHaveLength(3);
  });

  it("does not commit a CDN catalogue whose chunk fails its hash", async () => {
    const first = await makeRelease("b".repeat(64), 1, "municipal-cdn-bad", "scene-cdn-bad");
    const parks: TestSyncPark[] = [{ ...first.park, scene: null }, { ...first.park, id: "provincial-cdn-bad-two", scene: null }];
    const { pointer, files, base, boundaryChunks } = await catalogueRelease(3, parks);
    files.set(`${base}${boundaryChunks[1]!.path}`, toBytes("tampered"));
    const store = new MemoryContentStore();
    const server = contentSyncServer(pointer as unknown as ReturnType<typeof contentSyncSnapshot>, new Map(), new Map(), files);
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: true }));
    await runtime.start();

    expect(runtime.getStatus().snapshot).toBeNull();
    expect(runtime.getStatus().error).toMatch(/byte length|SHA-256/);
    await expect(store.getSyncState("staging")).resolves.toBeNull();
  });

  it("fetches no badge art near the visitor or for claims when the build does not show it", async () => {
    const release = await makeRelease("f".repeat(64), 1, "municipal-hidden-art-park", "scene-hidden-art");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-hidden-art.webp")!;
    const server = contentSyncServer(contentSyncSnapshot(5, release.park, [sceneFile]), new Map(), new Map(), new Map([[sceneFile.url, release.content.get(sceneFile.url)!]]));
    const runtime = track(createContentRuntime({
      store: new MemoryContentStore(),
      fetch: server.fetcher,
      apiUrl: "https://parkdex.example.test/api/content/current",
      environment: "staging",
      claimedParkIds: () => [release.park.id],
      connectivity: { connected: true, wifi: true },
      badgeArt: false,
    }));
    await runtime.start();
    runtime.setLocation([release.park.lng + 0.01, release.park.lat]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(runtime.getStatus().snapshot?.parks.map((park) => park.id)).toEqual([release.park.id]);
    expect(runtime.getStatus().snapshot?.assetUrls.has(sceneFile.path)).toBe(false);
    expect(server.calls).not.toContain(sceneFile.url);
  });

  it("saves one park's art on request for a claim", async () => {
    const release = await makeRelease("e".repeat(64), 1, "municipal-claim-art-park", "scene-claim-art");
    const sceneFile = release.rawManifest.files.find((file) => file.path === "art/badges/scenes/scene-claim-art.webp")!;
    const server = contentSyncServer(contentSyncSnapshot(5, release.park, [sceneFile]), new Map(), new Map(), new Map([[sceneFile.url, release.content.get(sceneFile.url)!]]));
    const runtime = track(createSyncRuntime(new MemoryContentStore(), server.fetcher, { connected: true, wifi: true }));
    await runtime.start();

    await runtime.ensureParkArt?.(release.park.id);

    expect(runtime.getStatus().snapshot?.assetUrls.get(sceneFile.path)).toBe(`content-store://${sceneFile.sha256}`);
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

describe("lean device cache", () => {
  const SOURCE = "staging|https://parkdex.example.test/api/content";
  const HALIFAX_PARK = { lng: -63.57, lat: 44.65 };

  async function leanRelease(revision: number, parks: TestSyncPark[]) {
    const json = (value: unknown) => toBytes(JSON.stringify(value));
    const chunkBytes = parks.map((park) => json({ schema: "parkdex.content-boundaries/v1", features: [{
      type: "Feature",
      properties: { id: park.id, biome: park.biome },
      geometry: { type: "MultiPolygon", coordinates: [[[[park.lng, park.lat], [park.lng + 0.01, park.lat], [park.lng + 0.01, park.lat + 0.01], [park.lng, park.lat]]]] },
    }] }));
    const boundaryChunks = await Promise.all(chunkBytes.map(async (bytes, index) => ({
      path: `catalogue/boundaries/00${index}.json`, sha256: await sha256Hex(bytes), byte_size: bytes.byteLength,
      parkIds: [parks[index]!.id], bbox: [parks[index]!.lng, parks[index]!.lat, parks[index]!.lng + 0.01, parks[index]!.lat + 0.01],
    })));
    const indexBytes = json({
      schema: "parkdex.content-catalogue/v1", revision, parks,
      drive: { hubs: [{ name: "Victoria", lng: -123.3, lat: 48.4 }], parks: Object.fromEntries(parks.map((park) => [park.id, { drive: [null], walkM: 0 }])) },
      assets: [], map: null, boundaryChunks,
    });
    const version = await sha256Hex(indexBytes);
    const base = `https://kip-assets.parkdex.app/releases/${version}/`;
    const files = new Map<string, ArrayBuffer>([[`${base}catalogue/index.json`, indexBytes]]);
    boundaryChunks.forEach((chunk, index) => files.set(`${base}${chunk.path}`, chunkBytes[index]!));
    const pointer = {
      schema: "parkdex.content-sync/v1", revision,
      catalogue: { schema: "parkdex.content-catalogue/v1", version, indexUrl: `${base}catalogue/index.json`, indexSha256: version, indexBytes: indexBytes.byteLength, parkCount: parks.length },
    };
    return { pointer: pointer as unknown as ReturnType<typeof contentSyncSnapshot>, files };
  }

  async function twoParks() {
    const release = await makeRelease("a".repeat(64), 1, "municipal-lean-near", "scene-lean-near");
    const near: TestSyncPark = { ...release.park, scene: null };
    // The fixture types its coordinates as Victoria's literals; this park is in Halifax.
    const far = { ...release.park, id: "provincial-lean-far", name: "Far", short: "Far", ...HALIFAX_PARK, scene: null } as unknown as TestSyncPark;
    return { near, far };
  }

  function memoryMarker(initial: string | null = null) {
    const marker = { value: initial, read: () => marker.value, write: (next: string) => { marker.value = next; } };
    return marker;
  }
  const boundaryIds = (runtime: ContentRuntime) => runtime.getStatus().snapshot?.boundaries.features.map((feature) => feature.properties.id);
  const chunkCalls = (calls: string[]) => calls.filter((url) => url.includes("/catalogue/boundaries/"));

  it("keeps only the boundaries near the visitor and loads others when the map shows them", async () => {
    const { near, far } = await twoParks();
    const { pointer, files } = await leanRelease(7, [near, far]);
    const server = contentSyncServer(pointer, new Map(), new Map(), files);
    const store = new MemoryContentStore();
    const runtime = track(createSyncRuntime(store, server.fetcher, { connected: true, wifi: true }));
    runtime.setLocation([near.lng, near.lat]);
    await runtime.start();

    expect(runtime.getStatus().snapshot?.parks.map((park) => park.id)).toEqual([near.id, far.id]);
    expect(boundaryIds(runtime)).toEqual([near.id]);
    expect(chunkCalls(server.calls)).toHaveLength(1);
    expect((await store.getSyncState("staging"))?.catalogue?.loaded).toEqual(["catalogue/boundaries/000.json"]);

    // A zoomed-out view shows parks as dots and loads nothing.
    runtime.loadBoundariesInView?.([-64, 44, -63, 45], 5);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(chunkCalls(server.calls)).toHaveLength(1);

    runtime.loadBoundariesInView?.([-64, 44, -63, 45], 11);
    await vi.waitFor(() => expect(boundaryIds(runtime)).toEqual([near.id, far.id]));
    const stored = await store.getSyncState("staging");
    expect(stored?.catalogue?.loaded).toEqual(["catalogue/boundaries/000.json", "catalogue/boundaries/001.json"]);
    expect(stored?.boundaries.features).toHaveLength(2);
  });

  it("loads a far park's boundary when the player opens it", async () => {
    const { near, far } = await twoParks();
    const { pointer, files } = await leanRelease(7, [near, far]);
    const server = contentSyncServer(pointer, new Map(), new Map(), files);
    const runtime = track(createSyncRuntime(new MemoryContentStore(), server.fetcher, { connected: true, wifi: true }));
    runtime.setLocation([near.lng, near.lat]);
    await runtime.start();

    await runtime.loadParkBoundary?.(far.id);
    expect(boundaryIds(runtime)).toEqual([near.id, far.id]);
    // Already on the device: nothing more downloads.
    await runtime.loadParkBoundary?.(far.id);
    expect(chunkCalls(server.calls)).toHaveLength(2);
  });

  it("replaces a catalogue saved whole with a lean one after an update, then cleans up old content once", async () => {
    const { near, far } = await twoParks();
    const { pointer, files } = await leanRelease(7, [near, far]);
    const server = contentSyncServer(pointer, new Map(), new Map(), files);
    const store = new MemoryContentStore();
    // A catalogue saved whole by an earlier build, with badge art it downloaded.
    const oldArt = await makeSceneAsset("b".repeat(64), "old-far-art", "scene:old-far-art");
    const whole = parseContentSnapshot(contentSyncSnapshot(5, { ...far, scene: "old-far-art" }, [oldArt.file]));
    store.sync.set("staging", { ...whole, sourceId: SOURCE });
    store.files.set(oldArt.file.sha256, oldArt.bytes.slice(0));
    // A retired claimed badge keeps its art.
    const retainedArt = await makeSceneAsset("c".repeat(64), "claimed-art", "scene:claimed-art");
    store.retained.set("municipal-retired", { park: { ...near, id: "municipal-retired", scene: "claimed-art" }, sceneFile: retainedArt.file });
    store.files.set(retainedArt.file.sha256, retainedArt.bytes.slice(0));
    // The release of the first content format, still active, and an older map with a saved chunk.
    const legacy = await makeRelease("d".repeat(64), 1, "municipal-legacy", "legacy-scene");
    store.releases.set(legacy.channel.releaseId, { id: legacy.channel.releaseId, channel: legacy.channel, manifest: legacy.rawManifest, readiness: "complete", healthy: true });
    store.activeId = legacy.channel.releaseId;
    const oldChunk = legacy.rawManifest.files.find((file) => file.path === "map/island/001.bin")!;
    store.files.set(oldChunk.sha256, legacy.content.get(oldChunk.url)!.slice(0));
    store.inventories.set("e".repeat(64), {
      schema: "parkdex.content-map/v1", version: "e".repeat(64), mapManifest: legacy.rawManifest.mapManifest,
      files: legacy.rawManifest.files.filter((file) => file.path.startsWith("map/")),
    });
    const values = new Map([["parkdex-map-squares-v1", JSON.stringify({ version: "f".repeat(64), keys: ["80/177"] })]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    });
    const marker = memoryMarker("v1|build-1|none");
    const options = {
      store, fetch: server.fetcher, apiUrl: "https://parkdex.example.test/api/content/current", environment: "staging" as const,
      claimedParkIds: () => ["municipal-retired"], connectivity: { connected: true, wifi: true }, badgeArt: false,
      appBuild: "build-2", cacheMarker: marker,
    };
    try {
      const runtime = track(createContentRuntime(options));
      runtime.setLocation([near.lng, near.lat]);
      await runtime.start();

      await vi.waitFor(() => expect(marker.value).toBe("v1|build-2|none"));
      const stored = await store.getSyncState("staging");
      expect(stored?.catalogue?.loaded).toEqual(["catalogue/boundaries/000.json"]);
      expect(stored?.boundaries.features.map((feature) => feature.properties.id)).toEqual([near.id]);
      expect(store.files.has(oldArt.file.sha256)).toBe(false);
      expect(store.files.has(oldChunk.sha256)).toBe(false);
      expect(store.files.has(retainedArt.file.sha256)).toBe(true);
      expect(store.retained.has("municipal-retired")).toBe(true);
      expect(store.releases.size).toBe(0);
      expect(store.activeId).toBeNull();
      expect(store.inventories.size).toBe(0);
      expect(values.has("parkdex-map-squares-v1")).toBe(false);
      await runtime.stop();

      // The same build starting again neither refetches the catalogue nor cleans up again.
      const snapshots = server.calls.filter((url) => url.includes("/api/content/snapshot")).length;
      const deleted = store.deletedFiles.length;
      const again = track(createContentRuntime(options));
      await again.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.calls.filter((url) => url.includes("/api/content/snapshot"))).toHaveLength(snapshots);
      expect(store.deletedFiles).toHaveLength(deleted);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("runs an interrupted cleanup again on the next start", async () => {
    const { near, far } = await twoParks();
    const { pointer, files } = await leanRelease(7, [near, far]);
    const server = contentSyncServer(pointer, new Map(), new Map(), files);
    const store = new MemoryContentStore();
    for (const scene of ["stale-one", "stale-two"]) {
      const art = await makeSceneAsset("b".repeat(64), scene, `scene:${scene}`);
      store.files.set(art.file.sha256, art.bytes.slice(0));
    }
    const marker = memoryMarker();
    const options = {
      store, fetch: server.fetcher, apiUrl: "https://parkdex.example.test/api/content/current", environment: "staging" as const,
      claimedParkIds: () => [], connectivity: { connected: true, wifi: true }, badgeArt: false, appBuild: "build-3", cacheMarker: marker,
    };
    const first = track(createContentRuntime(options));
    const deleteFile = store.deleteFile.bind(store);
    let stopping: Promise<void> | null = null;
    store.deleteFile = async (hash: string) => {
      await deleteFile(hash);
      // The app closes right after the first file is deleted.
      stopping ??= first.stop();
    };
    await first.start();
    await vi.waitFor(() => expect(stopping).not.toBeNull());
    await stopping;
    expect(store.files.size).toBe(1);
    expect(marker.value).toBeNull();

    store.deleteFile = deleteFile;
    const second = track(createContentRuntime(options));
    await second.start();
    await vi.waitFor(() => expect(marker.value).toBe("v1|build-3|none"));
    expect(store.files.size).toBe(0);
  });

  it("trims a catalogue saved whole and cleans up old content without a sync, then replaces it on the next sync", async () => {
    const { near, far } = await twoParks();
    const { pointer, files } = await leanRelease(7, [near, far]);
    const server = contentSyncServer(pointer, new Map(), new Map(), files);
    const store = new MemoryContentStore();
    // Saved whole by an earlier build: both boundaries, an older map's inventory and its labels.
    const whole = parseContentSnapshot({
      ...contentSyncSnapshot(7, near, []),
      parks: [near, far],
      boundaries: { type: "FeatureCollection", features: [near, far].map((park) => ({
        type: "Feature", properties: { id: park.id, biome: park.biome },
        geometry: { type: "MultiPolygon", coordinates: [[[[park.lng, park.lat], [park.lng + 0.01, park.lat], [park.lng + 0.01, park.lat + 0.01], [park.lng, park.lat]]]] },
      })) },
      drive: { hubs: [{ name: "Victoria", lng: -123.3, lat: 48.4 }], parks: { [near.id]: { drive: [null], walkM: 0 }, [far.id]: { drive: [null], walkM: 0 } } },
    } as ReturnType<typeof contentSyncSnapshot>);
    store.sync.set("staging", { ...whole, sourceId: SOURCE });
    const oldMap = await makeRelease("d".repeat(64), 1, "municipal-old-map", "old-map-scene");
    const oldGlyph = oldMap.rawManifest.files.find((file) => file.path.startsWith("map/fonts/"))!;
    store.files.set(oldGlyph.sha256, oldMap.content.get(oldGlyph.url)!.slice(0));
    store.inventories.set("e".repeat(64), {
      schema: "parkdex.content-map/v1", version: "e".repeat(64), mapManifest: oldMap.rawManifest.mapManifest,
      files: oldMap.rawManifest.files.filter((file) => file.path.startsWith("map/")),
    });
    const marker = memoryMarker("v1|build-1|none");
    const options = {
      store, fetch: server.fetcher, apiUrl: "https://parkdex.example.test/api/content/current", environment: "staging" as const,
      claimedParkIds: () => [], connectivity: { connected: true, wifi: true }, badgeArt: false,
      appBuild: "build-2", cacheMarker: marker, lastLocation: [near.lng, near.lat] as [number, number],
    };

    // A hidden tab, a background start or no network: no sync runs.
    const hidden = track(createContentRuntime(options));
    hidden.setForeground(false);
    await hidden.start();
    await vi.waitFor(() => expect(marker.value).toBe("v1|build-2|none"));
    expect(server.calls).toEqual([]);
    const trimmed = await store.getSyncState("staging");
    expect(trimmed?.boundaries.features.map((feature) => feature.properties.id)).toEqual([near.id]);
    expect(trimmed?.parks).toHaveLength(2);
    expect(trimmed?.catalogue?.version).toBeNull();
    expect(boundaryIds(hidden)).toEqual([near.id]);
    expect(store.inventories.size).toBe(0);
    expect(store.files.has(oldGlyph.sha256)).toBe(false);
    await hidden.stop();

    // The next sync swaps in the release's catalogue, which can load far boundaries again.
    const visible = track(createContentRuntime(options));
    await visible.start();
    await vi.waitFor(async () => expect((await store.getSyncState("staging"))?.catalogue?.version).toMatch(/^[0-9a-f]{64}$/));
    expect(server.calls.filter((url) => url.includes("/api/content/snapshot"))).toHaveLength(1);
    await visible.loadParkBoundary?.(far.id);
    expect(boundaryIds(visible)).toEqual([near.id, far.id]);
  });
});
