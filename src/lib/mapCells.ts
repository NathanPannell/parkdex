import type { FeatureCollection, Point, Polygon } from "geojson";
import { BUILD_MAP_POINTER, type MapPoint } from "./content/contracts";
import type { Screen } from "./store";

/** Zoom-9 squares (about 50 km in southern BC) that visitors choose to keep offline. */
export const CELL_ZOOM = 9;
const INDEX_PATH = "/map/cells.json";
const SAVED_KEY = "parkdex-map-squares-v1";

type ChunkRun = number | [number, number];
export type CellIndex = {
  schema: "parkdex.map-cells/v1";
  version: string;
  zoom: number;
  chunkBytes: number;
  size: number;
  cells: Record<string, ChunkRun[]>;
};
export type CellState = "unavailable" | "available" | "saved" | "selected" | "unselect";

let indexPromise: Promise<CellIndex> | null = null;

/** The bundled square index for the map release this build pins. */
export function loadCellIndex(load: () => Promise<unknown> = fetchIndex): Promise<CellIndex> {
  if (!indexPromise) {
    indexPromise = load().then(parseCellIndex);
    indexPromise.catch(() => { indexPromise = null; });
  }
  return indexPromise;
}

async function fetchIndex(): Promise<unknown> {
  const base = typeof document === "undefined" ? "http://localhost/" : document.baseURI;
  const response = await fetch(new URL(INDEX_PATH, base));
  if (!response.ok) throw new Error(`Map square index failed to load (${response.status})`);
  return response.json();
}

export function parseCellIndex(value: unknown): CellIndex {
  const index = value as CellIndex;
  if (!index || index.schema !== "parkdex.map-cells/v1" || index.zoom !== CELL_ZOOM) throw new Error("Map square index is invalid");
  if (index.version !== BUILD_MAP_POINTER.version) throw new Error("Map square index does not match this build's map");
  if (!Number.isSafeInteger(index.chunkBytes) || index.chunkBytes <= 0 || !Number.isSafeInteger(index.size) || index.size <= 0) {
    throw new Error("Map square index layout is invalid");
  }
  return index;
}

export function cellKeyAt([lng, lat]: MapPoint): string {
  const scale = 2 ** CELL_ZOOM;
  const x = Math.floor(((lng + 180) / 360) * scale);
  const radians = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * scale);
  return `${x}/${y}`;
}

export function cellRing(key: string): MapPoint[] {
  const [x, y] = key.split("/").map(Number);
  const scale = 2 ** CELL_ZOOM;
  const lng = (tx: number) => (tx / scale) * 360 - 180;
  const lat = (ty: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * ty) / scale));
  const [west, east, north, south] = [lng(x), lng(x + 1), lat(y), lat(y + 1)];
  return [[west, north], [east, north], [east, south], [west, south], [west, north]];
}

/** Squares within one step of a point: the visitor's square and its eight neighbours. */
export function surroundingCellKeys(point: MapPoint): string[] {
  const [x, y] = cellKeyAt(point).split("/").map(Number);
  const keys: string[] = [];
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) keys.push(`${x + dx}/${y + dy}`);
  return keys;
}

export function cellChunkIds(index: CellIndex, key: string): number[] {
  const runs = index.cells[key] ?? [];
  return runs.flatMap((run) => {
    if (typeof run === "number") return [run];
    return Array.from({ length: run[1] - run[0] + 1 }, (_, offset) => run[0] + offset);
  });
}

export function chunkIdsForCells(index: CellIndex, keys: Iterable<string>): Set<number> {
  const ids = new Set<number>();
  for (const key of keys) for (const id of cellChunkIds(index, key)) ids.add(id);
  return ids;
}

export function chunkBytes(index: CellIndex, id: number): number {
  return Math.max(0, Math.min(index.chunkBytes, index.size - id * index.chunkBytes));
}

export function bytesForChunks(index: CellIndex, ids: Iterable<number>): number {
  let total = 0;
  for (const id of ids) total += chunkBytes(index, id);
  return total;
}

