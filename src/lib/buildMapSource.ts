import type { RangeResponse, Source } from "pmtiles";

export type BuildMapArchive = {
  chunkBytes: number;
  size: number;
  chunkBaseUrl: string;
};

export type BuildMapSourceOptions = {
  key: string;
  archive: BuildMapArchive;
  /** False when the device has no network, so saved map files are read instead. */
  isConnected: () => boolean;
  /** A saved chunk byte range, or null when that chunk is not on this device. */
  readLocal: (chunkIndex: number, offset: number, length: number) => Promise<ArrayBuffer | null>;
  /** Called when a range could be served from neither the network nor saved files. */
  onUnavailable?: () => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The detailed map archive pinned by this build. Online it streams only the byte
 * ranges a tile needs from the CDN, which the HTTP cache keeps; downloaded map
 * squares are read only when the device is offline or the network fails.
 */
export class BuildMapSource implements Source {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: BuildMapSourceOptions) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  getKey(): string {
    return this.options.key;
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    throwIfAborted(signal);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("Invalid PMTiles byte range");
    }
    const { chunkBytes, size } = this.options.archive;
    const end = Math.min(offset + length, size);
    if (end <= offset) return { data: new ArrayBuffer(0) };

    const first = Math.floor(offset / chunkBytes);
    const last = Math.floor((end - 1) / chunkBytes);
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, i) => {
        const index = first + i;
        const chunkStart = index * chunkBytes;
        const from = Math.max(offset, chunkStart) - chunkStart;
        const to = Math.min(end, chunkStart + chunkBytes) - chunkStart;
        return this.readPart(index, from, to - from, signal);
      }),
    );
    const result = new Uint8Array(end - offset);
    let cursor = 0;
    for (const part of parts) {
      result.set(new Uint8Array(part), cursor);
      cursor += part.byteLength;
    }
    if (cursor !== result.length) throw new Error("The map archive returned a short range");
    return { data: result.buffer };
  }

  private async readPart(index: number, offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (this.options.isConnected()) {
      try {
        return await this.fetchPart(index, offset, length, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    const local = await this.options.readLocal(index, offset, length).catch(() => null);
    throwIfAborted(signal);
    if (local && local.byteLength === length) return local;
    this.options.onUnavailable?.();
    throw new Error("Map detail for this area is not available offline");
  }

  private async fetchPart(index: number, offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Map request timed out")), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const url = `${this.options.archive.chunkBaseUrl}/${String(index).padStart(3, "0")}.bin`;
      const response = await this.fetcher(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        signal: controller.signal,
      });
      if (response.status === 206) {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== length) throw new Error("The map CDN returned a short range");
        return bytes;
      }
      if (response.ok) {
        // A server that ignores Range sends the whole chunk.
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength < offset + length) throw new Error("The map CDN returned a short chunk");
        return bytes.slice(offset, offset + length);
      }
      throw new Error(`Map chunk ${index} returned HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The map request was cancelled");
  error.name = "AbortError";
  throw error;
}
