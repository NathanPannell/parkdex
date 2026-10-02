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
export type ContentSyncState = {
  revision: number;
  /** Local source binding persisted beside the cursor, never sent by the API. */
  sourceId?: string;
  parks: Park[];
  boundaries: ContentBoundaries;
  drive: DriveData;
  assets: ContentFile[];
  map: ContentMapPointer | null;
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
   * current map still lists, since chunks are optional coverage that can be fetched again.
   */
  deleteFile(hash: string, options?: { optionalMapChunk?: boolean }): Promise<void>;
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
  return /(?:^|\/)map\/island\/[^/]+\.bin$/.test(decoded);
}
export type MapPoint = [number, number];

export type StoredFileSummary = { hash: string; size: number; path: string | null };

export interface ContentRuntime {
  getStatus(): ContentStatus;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  retry(): Promise<void>;
  setForeground(foreground: boolean): void;
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
  getSceneAssetVersion(parkId: string, expectedScene?: string | null): string | null;
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
};

/**
 * What content this build understands. Bump it when the app starts reading a
 * new content field: installs upgrading from an older build then fetch one full
 * snapshot (while still showing their cache) so the new field is filled in.
 * The server's minimumReaderVersion compares against the same number.
 */
export const CONTENT_READER_VERSION = 2;
export const VICTORIA: MapPoint = [-123.3656, 48.4284];
/** Bounds of the detailed map archive this build uses (the --bbox of its Protomaps extract). */
export const CONTENT_BOUNDS: [number, number, number, number] = [-139.1, 48.2, -114.0, 60.0];
/**
 * The detailed BC map (Protomaps 20260925, zooms 0-14, 512 KB chunks) built by
 * scripts/build-map-inventory.py. This build uses it instead of the server's map
 * pointer, which stays on the island archive because installed builds still
 * download the whole map they are given. The inventory is immutable and verified
 * against this hash before use.
 */
export const BUILD_MAP_POINTER: ContentMapPointer = {
  version: "01a7e200fc12922215be78afd9800d8f9458369b077e9f7fea94b67497233f8d",
  manifestUrl: "https://kip-assets.parkdex.app/releases/01a7e200fc12922215be78afd9800d8f9458369b077e9f7fea94b67497233f8d/map/manifest.json",
  manifestSha256: "ef99db0a47f2614f5396f042642122b7241473322d84947a8e79ae3cb0595106",
};
/**
 * Layout of the archive BUILD_MAP_POINTER names, so the map can stream it from
 * the CDN at launch without waiting for park content. Update with the pointer.
 */
export const BUILD_MAP_ARCHIVE = {
  chunkBytes: 524288,
  count: 2478,
  size: 1298961806,
  chunkBaseUrl: `https://kip-assets.parkdex.app/releases/${BUILD_MAP_POINTER.version}/map/island`,
  glyphBaseUrl: "https://kip-assets.parkdex.app/releases/5f0d137050ac8f83a0dd42f98291010577fae75a7538d62127690fd0f7630744/map/fonts",
} as const;
export const CONTENT_CDN_ORIGIN = "https://kip-assets.parkdex.app";

export function isRemoteContentPath(path: string): boolean {
  return path === "data/parks.json" || path === "data/drive.json" || path === "boundaries.geojson" ||
    path.startsWith("art/badges/scenes/") || path.startsWith("map/");
}
export function isCoreContentPath(path: string): boolean {
  return isRemoteContentPath(path) && !/^map\/island\/\d{3}\.bin$/.test(path);
}
