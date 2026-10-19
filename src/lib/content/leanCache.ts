import { isMapChunkPath, type CatalogueChunkRef, type ContentFile, type MapBox, type MapPoint } from "./contracts";

/*
 * What Parkdex keeps on the device. Parkdex needs the internet for now, so it keeps
 * only what is near the player: park boundaries, map detail and (when badge art is
 * shown) art around them, plus the small park index and map labels. Everything else
 * loads from the CDN when the player looks at it and is evicted again. Personal data
 * (claims, photos, the account and the personal store) lives elsewhere and is never
 * touched here.
 */

/** Park boundaries within this distance of the player stay on the device. */
export const NEARBY_GUIDE_KM = 50;
/**
 * Boundary files kept on the device, nearby and recently viewed together. Nearby ones are
 * kept even above it. With the park index (about 1 MB) park guides stay under 5 MB.
 */
export const GUIDE_CACHE_BYTES = 3_000_000;
/** Below this zoom the map shows parks as dots, so a view loads no boundaries. */
export const VIEW_GUIDE_MIN_ZOOM = 8;
/** At most this many boundary files load for one map view. */
export const VIEW_GUIDE_MAX_CHUNKS = 3;
/** Badge art kept for parks near the player, nearest first. Art for claimed parks is always kept. */
export const NEARBY_ART_BYTES = 2_000_000;

export function distanceKm(a: MapPoint, b: MapPoint): number {
  const radians = Math.PI / 180;
  const dLat = (b[1] - a[1]) * radians;
  const dLng = (b[0] - a[0]) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

type ParkPoint = { lng: number; lat: number };

/**
 * Boundary files holding a park within `radiusKm` of the point. Chunks are chosen by
 * their parks, not their bounding boxes, because some chunks span the country.
 */
export function chunksNear(chunks: readonly CatalogueChunkRef[], parks: ReadonlyMap<string, ParkPoint>, point: MapPoint, radiusKm = NEARBY_GUIDE_KM): string[] {
  return chunks
    .filter((chunk) =>
      chunk.parkIds.some((id) => {
        const park = parks.get(id);
        return !!park && distanceKm(point, [park.lng, park.lat]) <= radiusKm;
      }),
    )
    .map((chunk) => chunk.path);
}

/** Boundary files with parks inside the view, those with the most parks in view first, at most `limit`. */
export function chunksInView(
  chunks: readonly CatalogueChunkRef[],
  parks: ReadonlyMap<string, ParkPoint>,
  [west, south, east, north]: MapBox,
  limit = VIEW_GUIDE_MAX_CHUNKS,
): string[] {
  const counted = chunks
    .map((chunk) => ({
      path: chunk.path,
      count: chunk.parkIds.filter((id) => {
        const park = parks.get(id);
        return !!park && park.lng >= west && park.lng <= east && park.lat >= south && park.lat <= north;
      }).length,
    }))
    .filter((entry) => entry.count > 0);
  counted.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return counted.slice(0, limit).map((entry) => entry.path);
}

export function chunkForPark(chunks: readonly CatalogueChunkRef[], parkId: string): string | null {
  return chunks.find((chunk) => chunk.parkIds.includes(parkId))?.path ?? null;
}

/**
 * Least recently used chunks to evict so the stored chunks fit in `capBytes`.
 * `loaded` lists stored chunks least recently used first; chunks in `keep` stay.
 */
export function chunksToEvict(
  loaded: readonly string[],
  sizes: ReadonlyMap<string, number>,
  keep: ReadonlySet<string>,
  capBytes = GUIDE_CACHE_BYTES,
): string[] {
  let total = loaded.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0);
  const evict: string[] = [];
  for (const path of loaded) {
    if (total <= capBytes) break;
    if (keep.has(path)) continue;
    evict.push(path);
    total -= sizes.get(path) ?? 0;
  }
  return evict;
}

/**
 * Badge art to keep: every claimed park's, then the nearest parks' within `radiusKm`
 * until `budgetBytes` is used. Other art shows from the CDN while online.
 */
export function artToKeep(
  parks: readonly { id: string; lng: number; lat: number; scene: string | null }[],
  assets: readonly ContentFile[],
  claimed: ReadonlySet<string>,
  near: MapPoint | null,
  radiusKm: number,
  budgetBytes = NEARBY_ART_BYTES,
): ContentFile[] {
  const byPath = new Map(assets.map((file) => [file.path, file]));
  const keep = new Map<string, ContentFile>();
  const nearby: { file: ContentFile; km: number }[] = [];
  for (const park of parks) {
    const file = park.scene ? byPath.get(`art/badges/scenes/${park.scene}.webp`) : undefined;
    if (!file) continue;
    if (claimed.has(park.id)) keep.set(file.path, file);
    else if (near) {
      const km = distanceKm(near, [park.lng, park.lat]);
      if (km <= radiusKm) nearby.push({ file, km });
    }
  }
  nearby.sort((a, b) => a.km - b.km || a.file.path.localeCompare(b.file.path));
  let used = 0;
  for (const { file } of nearby) {
    if (keep.has(file.path)) continue;
    if (used + file.byte_size > budgetBytes) break;
    keep.set(file.path, file);
    used += file.byte_size;
  }
  return [...keep.values()];
}

export type CleanupKeepInput = {
  /** Files of the map this build uses: its chunk layout, labels and chunks. */
  mapFiles: readonly ContentFile[];
  /** Map chunks near the player, or null to keep every saved chunk of the current map. */
  nearMapChunks: ReadonlySet<string> | null;
  /** Badge art to keep (see artToKeep). */
  art: readonly ContentFile[];
  /** Files something else still needs: retained and archived badges, downloads in progress. */
  protectedHashes: Iterable<string>;
};

/** Hashes of saved files to keep. Everything else on the device belongs to old releases or is far away. */
export function cleanupKeepSet(input: CleanupKeepInput): Set<string> {
  const keep = new Set<string>(input.protectedHashes);
  for (const file of input.mapFiles) {
    if (!isMapChunkPath(file.path) || !input.nearMapChunks || input.nearMapChunks.has(file.path)) keep.add(file.sha256);
  }
  for (const file of input.art) keep.add(file.sha256);
  return keep;
}

export function filesToDelete<T extends { hash: string }>(files: readonly T[], keep: ReadonlySet<string>): T[] {
  return files.filter((file) => !keep.has(file.hash));
}

/**
 * Identifies the app bundle and map a cleanup ran for. When either changes (a web
 * deploy, an over-the-air bundle, a new Play build or a new map pin), the next start
 * deletes data that belongs to old releases.
 */
export function cacheGeneration(appBuild: string, mapVersion: string | null): string {
  return `v1|${appBuild}|${mapVersion ?? "none"}`;
}

const GENERATION_KEY = "parkdex-cache-generation-v1";

export type CacheMarker = { read(): string | null; write(value: string): void };

/** The last generation cleaned, kept in local storage; written only after a cleanup finishes. */
export function localCacheMarker(): CacheMarker {
  const storage = () => {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  };
  return {
    read() {
      try {
        return storage()?.getItem(GENERATION_KEY) ?? null;
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        storage()?.setItem(GENERATION_KEY, value);
      } catch {
        // Without storage the cleanup runs again next start, which is harmless.
      }
    },
  };
}
