import { addProtocol, removeProtocol, type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import { PMTiles, Protocol, type RangeResponse, type Source } from "pmtiles";
import type { ContentRuntime, ContentSnapshot, MapManifest } from "./content/contracts";

const TILE_SCHEME = "pmtiles";
const GLYPH_SCHEME = "contentglyph";
export const BASE_OVERVIEW_KEY = "bundled-canada-overview-v1";
export const BASE_OVERVIEW_PATH = "/map/bootstrap/canada-overview.pmtiles";
// 512 KB chunks: enough for a phone viewport across a few zoom levels.
const MAX_CACHED_CHUNKS = 32;

type ReleaseRegistration = {
  runtime: ContentRuntime;
  snapshot: ContentSnapshot;
  source: RuntimeChunkSource;
  references: number;
};

const registrations = new Map<string, ReleaseRegistration>();
const allowedChunkIds = new Map<string, Set<number>>();
const mapCoverageListeners = new Map<string, Set<() => void>>();
let tileProtocol: Protocol | null = null;
let tileProtocolInstalled = false;
let glyphProtocolInstalled = false;
let bundledOverview: PMTiles | null = null;
let detailedSourceRevision = 0;

/**
 * Install the PMTiles and glyph handlers for a ready content snapshot.
 * Call this after the runtime has exposed a ready snapshot and before creating
 * a MapLibre map that uses mapStyle(snapshot.releaseId).
 */
export function registerContentMapProtocols(runtime: ContentRuntime, snapshot: ContentSnapshot): () => void {
  const { releaseId } = snapshot;
  if (!releaseId) throw new Error("A content release is required to register map protocols");

  const existing = registrations.get(releaseId);
  if (existing) {
    if (existing.runtime !== runtime) throw new Error(`Map release ${releaseId} is already attached to another runtime`);
    existing.references += 1;
    return releaseCleanup(releaseId, existing);
  }

  const manifest = snapshot.manifest.mapManifest;
  validateMapManifest(manifest);
  ensureProtocols();

  const entry = {} as ReleaseRegistration;
  const source = new RuntimeChunkSource(runtime, releaseId, manifest, () => allowedChunkIds.get(releaseId));
  Object.assign(entry, { runtime, snapshot, source, references: 1 });
  registrations.set(releaseId, entry);
  tileProtocol!.add(new PMTiles(source));

  return releaseCleanup(releaseId, entry);
}

export function getRegisteredMapSnapshot(releaseId: string): ContentSnapshot | undefined {
  return registrations.get(releaseId)?.snapshot;
}

/** Compatibility name for callers that still use the older function name. */
export const registerOfflineTiles = registerContentMapProtocols;

function releaseCleanup(releaseId: string, entry: ReleaseRegistration): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    const current = registrations.get(releaseId);
    if (current !== entry) return;
    current.references -= 1;
    if (current.references > 0) return;

    registrations.delete(releaseId);
    tileProtocol?.tiles.delete(releaseId);
    if (registrations.size === 0) removeProtocols();
  };
}

function ensureProtocols(): void {
  if (!tileProtocol) tileProtocol = new Protocol();
  if (!bundledOverview) bundledOverview = new PMTiles(bundledOverviewSource);
  if (!tileProtocol.tiles.has(BASE_OVERVIEW_KEY)) tileProtocol.add(bundledOverview);
  if (!tileProtocolInstalled) {
    addProtocol(TILE_SCHEME, tileProtocol.tile);
    tileProtocolInstalled = true;
  }
  if (!glyphProtocolInstalled) {
    addProtocol(GLYPH_SCHEME, loadGlyph);
    glyphProtocolInstalled = true;
  }
}

function removeProtocols(): void {
  if (tileProtocolInstalled) {
    removeProtocol(TILE_SCHEME);
    tileProtocolInstalled = false;
  }
  if (glyphProtocolInstalled) {
    removeProtocol(GLYPH_SCHEME);
    glyphProtocolInstalled = false;
  }
  tileProtocol = null;
}

