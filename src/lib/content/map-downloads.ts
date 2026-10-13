import { findTile, PMTiles, zxyToTileId } from "pmtiles";
import { mapFolder, type ContentRuntime, type ContentSnapshot, type MapPoint } from "./contracts";
import {
  getAllowedMapChunks,
  getRegisteredMapSnapshot,
  mapChunkPath,
  RuntimeChunkSource,
  setAllowedMapChunks,
} from "../offlineTiles";

const VIEWPORT_WIDTH = 390;
const VIEWPORT_HEIGHT = 844;
const TILE_SIZE = 512;
const START_ZOOM = 10.7;
const STARTER_ZOOMS = [10, 11] as const;
// Nearby coverage is whole zoom-9 squares (about 50 km in southern BC) so it lines
// up with the squares a visitor can choose to download later.
export const NEARBY_CELL_ZOOM = 9;
const DETAIL_MAX_ZOOM = 14;
const ANCESTOR_ZOOMS = [7, 8] as const;

/**
 * starter: one viewport at z10-11. nearby: the visitor's own square, on any
 * connection. surrounding: the 3x3 block of squares around them, which can be
 * 20-60 MB and so waits for Wi-Fi.
 */
export type MapDownloadDetail = "starter" | "nearby" | "surrounding";
export type MapBounds = [west: number, south: number, east: number, north: number];
export type MapPrefetchResult = {
  releaseId: string;
  detail: MapDownloadDetail;
  anchor: MapPoint;
  bounds: MapBounds;
  chunkIds: number[];
  allowedChunkIds: number[];
  tileCount: number;
  coveredBytes: number;
};

type Tile = { z: number; x: number; y: number };

/**
 * Ensure the indexed PMTiles coverage for a representative map viewport.
 * Starter coverage is one viewport at z10-11 around the anchor; the bundled
 * Canada base map already covers coarser zooms. Nearby and surrounding coverage
 * download whole zoom-9 squares at z9-14, plus their z7-8 ancestors.
 */
export async function prefetchMapArea(
  runtime: ContentRuntime,
  releaseId: string,
  point: MapPoint,
  detail: MapDownloadDetail,
  signal?: AbortSignal,
  snapshotOverride?: ContentSnapshot,
): Promise<MapPrefetchResult> {
  if (detail !== "starter" && detail !== "nearby" && detail !== "surrounding") throw new Error(`Unsupported map download detail: ${detail}`);
  validatePoint(point);
  throwIfAborted(signal);

  const snapshot = readySnapshot(runtime, releaseId, snapshotOverride);
  const manifest = snapshot.manifest.mapManifest;
  const folder = mapFolder(snapshot.manifest.files);
  const source = new RuntimeChunkSource(runtime, releaseId, manifest, folder, () => undefined, true, signal);
  const archive = new PMTiles(source);
  const tiles = detail === "starter" ? starterTiles(point) : nearbyCells(point, detail === "surrounding" ? 1 : 0);
  const header = await archive.getHeader();

  if (detail === "starter") {
    for (const tile of tiles) {
      throwIfAborted(signal);
      await touchTileRange(archive, source, header, tile, signal);
    }
  } else {
    const ranges = tiles.flatMap((cell) => cellTileIdRanges(cell));
    const dataChunks = await chunksForTileIdRanges(archive, source, header, ranges, manifest.chunkBytes, signal);
    for (const index of dataChunks) {
      throwIfAborted(signal);
      if (index < 0 || index >= manifest.count) throw new Error("The PMTiles index points outside the declared map chunks");
      await runtime.ensureFile(releaseId, mapChunkPath(index, folder), detail === "surrounding" ? "bulk" : "nearby", signal);
      source.touchedChunks.add(index);
    }
  }
  throwIfAborted(signal);

  const chunkIds = [...source.touchedChunks].sort((a, b) => a - b);
  if (chunkIds.length === 0) throw new Error("The map index returned no chunks for the requested area");
  if (chunkIds.some((id) => id < 0 || id >= manifest.count)) {
    throw new Error("The PMTiles index points outside the declared map chunks");
  }

  setAllowedMapChunks(releaseId, chunkIds);
  const allowed = getAllowedMapChunks(releaseId);
  return {
    releaseId,
    detail,
    anchor: [point[0], point[1]],
    bounds: detail === "starter" ? viewportBounds(point, 1) : cellsBounds(tiles),
    chunkIds,
    allowedChunkIds: [...allowed],
    tileCount: tiles.length,
    coveredBytes: chunkIds.reduce((sum, id) => sum + chunkBytes(snapshot, id, manifest.chunkBytes), 0),
  };
}

