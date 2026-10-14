import type { FeatureCollection, MultiPolygon } from "geojson";
import type { Park } from "../parks";

export type ContentEnvironment = "staging" | "main" | "preview";
export type ContentFile = {
  path: string;
  key: string;
  url: string;
  sha256: string;
  byte_size: number;
  content_type: string;
};
export type MapManifest = { size: number; chunkBytes: number; count: number };
export type ContentManifest = {
  version: string;
  sourceCommit: string;
  cdnOrigin: string;
  files: ContentFile[];
  parkIds: string[];
  boundaryIds: string[];
  mapManifest: MapManifest;
};
export type ContentChannel = {
  schema: "parkdex.content-channel/v1";
  environment: ContentEnvironment;
  generation: number;
  releaseId: string;
  manifestUrl: string;
  manifestSha256: string;
  minimumReaderVersion: number;
};
export type DriveData = {
  hubs: { name: string; lng: number; lat: number }[];
  parks: Record<string, { drive: ([number, number] | null)[]; walkM: number }>;
};
export type ContentBoundaries = FeatureCollection<MultiPolygon, { id: string; biome: string }>;
export type ContentPayload = { parks: Park[]; boundaries: ContentBoundaries; drive: DriveData };
export type ContentMapPointer = { version: string; manifestUrl: string; manifestSha256: string };
export type ContentMapInventory = {
  schema: "parkdex.content-map/v1";
  version: string;
  mapManifest: MapManifest;
  files: ContentFile[];
};
export type ArchivedScene = { releaseId: string; scene: string; file: ContentFile };
export type ContentChange =
  | { entity: "park"; op: "upsert"; id: string; value: Park }
  | { entity: "boundary"; op: "upsert"; id: string; value: ContentBoundaries["features"][number] }
  | { entity: "drive"; op: "upsert"; id: string; value: DriveData["parks"][string] }
  | { entity: "asset"; op: "upsert"; id: string; value: ContentFile }
  | { entity: "hubs"; op: "upsert"; id: "default"; value: DriveData["hubs"] }
  | { entity: "map"; op: "upsert"; id: "default"; value: ContentMapPointer | null }
  | { entity: "park" | "boundary" | "drive" | "asset"; op: "delete"; id: string };
export type ContentChangeBatch = { revision: number; changes: ContentChange[] };
export type ContentChangesResponse = {
  schema: "parkdex.content-sync/v1";
  fromRevision: number;
  throughRevision: number;
  headRevision: number;
  hasMore: boolean;
  batches: ContentChangeBatch[];
};
/** One boundary file of a CDN catalogue release, as this device remembers it. */
export type CatalogueChunkRef = {
  path: string;
  url: string;
  sha256: string;
  byte_size: number;
  parkIds: string[];
  /** West, south, east, north of the boundaries in the file, when the release lists it. */
  bbox: [number, number, number, number] | null;
};
/**
 * Which boundaries of a CDN catalogue release this device keeps. Boundaries near the
 * player stay on the device; others load when the player looks at them and are
 * evicted again, least recently used first (see leanCache.ts).
 */
export type CatalogueCache = {
  /**
   * The CDN catalogue release the stored boundaries come from, or null when the device
   * trimmed a catalogue saved whole before it knew the release's chunk list. A null
   * catalogue is replaced by the release on the next sync.
   */
  version: string | null;
  revision: number;
  chunks: CatalogueChunkRef[];
  /** Paths of the chunks whose boundaries are stored, least recently used first. */
  loaded: string[];
  /** Boundaries that arrived through content changes after the release. They are never evicted. */
  pinned: string[];
};
export type ContentSyncState = {
  revision: number;
  /** Local source binding persisted beside the cursor, never sent by the API. */
  sourceId?: string;
  parks: Park[];
  /** Every park's boundary, or with `catalogue` only the boundaries this device keeps. */
  boundaries: ContentBoundaries;
  drive: DriveData;
  assets: ContentFile[];
  map: ContentMapPointer | null;
  /** Present when the catalogue came from a CDN release and boundaries load by area. */
  catalogue?: CatalogueCache;
};
/**
 * `readerVersion` is the CONTENT_READER_VERSION of the build that last replaced
 * the whole cache. Caches from before it was recorded were written by reader 1.
 */
export type ContentSyncCursor = { revision: number; sourceId: string; readerVersion?: number };
export type StoredRelease = {
  id: string;
  channel: ContentChannel;
  manifest: ContentManifest;
  payload?: ContentPayload;
  readiness: "candidate" | "starter" | "complete";
  healthy: boolean;
};
// These references protect earned badges when a later catalog retires a park.
// They are never a replacement for, or a deletion boundary for, personal claims/photos.
export type RetainedPark = { park: Park; sceneFile?: ContentFile };