async function loadGlyph(request: { url: string }, controller: AbortController): Promise<{ data: ArrayBuffer }> {
  const url = new URL(request.url);
  const releaseId = url.hostname;
  const registration = registrations.get(releaseId);
  if (!registration) throw new Error(`Map release ${releaseId} is no longer registered`);

  const match = url.pathname.match(/^\/map\/fonts\/(.+)\/([^/]+)\.pbf$/);
  if (!match) throw new Error("Invalid content glyph URL");
  const fontStack = decodeURIComponent(match[1]);
  const range = decodeURIComponent(match[2]);
  const path = `map/fonts/${fontStack}/${range}.pbf`;
  throwIfAborted(controller.signal);
  const bytes = await registration.runtime.readFile(releaseId, path);
  throwIfAborted(controller.signal);
  return { data: bytes };
}

/**
 * A PMTiles byte source backed by a content release. Its key is the release ID,
 * keeping PMTiles' directory cache isolated when content is updated.
 */
export class RuntimeChunkSource implements Source {
  private readonly cachedChunks = new Map<number, ArrayBuffer>();
  readonly touchedChunks = new Set<number>();

  constructor(
    private readonly runtime: ContentRuntime,
    private readonly releaseId: string,
    private readonly manifest: MapManifest,
    private readonly allowed: () => ReadonlySet<number> | undefined,
    private readonly bypassAllowlist = false,
    private readonly defaultSignal?: AbortSignal,
  ) {}

  getKey(): string {
    return this.releaseId;
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    const requestSignal = signal ?? this.defaultSignal;
    throwIfAborted(requestSignal);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("Invalid PMTiles byte range");
    }
    const end = Math.min(offset + length, this.manifest.size);
    if (end <= offset) return { data: new ArrayBuffer(0) };

    const firstChunk = Math.floor(offset / this.manifest.chunkBytes);
    const lastChunk = Math.floor((end - 1) / this.manifest.chunkBytes);
    const indices = Array.from({ length: lastChunk - firstChunk + 1 }, (_, i) => firstChunk + i);
    const allowed = this.allowed();
    const missing = this.bypassAllowlist ? [] : indices.filter((index) => !allowed?.has(index));
    if (missing.length) await this.streamChunks(missing, requestSignal);

    const parts: ArrayBuffer[] = [];
    for (const index of indices) parts.push(await this.readChunk(index, requestSignal));
    throwIfAborted(requestSignal);
    const result = new Uint8Array(end - offset);
    for (let i = 0; i < indices.length; i += 1) {
      const index = indices[i];
      const chunk = new Uint8Array(parts[i]);
      const chunkStart = index * this.manifest.chunkBytes;
      const from = Math.max(offset, chunkStart) - chunkStart;
      const to = Math.min(end, chunkStart + chunk.length) - chunkStart;
      result.set(chunk.subarray(from, to), chunkStart + from - offset);
    }
    return { data: result.buffer };
  }

  /**
   * Online visitors stream detail for areas they have not downloaded, on any
   * connection. Offline, the request fails and the bundled base map stays visible.
   */
  private async streamChunks(indices: number[], signal?: AbortSignal): Promise<void> {
    try {
      for (const index of indices) await this.runtime.ensureFile(this.releaseId, mapChunkPath(index), "nearby", signal);
    } catch (error) {
      if (signal?.aborted || (error as Error)?.name === "AbortError") throw error;
      throw new Error("Map area has not been downloaded. Connect to the internet to load detail here.");
    }
    markStreamedMapChunks(this.releaseId, indices);
  }

  private async readChunk(index: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    throwIfAborted(signal);
    this.touchedChunks.add(index);
    const cached = this.cachedChunks.get(index);
    if (cached) {
      this.cachedChunks.delete(index);
      this.cachedChunks.set(index, cached);
      return cached;
    }

    const path = mapChunkPath(index);
    await this.runtime.ensureFile(this.releaseId, path, "nearby", signal);
    throwIfAborted(signal);
    const bytes = await this.runtime.readFile(this.releaseId, path);
    throwIfAborted(signal);
    this.cachedChunks.set(index, bytes);
    while (this.cachedChunks.size > MAX_CACHED_CHUNKS) {
      this.cachedChunks.delete(this.cachedChunks.keys().next().value!);
    }
    return bytes;
  }
}