async function touchTileRange(
  archive: PMTiles,
  source: RuntimeChunkSource,
  header: Awaited<ReturnType<PMTiles["getHeader"]>>,
  tile: Tile,
  signal?: AbortSignal,
): Promise<void> {
  const tileId = zxyToTileId(tile.z, tile.x, tile.y);
  let offset = header.rootDirectoryOffset;
  let length = header.rootDirectoryLength;

  for (let depth = 0; depth <= 3; depth += 1) {
    throwIfAborted(signal);
    const entries = await archive.cache.getDirectory(source, offset, length, header, signal);
    const entry = findTile(entries, tileId);
    if (!entry) return;
    if (entry.runLength > 0) {
      await source.getBytes(header.tileDataOffset + entry.offset, entry.length, signal);
      return;
    }
    offset = header.leafDirectoryOffset + entry.offset;
    length = entry.length;
  }
  throw new Error("Maximum PMTiles directory depth exceeded");
}

/**
 * Return the plan for a coverage request: exact z/x/y tiles for starter coverage,
 * or the zoom-9 squares whose whole z9-14 subtree nearby coverage downloads.
 */
export function mapAreaTiles(point: MapPoint, detail: MapDownloadDetail): Tile[] {
  validatePoint(point);
  return detail === "starter" ? starterTiles(point) : nearbyCells(point, detail === "surrounding" ? 1 : 0);
}

/** The zoom-9 square containing a point and its eight neighbours. */
export function nearbyCells(point: MapPoint, radius = 1): Tile[] {
  const [lng, lat] = point;
  const scale = 2 ** NEARBY_CELL_ZOOM;
  const cx = Math.floor(((lng + 180) / 360) * scale);
  const cy = Math.floor(latitudeToMercatorY(lat) * scale);
  const tiles = new Map<string, Tile>();
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      addTileIfInBounds(tiles, NEARBY_CELL_ZOOM, cx + dx, cy + dy);
    }
  }
  return [...tiles.values()].sort(compareTiles);
}

/**
 * PMTiles numbers tiles along a Hilbert curve per zoom, so every descendant of a
 * square at a deeper zoom falls in one contiguous tile ID range. Ancestors are
 * single IDs.
 */
export function cellTileIdRanges(cell: Tile, maxZoom = DETAIL_MAX_ZOOM): Array<[number, number]> {
  const cellIndex = zxyToTileId(cell.z, cell.x, cell.y) - zoomBase(cell.z);
  const ranges: Array<[number, number]> = [];
  for (const z of ANCESTOR_ZOOMS) {
    if (z >= cell.z) continue;
    const shift = cell.z - z;
    const id = zxyToTileId(z, cell.x >> shift, cell.y >> shift);
    ranges.push([id, id]);
  }
  for (let z = cell.z; z <= maxZoom; z += 1) {
    const span = 4 ** (z - cell.z);
    const start = zoomBase(z) + cellIndex * span;
    ranges.push([start, start + span - 1]);
  }
  return ranges;
}

function zoomBase(z: number): number {
  return (4 ** z - 1) / 3;
}

/** Walk the archive directories and return the data chunks holding tiles in the ranges. */
async function chunksForTileIdRanges(
  archive: PMTiles,
  source: RuntimeChunkSource,
  header: Awaited<ReturnType<PMTiles["getHeader"]>>,
  ranges: Array<[number, number]>,
  chunkBytes: number,
  signal?: AbortSignal,
): Promise<Set<number>> {
  const chunks = new Set<number>();
  const overlaps = (start: number, end: number) => ranges.some(([a, b]) => start <= b && end >= a);
  const visit = async (offset: number, length: number, depth: number, limit: number): Promise<void> => {
    if (depth > 3) throw new Error("Maximum PMTiles directory depth exceeded");
    throwIfAborted(signal);
    const entries = await archive.cache.getDirectory(source, offset, length, header, signal);
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.runLength === 0) {
        const nextStart = i + 1 < entries.length ? entries[i + 1].tileId : limit;
        if (overlaps(entry.tileId, nextStart - 1)) await visit(header.leafDirectoryOffset + entry.offset, entry.length, depth + 1, nextStart);
        continue;
      }
      if (!overlaps(entry.tileId, entry.tileId + entry.runLength - 1)) continue;
      const start = header.tileDataOffset + entry.offset;
      const end = start + entry.length - 1;
      for (let index = Math.floor(start / chunkBytes); index <= Math.floor(end / chunkBytes); index += 1) chunks.add(index);
    }
  };
  await visit(header.rootDirectoryOffset, header.rootDirectoryLength, 0, Number.MAX_SAFE_INTEGER);
  return chunks;
}

