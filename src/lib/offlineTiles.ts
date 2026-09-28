import { addProtocol, removeProtocol } from "maplibre-gl";
import { PMTiles, Protocol, type RangeResponse, type Source } from "pmtiles";
import type { ContentRuntime, ContentSnapshot, MapManifest } from "./content/contracts";

const TILE_SCHEME = "pmtiles";
const GLYPH_SCHEME = "contentglyph";
const MAX_CACHED_CHUNKS = 12;

type ReleaseRegistration = {
  runtime: ContentRuntime;
  snapshot: ContentSnapshot;
  source: RuntimeChunkSource;
  references: number;
};

const registrations = new Map<string, ReleaseRegistration>();
const allowedChunkIds = new Map<string, Set<number>>();
let tileProtocol: Protocol | null = null;
let tileProtocolInstalled = false;
let glyphProtocolInstalled = false;

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
    if (!this.bypassAllowlist && (!allowed || indices.some((index) => !allowed.has(index)))) {
      throw new Error("Map area has not been downloaded. Expand nearby map coverage before panning there.");
    }

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
  for (const id of chunkIds) allowed.add(id);
}

export function getAllowedMapChunks(releaseId: string): readonly number[] {
  return [...(allowedChunkIds.get(releaseId) ?? [])].sort((a, b) => a - b);
}

export function resetAllowedMapChunks(releaseId: string): void {
  allowedChunkIds.delete(releaseId);
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The map request was cancelled");
  error.name = "AbortError";
  throw error;
}