/**
 * A small immutable app asset used as a map underlay before detailed content
 * chunks have arrived. Native Capacitor servers may ignore HTTP byte ranges,
 * so this source fetches the archive once and slices PMTiles reads in memory.
 */
export class BundledOverviewSource implements Source {
  private archive: Promise<ArrayBuffer> | null = null;

  constructor(
    private readonly loadArchive: () => Promise<ArrayBuffer> = () => fetchBundledOverview(),
    private readonly key = BASE_OVERVIEW_KEY,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    throwIfAborted(signal);
    if (
      !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 0 ||
      !Number.isSafeInteger(offset + length)
    ) {
      throw new RangeError("Invalid bundled PMTiles byte range");
    }
    if (length === 0) return { data: new ArrayBuffer(0) };

    const archive = await this.readArchive();
    throwIfAborted(signal);
    const start = Math.min(offset, archive.byteLength);
    const end = Math.min(offset + length, archive.byteLength);
    if (end <= start) return { data: new ArrayBuffer(0) };
    return { data: archive.slice(start, end) };
  }

  private readArchive(): Promise<ArrayBuffer> {
    if (!this.archive) {
      const pending = this.loadArchive();
      this.archive = pending;
      pending.catch(() => {
        if (this.archive === pending) this.archive = null;
      });
    }
    return this.archive;
  }
}

const bundledOverviewSource = new BundledOverviewSource();

/** Register PMTiles and start the bundled archive read before the first map request. */
export function prewarmBundledOverview(): Promise<void> {
  ensureProtocols();
  return bundledOverviewSource.getBytes(0, 127).then(() => undefined);
}

export function mapChunkPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new RangeError("Map chunk index must be a non-negative integer");
  return `map/island/${String(index).padStart(3, "0")}.bin`;
}

export function setAllowedMapChunks(releaseId: string, chunkIds: Iterable<number>): void {
  let allowed = allowedChunkIds.get(releaseId);
  if (!allowed) {
    allowed = new Set<number>();
    allowedChunkIds.set(releaseId, allowed);
  }
  let changed = false;
  for (const id of chunkIds) {
    if (allowed.has(id)) continue;
    allowed.add(id);
    changed = true;
  }
  if (changed) {
    const registration = registrations.get(releaseId);
    if (registration && tileProtocol) {
      // PMTiles v4.5 keeps rejected header and directory promises in its shared
      // cache. Replace its reader before the coverage listener asks MapLibre to
      // recreate the detail source, while retaining verified chunk bytes and LRU.
      tileProtocol.add(new PMTiles(registration.source));
    }
    for (const listener of mapCoverageListeners.get(releaseId) ?? []) listener();
  }
}

/**
 * Record chunks a tile request has already read. Unlike setAllowedMapChunks this
 * does not reload the detail source, because the requesting reader succeeded.
 */
function markStreamedMapChunks(releaseId: string, chunkIds: Iterable<number>): void {
  let allowed = allowedChunkIds.get(releaseId);
  if (!allowed) {
    allowed = new Set<number>();
    allowedChunkIds.set(releaseId, allowed);
  }
  for (const id of chunkIds) allowed.add(id);
}

/** Forget chunks whose files were removed, so offline reads fall back to the base map. */
export function removeAllowedMapChunks(releaseId: string, chunkIds: Iterable<number>): void {
  const allowed = allowedChunkIds.get(releaseId);
  if (!allowed) return;
  for (const id of chunkIds) allowed.delete(id);
}