function cellsBounds(cells: Tile[]): MapBounds {
  let west = 180, south = 90, east = -180, north = -90;
  for (const { z, x, y } of cells) {
    const scale = 2 ** z;
    west = Math.min(west, (x / scale) * 360 - 180);
    east = Math.max(east, ((x + 1) / scale) * 360 - 180);
    north = Math.max(north, mercatorYToLatitude(y / scale));
    south = Math.min(south, mercatorYToLatitude((y + 1) / scale));
  }
  return [west, south, east, north];
}

function readySnapshot(
  runtime: ContentRuntime,
  releaseId: string,
  snapshotOverride?: ContentSnapshot,
): ContentSnapshot {
  if (snapshotOverride) {
    if (snapshotOverride.releaseId !== releaseId) throw new Error(`Content snapshot ${releaseId} does not match the requested release`);
    return snapshotOverride;
  }
  const registered = getRegisteredMapSnapshot(releaseId);
  const snapshot = registered ?? runtime.getStatus().snapshot;
  if (!snapshot || snapshot.releaseId !== releaseId) {
    throw new Error(`Content snapshot ${releaseId} is not ready`);
  }
  return snapshot;
}

function starterTiles(point: MapPoint): Tile[] {
  const tiles = new Map<string, Tile>();
  for (const zoom of STARTER_ZOOMS) {
    addViewportTiles(tiles, point, zoom, 1);
  }
  return [...tiles.values()].sort(compareTiles);
}

function addViewportTiles(tiles: Map<string, Tile>, point: MapPoint, zoom: number, viewportScale: number): void {
  const [lng, lat] = point;
  const centerX = (lng + 180) / 360;
  const centerY = latitudeToMercatorY(lat);
  const worldScale = 2 ** zoom;
  const halfWidth = (VIEWPORT_WIDTH * viewportScale) / (TILE_SIZE * 2 ** (START_ZOOM - zoom)) / 2;
  const halfHeight = (VIEWPORT_HEIGHT * viewportScale) / (TILE_SIZE * 2 ** (START_ZOOM - zoom)) / 2;
  const minX = Math.floor((centerX * worldScale) - halfWidth);
  const maxX = Math.floor((centerX * worldScale) + halfWidth);
  const minY = Math.floor((centerY * worldScale) - halfHeight);
  const maxY = Math.floor((centerY * worldScale) + halfHeight);
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      addTileIfInBounds(tiles, zoom, x, y);
    }
  }
}

function addTileIfInBounds(tiles: Map<string, Tile>, z: number, x: number, y: number): void {
  const dimension = 2 ** z;
  if (x < 0 || x >= dimension || y < 0 || y >= dimension) return;
  const key = `${z}/${x}/${y}`;
  if (!tiles.has(key)) tiles.set(key, { z, x, y });
}

function viewportBounds(point: MapPoint, viewportScale: number): MapBounds {
  const [lng, lat] = point;
  const halfWidth = (VIEWPORT_WIDTH * viewportScale) / TILE_SIZE / 2 ** START_ZOOM / 2;
  const halfHeight = (VIEWPORT_HEIGHT * viewportScale) / TILE_SIZE / 2 ** START_ZOOM / 2;
  const centerX = (lng + 180) / 360;
  const centerY = latitudeToMercatorY(lat);
  return [
    (centerX - halfWidth) * 360 - 180,
    mercatorYToLatitude(centerY + halfHeight),
    (centerX + halfWidth) * 360 - 180,
    mercatorYToLatitude(centerY - halfHeight),
  ];
}

function latitudeToMercatorY(latitude: number): number {
  const clamped = Math.max(-85.0511287798066, Math.min(85.0511287798066, latitude));
  const radians = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

function mercatorYToLatitude(y: number): number {
  const n = Math.PI - 2 * Math.PI * y;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

function compareTiles(a: Tile, b: Tile): number {
  return a.z - b.z || a.y - b.y || a.x - b.x;
}

function validatePoint(point: MapPoint): void {
  const [lng, lat] = point;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError("Map anchor must be a valid longitude and latitude");
  }
}

function chunkBytes(snapshot: ContentSnapshot, index: number, defaultSize: number): number {
  const path = mapChunkPath(index, mapFolder(snapshot.manifest.files));
  return snapshot.manifest.files.find((file) => file.path === path)?.byte_size ?? defaultSize;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The map prefetch was cancelled");
  error.name = "AbortError";
  throw error;
}
