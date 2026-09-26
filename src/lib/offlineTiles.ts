import { addProtocol } from "maplibre-gl";
import { PMTiles, Protocol, type RangeResponse, type Source } from "pmtiles";

// The island basemap ships as one Protomaps archive split into fixed-size chunk files
// (see scripts/fetch-map.mjs). Capacitor's local server ignores HTTP Range offsets, so
// instead of range requests this source fetches whole chunks and slices them.
// Archives are clustered, so tiles near each other on the map sit in the same chunks.
type Manifest = { size: number; chunkBytes: number; count: number };

const KEY = "island";
const MAX_CACHED_CHUNKS = 10;

class ChunkedSource implements Source {
  private manifest: Promise<Manifest>;
  private chunks = new Map<number, Promise<ArrayBuffer>>();

  constructor(private base: string) {
    this.manifest = fetch(`${base}/manifest.json`).then((r) => r.json());
  }

  getKey() {
    return KEY;
  }

  private chunk(i: number) {
    let p = this.chunks.get(i);
    if (p) {
      // Refresh recency for the LRU.
      this.chunks.delete(i);
      this.chunks.set(i, p);
      return p;
    }
    p = fetch(`${this.base}/${String(i).padStart(3, "0")}.bin`).then((r) => {
      if (!r.ok) throw new Error(`map chunk ${i}: ${r.status}`);
      return r.arrayBuffer();
    });
    p.catch(() => this.chunks.delete(i));
    this.chunks.set(i, p);
    while (this.chunks.size > MAX_CACHED_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!);
    return p;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const { chunkBytes, size } = await this.manifest;
    const end = Math.min(offset + length, size);
    const out = new Uint8Array(end - offset);
    for (let i = Math.floor(offset / chunkBytes); i * chunkBytes < end; i++) {
      const buf = new Uint8Array(await this.chunk(i));
      const start = i * chunkBytes;
      const from = Math.max(offset, start) - start;
      const to = Math.min(end, start + buf.length) - start;
      out.set(buf.subarray(from, to), start + from - offset);
    }
    return { data: out.buffer };
  }
}

let registered = false;

// Registers the pmtiles:// protocol once; the style uses pmtiles://island/{z}/{x}/{y}.
export function registerOfflineTiles(origin: string) {
  if (registered) return;
  registered = true;
  const protocol = new Protocol();
  protocol.add(new PMTiles(new ChunkedSource(`${origin}/map/island`)));
  addProtocol("pmtiles", protocol.tile);
}

export const OFFLINE_TILES = `pmtiles://${KEY}/{z}/{x}/{y}`;