export function getAllowedMapChunks(releaseId: string): readonly number[] {
  return [...(allowedChunkIds.get(releaseId) ?? [])].sort((a, b) => a - b);
}

export function resetAllowedMapChunks(releaseId: string): void {
  allowedChunkIds.delete(releaseId);
}

/** Subscribe to newly available detailed map chunks for the current release. */
export function subscribeMapCoverage(releaseId: string, listener: () => void): () => void {
  let listeners = mapCoverageListeners.get(releaseId);
  if (!listeners) {
    listeners = new Set();
    mapCoverageListeners.set(releaseId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = mapCoverageListeners.get(releaseId);
    current?.delete(listener);
    if (current?.size === 0) mapCoverageListeners.delete(releaseId);
  };
}

/** Recreate the detailed vector source after its allowlist gains local chunks. */
export function reloadDetailedMapSource(map: Pick<MapLibreMap, "getStyle" | "setStyle">): boolean {
  const currentStyle = map.getStyle();
  const source = currentStyle.sources?.protomaps;
  if (!source) return false;
  if (source.type !== "vector" || !Array.isArray(source.tiles) || source.tiles.length === 0) return false;
  if (!source.tiles.every((url): url is string => typeof url === "string")) return false;

  // MapLibre's setTiles reload leaves failed in-view tiles in an errored actor
  // state. Changing this URL makes a style diff replace the detail source and
  // TileManager, while preserving the overview, overlays, and current camera.
  const tiles = [...source.tiles];
  tiles[0] = withCoverageRevision(tiles[0]);
  const nextStyle: StyleSpecification = {
    ...currentStyle,
    sources: {
      ...currentStyle.sources,
      protomaps: { ...source, tiles },
    },
  };
  map.setStyle(nextStyle, { diff: true });
  return true;
}

/** Consume a pending refresh before changing style, including synchronous style.load events. */
export function flushPendingDetailedMapSourceRefresh(
  map: Pick<MapLibreMap, "getStyle" | "setStyle">,
  pending: { current: boolean },
): boolean {
  if (!pending.current) return false;
  pending.current = false;
  if (reloadDetailedMapSource(map)) return true;
  pending.current = true;
  return false;
}

function withCoverageRevision(tileTemplate: string): string {
  const hashIndex = tileTemplate.indexOf("#");
  const fragment = hashIndex < 0 ? "" : tileTemplate.slice(hashIndex);
  const withoutFragment = hashIndex < 0 ? tileTemplate : tileTemplate.slice(0, hashIndex);
  const queryIndex = withoutFragment.indexOf("?");
  const base = queryIndex < 0 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? "" : withoutFragment.slice(queryIndex + 1));
  query.set("coverage", String(++detailedSourceRevision));
  return `${base}?${query.toString()}${fragment}`;
}

function validateMapManifest(manifest: MapManifest): void {
  if (
    !Number.isSafeInteger(manifest.size) || manifest.size <= 0 ||
    !Number.isSafeInteger(manifest.chunkBytes) || manifest.chunkBytes <= 0 ||
    !Number.isSafeInteger(manifest.count) || manifest.count <= 0 ||
    Math.ceil(manifest.size / manifest.chunkBytes) !== manifest.count
  ) {
    throw new Error("Content map manifest is invalid");
  }
}

async function fetchBundledOverview(): Promise<ArrayBuffer> {
  const base = typeof document === "undefined" ? "http://localhost/" : document.baseURI;
  const response = await fetch(new URL(BASE_OVERVIEW_PATH, base));
  if (!response.ok) throw new Error(`Bundled map overview failed to load (${response.status})`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error("Bundled map overview is empty");
  return bytes;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The map request was cancelled");
  error.name = "AbortError";
  throw error;
}