export type DeleteFileOptions = {
  /** Also allow a detailed map chunk the current map still lists. */
  optionalMapChunk?: boolean;
  /** Also allow badge art the current catalogue lists; it loads from the CDN again when shown. */
  optionalArt?: boolean;
};

export interface ContentStore {
  initialize(): Promise<void>;
  getActiveId(): Promise<string | null>;
  getRelease(id: string): Promise<StoredRelease | undefined>;
  listReleases(): Promise<StoredRelease[]>;
  putRelease(release: StoredRelease): Promise<void>;
  activateRelease(id: string, expectedActiveId: string | null): Promise<void>;
  clearActiveRelease(expectedActiveId: string): Promise<void>;
  deleteRelease(id: string): Promise<void>;
  hasFile(hash: string, expectedSize: number): Promise<boolean>;
  putFile(hash: string, bytes: ArrayBuffer): Promise<void>;
  readFile(hash: string, offset?: number, length?: number): Promise<ArrayBuffer>;
  fileUrl(hash: string, mime: string): Promise<string>;
  listFiles(): Promise<{ hash: string; size: number }[]>;
  /**
   * Delete an unreferenced file. optionalMapChunk also allows a detailed map chunk the
   * current map still lists, and optionalArt badge art the current catalogue lists, since
   * both are optional copies that can be fetched again. Retained and archived badges stay.
   */
  deleteFile(hash: string, options?: DeleteFileOptions): Promise<void>;
  getRetainedParks(): Promise<RetainedPark[]>;
  retainParks(parks: RetainedPark[]): Promise<void>;
  getArchivedScene(releaseId: string, scene: string): Promise<ArchivedScene | undefined>;
  retainArchivedScene(scene: ArchivedScene): Promise<void>;
  listArchivedScenes(): Promise<ArchivedScene[]>;
  getSyncCursor(environment: ContentEnvironment): Promise<ContentSyncCursor | null>;
  getSyncState(environment: ContentEnvironment): Promise<ContentSyncState | null>;
  replaceSyncState(environment: ContentEnvironment, expectedRevision: number | null, state: ContentSyncState, sourceId: string, expectedSourceId: string | null, resetCursor?: boolean): Promise<void>;
  applySyncBatch(environment: ContentEnvironment, expectedRevision: number, batch: ContentChangeBatch, sourceId: string): Promise<void>;
  advanceSyncRevision(environment: ContentEnvironment, expectedRevision: number, revision: number, sourceId: string): Promise<void>;
  getMapInventory(version: string): Promise<ContentMapInventory | null>;
  putMapInventory(inventory: ContentMapInventory): Promise<void>;
  pruneMapInventories(keepVersions: readonly string[]): Promise<void>;
  getCachedMapPointer(environment: ContentEnvironment): Promise<ContentMapPointer | null>;
  close(): Promise<void>;
}

export type ContentSnapshot = {
  releaseId: string;
  generation: number;
  manifest: ContentManifest;
  parks: Park[];
  parkById: Map<string, Park>;
  liveParks: Park[];
  retiredParks: Park[];
  boundaries: ContentBoundaries;
  drive: DriveData;
  // Core asset URLs are hydrated before a snapshot can become visible.
  assetUrls: ReadonlyMap<string, string>;
  /** CDN copies of badge art not saved on this device, shown only while online. */
  remoteSceneUrls?: ReadonlyMap<string, string>;
  retainedSceneUrls: ReadonlyMap<string, string>;
};
export type ContentPhase = "starting" | "downloading" | "ready" | "updating" | "offline" | "error";
export type ContentSyncStage = "idle" | "checking" | "waiting-for-wifi" | "downloading" | "applying" | "error";
export type ContentStatus = {
  phase: ContentPhase;
  snapshot: ContentSnapshot | null;
  downloadedBytes: number;
  totalBytes: number;
  /** Number of content file transfers currently in progress. */
  activeDownloads: number;
  fullMapReady: boolean;
  /** A validated map inventory and its glyphs are available locally, including offline cached detail. */
  mapDetailReady: boolean;
  waitingForWifi: boolean;
  syncStage: ContentSyncStage;
  error: string | null;
};
export type DownloadPurpose = "core" | "nearby" | "bulk" | "update";
export type Connectivity = {
  connected: boolean;
  /** True only when the platform confirms a physical Wi-Fi connection. */
  wifi: boolean;
  /** Optional platform override for essential content downloads. */
  contentDownloadAllowed?: boolean;
};