/**
 * Chunks to remove when squares are deleted: only those no kept square or nearby
 * square still needs, since neighbouring squares share chunks.
 */
export function chunksToRemove(index: CellIndex, removed: Iterable<string>, kept: Iterable<string>): number[] {
  const keep = chunkIdsForCells(index, kept);
  return [...chunkIdsForCells(index, removed)].filter((id) => !keep.has(id)).sort((a, b) => a - b);
}

export function gridFeatures(index: CellIndex, states: ReadonlyMap<string, CellState>): FeatureCollection<Polygon, { key: string; state: CellState }> {
  return {
    type: "FeatureCollection",
    features: Object.keys(index.cells).map((key) => ({
      type: "Feature",
      properties: { key, state: states.get(key) ?? "available" },
      geometry: { type: "Polygon", coordinates: [cellRing(key)] },
    })),
  };
}

/** Parks in each square, keyed like the index. */
export function parkCountsByCell(parks: readonly { lng: number; lat: number }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const park of parks) {
    const key = cellKeyAt([park.lng, park.lat]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** A label point at each square's centre: its full download size and how many parks it holds. */
export function squareLabels(index: CellIndex, parks: readonly { lng: number; lat: number }[]): FeatureCollection<Point, { key: string; label: string }> {
  const counts = parkCountsByCell(parks);
  return {
    type: "FeatureCollection",
    features: Object.keys(index.cells).map((key) => {
      const ring = cellRing(key);
      const parkCount = counts.get(key) ?? 0;
      const size = formatMegabytes(bytesForChunks(index, chunkIdsForCells(index, [key])));
      return {
        type: "Feature",
        properties: { key, label: parkCount ? `${size}
${parkCount} ${parkCount === 1 ? "park" : "parks"}` : size },
        geometry: { type: "Point", coordinates: [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2] },
      };
    }),
  };
}

export function formatMegabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

type SavedSquares = { version: string; keys: string[] };

/** Squares the visitor chose to keep. Kept per device; the map files themselves live in the content store. */
export function readSavedSquares(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string[] {
  const saved = readSquares(storage);
  return saved && saved.current ? saved.keys : [];
}

/**
 * Squares saved for the map an earlier build pinned. Their files belong to that
 * archive, so they are not offline with this map; Download maps offers them again.
 */
export function readSquaresToSaveAgain(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string[] {
  const saved = readSquares(storage);
  return saved && !saved.current ? saved.keys : [];
}

function readSquares(storage: Pick<Storage, "getItem"> | undefined): { keys: string[]; current: boolean } | null {
  try {
    const value = JSON.parse(storage?.getItem(SAVED_KEY) ?? "null") as SavedSquares | null;
    if (!value || !Array.isArray(value.keys)) return null;
    const keys = value.keys.filter((key) => typeof key === "string" && /^\d+\/\d+$/.test(key));
    return { keys, current: value.version === undefined || value.version === BUILD_MAP_POINTER.version };
  } catch {
    return null;
  }
}

export function writeSavedSquares(keys: Iterable<string>, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(SAVED_KEY, JSON.stringify({ version: BUILD_MAP_POINTER.version, keys: [...new Set(keys)].sort() } satisfies SavedSquares));
  } catch {
    // Storage can be unavailable in private windows; the downloaded files still stay usable.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

type Listener = () => void;
const openListeners = new Set<Listener>();
type DownloadMapsRequest = { returnTo: Screen | null };
let openRequest: DownloadMapsRequest | null = null;

/** Lets Manage downloads open the square picker on the map, and return to it afterwards. */
export function requestDownloadMaps(returnTo: Screen | null = null): void {
  openRequest = { returnTo };
  for (const listener of openListeners) listener();
}

export function consumeDownloadMapsRequest(): DownloadMapsRequest | null {
  const request = openRequest;
  openRequest = null;
  return request;
}

export function subscribeDownloadMapsRequest(listener: Listener): () => void {
  openListeners.add(listener);
  return () => void openListeners.delete(listener);
}
