import { findTile, PMTiles, zxyToTileId } from "pmtiles";
import { CONTENT_BOUNDS, type ContentRuntime, type ContentSnapshot, type MapPoint } from "./contracts";
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
const COARSE_ZOOMS = [6, 7, 8] as const;
const NEARBY_ZOOMS = [9, 10, 11, 12, 13, 14] as const;

export type MapDownloadDetail = "starter" | "nearby";
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
 * Starter coverage includes z10-11 around Victoria and coarse z6-8 tiles for
 * the island. Nearby coverage is a two-viewport window at z9-14.
 */
export async function prefetchMapArea(
  runtime: ContentRuntime,
  releaseId: string,
  point: MapPoint,
  detail: MapDownloadDetail,
  signal?: AbortSignal,
  snapshotOverride?: ContentSnapshot,
): Promise<MapPrefetchResult> {
  if (detail !== "starter" && detail !== "nearby") throw new Error(`Unsupported map download detail: ${detail}`);
  validatePoint(point);
  throwIfAborted(signal);

  const snapshot = readySnapshot(runtime, releaseId, snapshotOverride);
  const manifest = snapshot.manifest.mapManifest;
  const source = new RuntimeChunkSource(runtime, releaseId, manifest, () => undefined, true, signal);
  const archive = new PMTiles(source);
  const tiles = detail === "starter"
    ? starterTiles(point)
    : nearbyTiles(point);
  const header = await archive.getHeader();

  for (const tile of tiles) {
    throwIfAborted(signal);
    await touchTileRange(archive, source, header, tile, signal);
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
    bounds: detail === "starter" ? viewportBounds(point, 1) : viewportBounds(point, 2),
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

/** Return the exact z/x/y requests used by a starter or nearby coverage plan. */
export function mapAreaTiles(point: MapPoint, detail: MapDownloadDetail): Tile[] {
  validatePoint(point);
  return detail === "starter" ? starterTiles(point) : nearbyTiles(point);
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
  for (const zoom of COARSE_ZOOMS) {
    addBoundsTiles(tiles, CONTENT_BOUNDS, zoom);
  }
  return [...tiles.values()].sort(compareTiles);
}

function nearbyTiles(point: MapPoint): Tile[] {
  const tiles = new Map<string, Tile>();
  for (const zoom of NEARBY_ZOOMS) {
    addViewportTiles(tiles, point, zoom, 2);
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

function addBoundsTiles(tiles: Map<string, Tile>, bounds: MapBounds, zoom: number): void {
  const [west, south, east, north] = bounds;
  const worldScale = 2 ** zoom;
  const minX = Math.floor(((west + 180) / 360) * worldScale);
  const maxX = Math.floor(((east + 180) / 360) * worldScale);
  const minY = Math.floor(latitudeToMercatorY(north) * worldScale);
  const maxY = Math.floor(latitudeToMercatorY(south) * worldScale);
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
  const path = mapChunkPath(index);
  return snapshot.manifest.files.find((file) => file.path === path)?.byte_size ?? defaultSize;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The map prefetch was cancelled");
  error.name = "AbortError";
  throw error;
}