export function canDownloadContent(connectivity: Connectivity): boolean {
  return connectivity.connected && (connectivity.contentDownloadAllowed ?? true);
}

export function isWaitingForContentWifi(connectivity: Connectivity): boolean {
  return connectivity.connected && !connectivity.wifi;
}

const TRANSPORT_PAUSED = "contentTransportPaused";

/**
 * A request the platform stopped while the Activity was paused but still visible, for example
 * under a permission dialog. It is a cancellation, not a failure: work restarts on resume.
 */
export function contentTransportPausedError(): DOMException {
  const error = new DOMException("Content requests wait while Parkdex is paused", "AbortError");
  Object.defineProperty(error, TRANSPORT_PAUSED, { value: true });
  return error;
}

export function isContentTransportPaused(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as Record<string, unknown>)[TRANSPORT_PAUSED] === true;
}

/** Request options understood by the content transport. */
export type ContentRequestInit = RequestInit & {
  /** Allow a detailed map chunk on any connection, for nearby and streamed detail. */
  anyNetwork?: boolean;
};

/** Nearby and streamed map detail may use mobile data; other map chunk downloads wait for Wi-Fi. */
export function requiresContentWifiFor(purpose: DownloadPurpose, path: string): boolean {
  return purpose !== "nearby" && requiresContentWifi(path);
}

/** Detailed map chunks require confirmed physical Wi-Fi unless a request allows any network. */
export function requiresContentWifi(path: string): boolean {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* Keep malformed paths for URL validation. */ }
  const match = /(?:^|\/)map\/([^/]+)\/[^/]+\.bin$/.exec(decoded);
  return !!match && match[1] !== "fonts";
}

/*
 * A detailed map keeps its chunks and chunk layout in one folder of its release:
 * map/island/ up to the BC map, map/detail/ from the combined BC and Nova Scotia
 * map. map/fonts/ holds glyphs. Readers accept any folder so both kinds of release
 * keep working.
 */
const MAP_CHUNK_PATH = /^map\/([a-z][a-z0-9-]*)\/(\d{3,})\.bin$/;
const MAP_LAYOUT_PATH = /^map\/([a-z][a-z0-9-]*)\/manifest\.json$/;
/** The folder of map releases published before the combined map. */
export const LEGACY_MAP_FOLDER = "island";

export function isMapChunkPath(path: string): boolean {
  const match = MAP_CHUNK_PATH.exec(path);
  return !!match && match[1] !== "fonts";
}

export function isMapLayoutPath(path: string): boolean {
  const match = MAP_LAYOUT_PATH.exec(path);
  return !!match && match[1] !== "fonts";
}

/** The chunk number in a map chunk path, or null for any other path. */
export function mapChunkIndex(path: string): number | null {
  const match = MAP_CHUNK_PATH.exec(path);
  if (!match || match[1] === "fonts") return null;
  const index = Number(match[2]);
  return Number.isSafeInteger(index) ? index : null;
}

/** The folder holding a release's map chunks, from its chunk layout file. */
export function mapFolder(files: readonly { path: string }[]): string {
  const layout = files.find((file) => isMapLayoutPath(file.path));
  return layout ? layout.path.split("/")[1]! : LEGACY_MAP_FOLDER;
}

export function mapChunkPath(index: number, folder: string): string {
  if (!Number.isInteger(index) || index < 0) throw new RangeError("Map chunk index must be a non-negative integer");
  return `map/${folder}/${String(index).padStart(3, "0")}.bin`;
}
export type MapPoint = [number, number];

export type StoredFileSummary = { hash: string; size: number; path: string | null };

