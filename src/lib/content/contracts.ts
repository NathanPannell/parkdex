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
export type ContentSyncCursor = { revision: number; sourceId: string };
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
  deleteFile(hash: string): Promise<void>;
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
  fullMapReady: boolean;
  waitingForWifi: boolean;
  syncStage: ContentSyncStage;
  error: string | null;
};
export type DownloadPurpose = "core" | "nearby" | "bulk" | "update";
export type Connectivity = { connected: boolean; wifi: boolean };
export type MapPoint = [number, number];

export interface ContentRuntime {
  getStatus(): ContentStatus;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  retry(): Promise<void>;
  setForeground(foreground: boolean): void;
  setConnectivity(connectivity: Connectivity): void;
  setLocation(point: MapPoint | null): void;
  setBusy(busy: boolean): void;
  ensureFile(releaseId: string, path: string, purpose: DownloadPurpose, signal?: AbortSignal): Promise<void>;
  readFile(releaseId: string, path: string, offset?: number, length?: number): Promise<ArrayBuffer>;
  getFileUrl(releaseId: string, path: string): Promise<string>;
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
};

export const CONTENT_READER_VERSION = 1;
export const VICTORIA: MapPoint = [-123.3656, 48.4284];
export const CONTENT_BOUNDS: [number, number, number, number] = [-128.45, 48.28, -123.25, 50.92];
export const CONTENT_CDN_ORIGIN = "https://kip-assets.parkdex.app";

export function isRemoteContentPath(path: string): boolean {
  return path === "data/parks.json" || path === "data/drive.json" || path === "boundaries.geojson" ||
    path.startsWith("art/badges/scenes/") || path.startsWith("map/");
}
export function isCoreContentPath(path: string): boolean {
  return isRemoteContentPath(path) && !/^map\/island\/\d{3}\.bin$/.test(path);
}