export interface ContentRuntime {
  getStatus(): ContentStatus;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  retry(): Promise<void>;
  setForeground(foreground: boolean): void;
  /** Restart work the platform stopped while the app was paused but not stopped. */
  resumeAfterPause?(): void;
  setConnectivity(connectivity: Connectivity): void;
  setLocation(point: MapPoint | null): void;
  refreshClaimedParks(): void;
  setBusy(busy: boolean): void;
  ensureFile(releaseId: string, path: string, purpose: DownloadPurpose, signal?: AbortSignal): Promise<void>;
  readFile(releaseId: string, path: string, offset?: number, length?: number): Promise<ArrayBuffer>;
  getFileUrl(releaseId: string, path: string): Promise<string>;
  /** Whether a release file is saved and verified on this device. */
  hasLocalFile?(releaseId: string, path: string): Promise<boolean>;
  /** Whether the device currently has a network connection. */
  isConnected?(): boolean;
  /** Read a saved file of a map version by path, or null when it is not on this device. */
  readLocalMapFile?(version: string, path: string, offset?: number, length?: number): Promise<ArrayBuffer | null>;
  /** Remove a saved detailed map chunk so a deleted map square frees its space. */
  deleteMapChunk?(releaseId: string, path: string): Promise<void>;
  /** Let chosen map squares and the area around the visitor download on mobile data. */
  setAllowMobileMapData?(allowed: boolean): void;
  /** Every file saved on this device, with its path in the current content when it has one. */
  listStoredFiles?(): Promise<StoredFileSummary[]>;
  /** Delete saved files the current content no longer uses. Files still referenced are kept. */
  deleteUnusedFiles?(): Promise<number>;
  /** Approximate bytes of the park catalogue kept on this device: parks, boundaries and drive times. */
  getCatalogueBytes?(): number;
  /** Load park boundaries for a map view the player is looking at (west, south, east, north). */
  loadBoundariesInView?(bounds: MapBox, zoom: number): void;
  /** Load one park's boundary, for a park the player opened. */
  loadParkBoundary?(parkId: string): Promise<void>;
  getSceneAssetVersion(parkId: string, expectedScene?: string | null): string | null;
  /** Save one park's badge art now, for a claim made before nearby art finished. */
  ensureParkArt?(parkId: string): Promise<void>;
  ensureArchivedScene(releaseId: string, scene: string): Promise<string>;
  stop(): Promise<void>;
}

export type ContentRuntimeOptions = {
  store: ContentStore;
  /** A configured null value means sync mode is selected but its origin is invalid. */
  apiUrl?: string | null;
  /** Temporary legacy bridge while existing installations transition from the R2 channel. */
  discoveryUrl?: string;
  environment: ContentEnvironment;
  claimedParkIds: () => string[];
  fetch?: typeof fetch;
  connectivity?: Connectivity;
  now?: () => number;
  /** A map pointer this build uses in place of the server's (see BUILD_MAP_POINTER). */
  mapPointer?: ContentMapPointer;
  /** The player's last saved position, so content near them is kept before a fresh fix lands. */
  lastLocation?: MapPoint | null;
  /** False when nothing shows badge art, so no scene file is required or fetched near the visitor. */
  badgeArt?: boolean;
  /** The app bundle's build. A new one (a web deploy or an over-the-air bundle) cleans up old content once. */
  appBuild?: string;
  /** Remembers which build and map old content was last cleaned up for. Without it no cleanup runs. */
  cacheMarker?: { read(): string | null; write(value: string): void };
};

/**
 * What content this build understands. Bump it when the app starts reading a
 * new content field: installs upgrading from an older build then fetch one full
 * snapshot (while still showing their cache) so the new field is filled in.
 * The server's minimumReaderVersion compares against the same number.
 */
export const CONTENT_READER_VERSION = 3;
/**
 * Offline downloads: chosen map squares, the block of squares around the player and
 * the "Allow downloads on mobile data" switch that governs them. Off for now, because
 * Parkdex needs the internet and keeps only what is near the player. Offline downloads
 * come back with #199; the code stays in place behind this constant.
 */
export const OFFLINE_DOWNLOADS = false;
export const VICTORIA: MapPoint = [-123.3656, 48.4284];
export const HALIFAX: MapPoint = [-63.5752, 44.6488];
/** West, south, east, north in degrees. */
export type MapBox = readonly [west: number, south: number, east: number, north: number];
/** A supported province: its map box and the town that stands in for it when the visitor is elsewhere. */
export interface ContentArea {
  name: string;
  box: MapBox;
  anchor: MapPoint;
}
/**
 * Areas the detailed map archive this build uses covers: the boxes of the
 * --region of its Protomaps extract (scripts/map-region.geojson). They gate the
 * detailed map, nearby downloads and nearby art. worker/provinces.ts repeats the
 * names and boxes for the API; a test keeps the two lists equal.
 */
export const CONTENT_AREAS: readonly ContentArea[] = [
  { name: "British Columbia", box: [-139.1, 48.2, -114.0, 60.0], anchor: VICTORIA },
  { name: "Nova Scotia", box: [-66.5, 43.3, -59.6, 47.1], anchor: HALIFAX },
];
export const CONTENT_BOUNDS: readonly MapBox[] = CONTENT_AREAS.map((area) => area.box);

function insideBox([lng, lat]: MapPoint, [west, south, east, north]: MapBox): boolean {
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

/** The supported province whose box holds the point, or null outside every one. */
export function contentAreaAt(point: MapPoint, areas: readonly ContentArea[] = CONTENT_AREAS): ContentArea | null {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
  return areas.find((area) => insideBox(point, area.box)) ?? null;
}

/** The province holding the point, else the one whose box is closest; the first area for an invalid point. */
export function nearestContentArea(point: MapPoint, areas: readonly ContentArea[] = CONTENT_AREAS): ContentArea {
  if (areas.length === 0) throw new RangeError("At least one content area is required");
  const [lng, lat] = point;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return areas[0];
  let best = areas[0];
  let bestKm = Infinity;
  for (const area of areas) {
    const [west, south, east, north] = area.box;
    const nearLng = Math.min(east, Math.max(west, lng));
    const nearLat = Math.min(north, Math.max(south, lat));
    const kx = 111.32 * Math.cos((((lat + nearLat) / 2) * Math.PI) / 180);
    const km = Math.hypot((lng - nearLng) * kx, (lat - nearLat) * 110.54);
    if (km < bestKm) [best, bestKm] = [area, km];
  }
  return best;
}

export function isPointInsideContentBounds(point: MapPoint, bounds: readonly MapBox[] = CONTENT_BOUNDS): boolean {
  const [lng, lat] = point;
  return Number.isFinite(lng) && Number.isFinite(lat) &&
    bounds.some(([west, south, east, north]) => lng >= west && lng <= east && lat >= south && lat <= north);
}

/** One box around every area, for consumers that take a single box. */
export function contentBoundsEnvelope(bounds: readonly MapBox[] = CONTENT_BOUNDS): [number, number, number, number] {
  if (bounds.length === 0) throw new RangeError("At least one content area is required");
  return [
    Math.min(...bounds.map((box) => box[0])),
    Math.min(...bounds.map((box) => box[1])),
    Math.max(...bounds.map((box) => box[2])),
    Math.max(...bounds.map((box) => box[3])),
  ];
}

/** Whether a web-mercator tile overlaps any area (a shared edge does not count). */
export function tileIntersectsContentBounds(z: number, x: number, y: number, bounds: readonly MapBox[] = CONTENT_BOUNDS): boolean {
  const scale = 2 ** z;
  const lng = (tx: number) => (tx / scale) * 360 - 180;
  const lat = (ty: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * ty) / scale));
  const [west, east, north, south] = [lng(x), lng(x + 1), lat(y), lat(y + 1)];
  return bounds.some((box) => west < box[2] && east > box[0] && south < box[3] && north > box[1]);
}
/**
 * The detailed BC and Nova Scotia map (Protomaps 20261012, basemap 4.15.2, zooms
 * 0-14, 512 KB chunks) built by scripts/build-map-inventory.py. This build uses it
 * instead of the server's map pointer, which stays on the island archive because
 * installed builds still download the whole map they are given. The inventory is
 * immutable and verified against this hash before use.
 */
export const BUILD_MAP_POINTER: ContentMapPointer = {
  version: "0e0bd01743049ab8d651aa0530ed8a492c238ab8ca9f8e266aaddc97b11734fd",
  manifestUrl: "https://kip-assets.parkdex.app/releases/0e0bd01743049ab8d651aa0530ed8a492c238ab8ca9f8e266aaddc97b11734fd/map/manifest.json",
  manifestSha256: "1801c6f834f5a556010ef991f7ad45fff76a00344a05b58164024d6f4ea76765",
};
/**
 * Layout of the archive BUILD_MAP_POINTER names, so the map can stream it from
 * the CDN at launch without waiting for park content. Update with the pointer.
 */
export const BUILD_MAP_ARCHIVE = {
  chunkBytes: 524288,
  count: 2754,
  size: 1443700560,
  folder: "detail",
  chunkBaseUrl: `https://kip-assets.parkdex.app/releases/${BUILD_MAP_POINTER.version}/map/detail`,
  glyphBaseUrl: "https://kip-assets.parkdex.app/releases/5f0d137050ac8f83a0dd42f98291010577fae75a7538d62127690fd0f7630744/map/fonts",
} as const;
export const CONTENT_CDN_ORIGIN = "https://kip-assets.parkdex.app";

export function isRemoteContentPath(path: string): boolean {
  return path === "data/parks.json" || path === "data/drive.json" || path === "boundaries.geojson" ||
    path.startsWith("art/badges/scenes/") || path.startsWith("map/");
}
export function isCoreContentPath(path: string): boolean {
  return isRemoteContentPath(path) && !isMapChunkPath(path);
}
