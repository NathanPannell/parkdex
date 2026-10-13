import {
  canDownloadContent,
  CONTENT_READER_VERSION,
  isContentTransportPaused,
  isMapChunkPath,
  isMapLayoutPath,
  isPointInsideContentBounds,
  isWaitingForContentWifi,
  mapChunkIndex,
  VICTORIA,
  type Connectivity,
  type ContentChannel,
  type ContentChangeBatch,
  type ContentEnvironment,
  type ContentFile,
  type ContentMapInventory,
  type ContentMapPointer,
  type ContentManifest,
  type ContentSyncState,
  type ContentPayload,
  type ContentPhase,
  type ContentRuntime,
  type ContentRuntimeOptions,
  type ContentSnapshot,
  type ContentStatus,
  type ContentSyncCursor,
  type ContentRequestInit,
  type DownloadPurpose,
  type StoredFileSummary,
  type MapPoint,
  type RetainedPark,
  type StoredRelease,
} from "./contracts";
import {
  ContentValidationError,
  applyContentChangeBatch,
  assembleCatalogueSnapshot,
  assertFileBytes,
  catalogueIndexFile,
  coreFiles,
  fileByPath,
  mapChunkFiles,
  parseContentChannel,
  parseContentChanges,
  parseContentMapInventory,
  parseContentManifest,
  parseCatalogueChunk,
  parseCatalogueIndex,
  parseCatalogueSnapshotPointer,
  parseContentSnapshot,
  parseJsonBytes,
  remoteFiles,
  sha256Hex,
  validateContentPayload,
  validateContentSyncState,
} from "./manifest";
import { ContentDownloadScheduler, type DownloadPolicy } from "./scheduler";
import { prefetchMapArea } from "./map-downloads";
import { assertArchivedSceneDescriptor, assertArchivedSceneIdentity, restoreArchivedScene as restoreLegacyArchivedScene } from "./archived-art";
import { removeAllowedMapChunks, resetAllowedMapChunks, setAllowedMapChunks } from "../offlineTiles";

const DISCOVERY_COOLDOWN_MS = 5 * 60 * 1000;
const MANUAL_RETRY_COOLDOWN_MS = 15 * 1000;
const SYNC_RETRY_BASE_MS = 1000;
const SYNC_RETRY_MAX_MS = 30 * 1000;
const SYNC_BATCH_LIMIT = 50;
const LOCATION_DEBOUNCE_MS = 800;
// Nearby coverage is a 3x3 block of ~50 km squares, so re-anchor after about half a square.
const LOCATION_MOVE_THRESHOLD_KM = 25;
// Badge art downloads automatically only for parks this close to the visitor; the rest loads
// from the art CDN when shown. Re-check after a shorter move so art stays ahead of the visitor.
const NEARBY_ART_KM = 15;
const NEARBY_ART_MOVE_KM = 5;
const SCENE_PREFIX = "art/badges/scenes/";
// Catalogue chunks are small immutable files; a few at a time keeps a phone responsive.
const CATALOGUE_CHUNK_CONCURRENCY = 4;
const EMPTY_STATUS: ContentStatus = {
  phase: "starting",
  snapshot: null,
  downloadedBytes: 0,
  totalBytes: 0,
  activeDownloads: 0,
  fullMapReady: false,
  mapDetailReady: false,
  waitingForWifi: false,
  syncStage: "idle",
  error: null,
};

export class ContentUnavailableOfflineError extends Error {
  constructor(path: string) {
    super(`This content is not downloaded and is unavailable offline: ${path}`);
    this.name = "ContentUnavailableOfflineError";
  }
}

export class ArchivedSceneRestoreDeferredError extends Error {
  constructor() {
    super("Archived badge art will be restored when the app is online and in the foreground.");
    this.name = "ArchivedSceneRestoreDeferredError";
  }
}

function fileKey(hash: string, size: number) {
  return `${hash}:${size}`;
}

function isMapChunk(path: string) {
  return isMapChunkPath(path);
}

/** Chunk numbers of map chunk files, skipping any other path. */
function chunkIndices(files: readonly ContentFile[]): number[] {
  return files.map((file) => mapChunkIndex(file.path)).filter((index): index is number => index !== null);
}

function mapLayoutFile<T extends { path?: unknown }>(files: readonly T[]): T | undefined {
  return files.find((file) => typeof file?.path === "string" && isMapLayoutPath(file.path));
}

function versionFromAssetKey(file: ContentFile, scene: string): string | null {
  const path = `art/badges/scenes/${scene}.webp`;
  if (file.path !== path || file.content_type !== "image/webp") return null;
  const match = /^releases\/([a-f0-9]{64})\/art\/badges\/scenes\/[a-z0-9][a-z0-9-]*\.webp$/.exec(file.key);
  if (!match) return null;
  const expectedUrl = `https://kip-assets.parkdex.app/${file.key.split("/").map(encodeURIComponent).join("/")}`;
  if (file.url !== expectedUrl) return null;
  return match[1]!;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Park content could not be loaded.";
}

function assertUnredirected(response: Response, requestedUrl: string, label: string): void {
  if (response.url && response.url !== requestedUrl) {
    throw new ContentValidationError(`${label} redirected away from its immutable URL`);
  }
}

function parseEnvironment(value: unknown, expected: ContentEnvironment) {
  return parseContentChannel(value, expected);
}

function validMapPoint(point: MapPoint | null): point is MapPoint {
  return point !== null && Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
    point[0] >= -180 && point[0] <= 180 && point[1] >= -90 && point[1] <= 90;
}

function distanceKm(a: MapPoint, b: MapPoint) {
  const radians = Math.PI / 180;
  const dLat = (b[1] - a[1]) * radians;
  const dLng = (b[0] - a[0]) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function phaseForActive(connected: boolean): ContentPhase {
  return connected ? "ready" : "offline";
}

function requestPriority(purpose: "core" | "nearby" | "bulk" | "update", path: string) {
  if (purpose === "core" || (purpose === "update" && !isMapChunk(path))) return 0;
  if (purpose === "nearby") return 1;
  if (purpose === "update") return 2;
  return 3;
}

function parseMapFile(bytes: ArrayBuffer, expected: ContentManifest["mapManifest"]) {
  const value = parseJsonBytes(bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ContentValidationError("map chunk layout must be an object");
  const map = value as Record<string, unknown>;
  const keys = Object.keys(map).sort();
  if (keys.length !== 3 || keys[0] !== "chunkBytes" || keys[1] !== "count" || keys[2] !== "size") {
    throw new ContentValidationError("map chunk layout has an unsupported shape");
  }
  if (map.size !== expected.size || map.chunkBytes !== expected.chunkBytes || map.count !== expected.count) {
    throw new ContentValidationError("map chunk layout disagrees with the immutable release manifest");
  }
}

export function createContentRuntime(options: ContentRuntimeOptions): ContentRuntime {
  return new ContentRuntimeController(options);
}

class ContentRuntimeController implements ContentRuntime {
  private status: ContentStatus = EMPTY_STATUS;
  private readonly listeners = new Set<() => void>();
  private readonly scheduler: ContentDownloadScheduler;
  private readonly fetcher: typeof fetch;
  private readonly environment: ContentEnvironment;
  private readonly verifiedHashes = new Set<string>();
  private readonly progressFiles = new Map<string, number>();
  private readonly localFileSizes = new Map<string, number>();
  private readonly inFlightHashes = new Map<string, number>();
  private readonly bulkPromises = new Map<string, Promise<void>>();
  private readonly bulkControllers = new Map<string, AbortController>();
  private readonly candidatePromises = new Map<string, Promise<void>>();
  private readonly localFileCheckPromises = new Map<string, Promise<boolean>>();
  private readonly fileUrlPromises = new Map<string, Promise<string>>();
  private readonly syncManifests = new Map<string, ContentManifest>();
  private readonly mapInventories = new Map<string, ContentMapInventory>();
  private readonly localMapInventories = new Map<string, Promise<ContentMapInventory | null>>();
  private readonly artworkReadyReleases = new Set<string>();
  private activeDownloads = 0;
  private localFileIndexPromise: Promise<void> | null = null;
  private retainedProjectionRevision = 0;
  private startPromise: Promise<void> | null = null;
  private discoveryPromise: Promise<void> | null = null;
  private initialized = false;
  // Saved content is still being opened; offline or settings states wait until it has been tried.
  private startupSettled = false;
  private markStoreOpen!: () => void;
  private readonly storeOpen = new Promise<void>((resolve) => { this.markStoreOpen = resolve; });
  private stopped = false;
  private closePromise: Promise<void> | null = null;
  private lastDiscoveryAt = Number.NEGATIVE_INFINITY;
  private lastManualRetryAt = Number.NEGATIVE_INFINITY;
  private syncState: ContentSyncState | null = null;
  private syncPreviousState: ContentSyncState | null = null;
  private syncCacheInvalid = false;
  private sourceMismatch = false;
  private syncRetryRequested = false;
  private mapRetryRequested = false;
  private archivedScenePromises = new Map<string, Promise<string>>();
  private syncAbort: AbortController | null = null;
  private syncPromise: Promise<void> | null = null;
  private syncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private syncRetryAttempt = 0;
  private mapAbort: AbortController | null = null;
  private archivedSceneAborts = new Map<string, AbortController>();
  private mapSyncPromise: Promise<void> | null = null;
  private mapSyncVersion: string | null = null;
  private legacyMapReleaseId: string | null = null;
  private discoveryEtag: string | null = null;
  private latestChannel: ContentChannel | null = null;
  private currentLocation: MapPoint | null = null;
  private nearbyAnchor: { releaseId: string; point: MapPoint } | null = null;
  private nearbyRequest: { releaseId: string; point: MapPoint; controller: AbortController } | null = null;
  private nearbyTimer: ReturnType<typeof setTimeout> | undefined;
  private nearbyAbort: AbortController | null = null;
  private nearbyPromise: Promise<unknown> | null = null;
  private nearbyArtAnchor: MapPoint | null = null;
  private nearbyArtPromise: Promise<void> | null = null;
  private busy = false;
  private pendingActivationId: string | null = null;
  private waitingForUpdateWifi = false;
  private waitingForBulkWifi = false;
  // Set when the platform stopped a request during a pause that had no stop, so resume restarts it.
  private pausedWorkPending = false;

  constructor(private readonly options: ContentRuntimeOptions) {
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.fetcher = ((input: RequestInfo | URL, init?: RequestInit) => fetcher(input, init).catch((error: unknown) => {
      if (isContentTransportPaused(error)) this.pausedWorkPending = true;
      throw error;
    })) as typeof fetch;
    this.environment = options.environment;
    this.scheduler = new ContentDownloadScheduler(this.currentPolicy());
  }

  getStatus(): ContentStatus {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Content runtime is stopped"));
    if (!this.startPromise) this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async retry(): Promise<void> {
    if (this.stopped) return;
    if (!this.initialized) {
      this.startPromise = null;
      await this.start();
      return;
    }
    if (!this.canDownloadContent()) {
      const connected = this.connectivity().connected;
      this.setStatus({
        phase: this.status.snapshot ? phaseForActive(connected) : connected ? "error" : "offline",
        error: !connected && !this.status.snapshot ? "Connect to the internet to restore park content." : null,
        syncStage: "idle",
        waitingForWifi: this.waitingForBulkWifi || this.waitingForUpdateWifi,
      });
      return;
    }
    if (this.now() - this.lastManualRetryAt < MANUAL_RETRY_COOLDOWN_MS) return;
    this.lastManualRetryAt = this.now();
    this.clearSyncRetry(true);
    this.setStatus({ error: null, phase: this.status.snapshot ? "updating" : "downloading" });
    if (this.hasSyncApi()) {
      if (this.options.apiUrl === null) {
        this.setStatus({ phase: "error", syncStage: "error", error: "The content API is not configured for this environment." });
        return;
      }
      await this.syncContent(true, true);
      this.startMapSync();
    } else {
      if (this.status.snapshot) this.startBulkMap(this.status.snapshot.releaseId);
      await this.checkCurrentRelease(true);
    }
  }

  setForeground(foreground: boolean): void {
    if (this.stopped) return;
    const wasForeground = this.policyForeground;
    this.policyForeground = foreground;
    this.scheduler.setPolicy({ ...this.currentPolicy(), foreground });
    if (!foreground) {
      this.clearSyncRetry();
      if (this.nearbyTimer !== undefined) globalThis.clearTimeout(this.nearbyTimer);
      this.nearbyTimer = undefined;
      this.syncAbort?.abort(new DOMException("Content sync paused in the background", "AbortError"));
      this.mapAbort?.abort(new DOMException("Map sync paused in the background", "AbortError"));
      for (const controller of this.archivedSceneAborts.values()) controller.abort(new DOMException("Content restore paused in the background", "AbortError"));
      return;
    }
    if (!wasForeground && foreground) {
      this.clearSyncRetry(true);
      if (this.hasSyncApi()) this.lastDiscoveryAt = Number.NEGATIVE_INFINITY;
      if (this.syncPromise) {
        this.syncRetryRequested = true;
      }
      if (this.mapSyncPromise) this.mapRetryRequested = true;
    }
    if (this.initialized) {
      if (this.pendingActivationId && !this.busy) void this.activatePending();
      if (this.hasSyncApi() && this.canDownloadContent()) {
        void this.syncContent(true, false);
      } else {
        void this.checkCurrentRelease(false);
      }
      if (this.status.snapshot) {
        if (this.hasSyncApi()) this.startMapSync();
        else this.startBulkMap(this.status.snapshot.releaseId);
        this.scheduleNearbyPrefetch(true);
      }
    }
  }

  resumeAfterPause(): void {
    if (this.stopped || !this.pausedWorkPending) return;
    this.pausedWorkPending = false;
    // A real background stop restarts work through setForeground instead.
    if (!this.foreground) return;
    this.clearSyncRetry(true);
    if (this.syncPromise) this.syncRetryRequested = true;
    if (this.mapSyncPromise) this.mapRetryRequested = true;
    if (!this.initialized) return;
    if (this.hasSyncApi() && this.canDownloadContent()) void this.syncContent(true, false);
    else void this.checkCurrentRelease(true);
    if (this.status.snapshot) {
      if (this.hasSyncApi()) this.startMapSync();
      else this.startBulkMap(this.status.snapshot.releaseId);
      this.scheduleNearbyPrefetch(true);
      this.scheduleNearbyArt();
    }
  }

  setConnectivity(connectivity: Connectivity): void {
    if (this.stopped) return;
    const wasDownloadAllowed = this.options.connectivity ? canDownloadContent(this.options.connectivity) : false;
    this.options.connectivity = { ...connectivity };
    const downloadAllowed = canDownloadContent(connectivity);
    if (!wasDownloadAllowed && downloadAllowed) {
      this.clearSyncRetry(true);
      this.lastDiscoveryAt = Number.NEGATIVE_INFINITY;
      if (this.syncPromise) this.syncRetryRequested = true;
      if (this.mapSyncPromise) this.mapRetryRequested = true;
    }
    if (!downloadAllowed) {
      this.clearSyncRetry();
      const reason = new DOMException("Content download connectivity was lost", "AbortError");
      this.syncAbort?.abort(reason);
      this.mapAbort?.abort(reason);
      for (const controller of this.archivedSceneAborts.values()) controller.abort(reason);
    }
    this.scheduler.setPolicy(this.currentPolicy());
    const waitingForWifi = isWaitingForContentWifi(connectivity);
    this.waitingForUpdateWifi = waitingForWifi && !this.hasSyncApi() && this.hasPendingUpdateChunks();
    this.waitingForBulkWifi = waitingForWifi && this.hasPendingBulkMap();
    if (!this.startupSettled && !this.status.snapshot) {
      // Startup sets the phase itself once saved content has been tried.
      this.setStatus({ waitingForWifi: false });
    } else if (!connectivity.connected) {
      this.setStatus({ phase: "offline", error: null, syncStage: "idle", waitingForWifi: false });
    } else if (!downloadAllowed) {
      this.setStatus({
        phase: this.status.snapshot ? "ready" : "error",
        error: this.status.snapshot ? this.status.error : "Park content downloads are unavailable in the current network settings.",
        syncStage: this.status.snapshot ? this.status.syncStage : "error",
        waitingForWifi: this.waitingForBulkWifi || this.waitingForUpdateWifi,
      });
    } else if (this.status.phase === "offline") {
      this.setStatus({ phase: this.status.snapshot ? "ready" : "starting", error: null, syncStage: "idle", waitingForWifi: false });
    }
    this.updateWaitingStatus();
    if (this.initialized && downloadAllowed && this.foreground) {
      if (this.hasSyncApi() && (!this.status.snapshot || !this.artworkReadyReleases.has(this.status.snapshot.releaseId))) {
        void this.syncContent(true, false);
      } else {
        void this.checkCurrentRelease(false);
      }
      if (!wasDownloadAllowed && this.status.snapshot) {
        if (this.hasSyncApi()) this.startMapSync();
        else this.startBulkMap(this.status.snapshot.releaseId);
      }
      if (this.currentLocation && this.status.snapshot) this.scheduleNearbyPrefetch(false);
    }
  }

  getSceneAssetVersion(parkId: string, expectedScene?: string | null): string | null {
    const snapshot = this.status.snapshot;
    const park = snapshot?.parks.find((entry) => entry.id === parkId);
    if (!snapshot || !park?.scene) return null;
    if (expectedScene !== undefined && park.scene !== expectedScene) return null;
    const file = snapshot.manifest.files.find((entry) => entry.path === `art/badges/scenes/${park.scene}.webp`);
    return file ? versionFromAssetKey(file, park.scene) : null;
  }

  async ensureArchivedScene(releaseId: string, scene: string): Promise<string> {
    this.assertRunning();
    assertArchivedSceneIdentity(releaseId, scene);
    const key = `${releaseId}:${scene}`;
    const existing = this.archivedScenePromises.get(key);
    if (existing) return existing;
    const work = this.restoreArchivedScene(releaseId, scene, key);
    this.archivedScenePromises.set(key, work);
    try {
      return await work;
    } finally {
      if (this.archivedScenePromises.get(key) === work) this.archivedScenePromises.delete(key);
      this.archivedSceneAborts.delete(key);
    }
  }

  private async restoreArchivedScene(releaseId: string, scene: string, requestKey: string): Promise<string> {
    const cached = await this.options.store.getArchivedScene(releaseId, scene);
    if (cached) {
      assertArchivedSceneDescriptor(cached);
      if (await this.hasVerifiedLocalFile(cached.file)) {
        const url = await this.localFileUrl(cached.file);
        this.publishArchivedSceneUrl(releaseId, scene, url);
        return url;
      }
    }
    if (!this.foreground) throw new ArchivedSceneRestoreDeferredError();
    if (!this.canDownloadContent()) throw new ContentUnavailableOfflineError(`art/badges/scenes/${scene}.webp`);

    const controller = new AbortController();
    this.archivedSceneAborts.set(requestKey, controller);
    try {
      let file: ContentFile;
      if (cached) {
        file = cached.file;
      } else {
        const url = new URL(this.contentApiUrl("scene"));
        url.searchParams.set("releaseId", releaseId);
        url.searchParams.set("scene", scene);
        const response = await this.requestContent(url.href, controller.signal);
        if (response.status === 404) {
          file = await restoreLegacyArchivedScene(releaseId, scene, this.options.store, this.fetcher, controller.signal);
        } else {
          if (!response.ok) throw new Error(`Archived scene lookup returned HTTP ${response.status}`);
          const value = await response.json() as unknown;
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContentValidationError("Archived scene lookup has an invalid shape");
          const record = value as Record<string, unknown>;
          if (Object.keys(record).sort().join("\0") !== ["file", "schema"].join("\0") || record.schema !== "parkdex.scene-asset/v1") {
            throw new ContentValidationError("Archived scene lookup has an unsupported schema");
          }
          const archived = { releaseId, scene, file: record.file };
          assertArchivedSceneDescriptor(archived);
          await this.options.store.retainArchivedScene(archived);
          file = archived.file;
        }
      }
      if (!(await this.hasVerifiedLocalFile(file))) await this.scheduleFileDownload(file, "update", controller.signal);
      this.assertRunning();
      if (!this.foreground || controller.signal.aborted) throw new ArchivedSceneRestoreDeferredError();
      if (!this.canDownloadContent()) throw new ContentUnavailableOfflineError(`art/badges/scenes/${scene}.webp`);
      const fileUrl = await this.localFileUrl(file);
      this.publishArchivedSceneUrl(releaseId, scene, fileUrl);
      return fileUrl;
    } catch (error) {
      if (this.stopped) throw new Error("Content runtime is stopped");
      if (!this.foreground || controller.signal.aborted) throw new ArchivedSceneRestoreDeferredError();
      if (!this.canDownloadContent()) throw new ContentUnavailableOfflineError(`art/badges/scenes/${scene}.webp`);
      throw error;
    }
  }

  private publishArchivedSceneUrl(releaseId: string, scene: string, url: string): void {
    const snapshot = this.status.snapshot;
    if (!snapshot) return;
    const key = `${releaseId}:${scene}`;
    if (snapshot.retainedSceneUrls.get(key) === url) return;
    const retainedSceneUrls = new Map(snapshot.retainedSceneUrls);
    retainedSceneUrls.set(key, url);
    this.setStatus({ snapshot: { ...snapshot, retainedSceneUrls } });
  }

  setLocation(point: MapPoint | null): void {
    if (this.stopped) return;
    this.currentLocation = validMapPoint(point) && isPointInsideContentBounds(point) ? [point[0], point[1]] : null;
    if (this.status.snapshot) this.scheduleNearbyPrefetch(false);
    this.scheduleNearbyArt();
  }

  /** Download one park's badge art now, for a claim made before nearby art finished. */
  async ensureParkArt(parkId: string): Promise<void> {
    const state = this.syncState;
    const park = state?.parks.find((entry) => entry.id === parkId);
    const file = park?.scene ? state?.assets.find((entry) => entry.path === `${SCENE_PREFIX}${park.scene}.webp`) : undefined;
    if (!file) return;
    await this.scheduleFileDownload(file, "core");
    await this.refreshLocalSceneUrls();
  }

  refreshClaimedParks(): void {
    if (this.stopped) return;
    const projectionRevision = ++this.retainedProjectionRevision;
    const snapshot = this.status.snapshot;
    if (!snapshot) return;
    const claimed = new Set(this.options.claimedParkIds());
    const currentIds = new Set(snapshot.parks.map((park) => park.id));
    const retiredParks = snapshot.retiredParks.filter((park) => claimed.has(park.id));
    const parkById = new Map([...snapshot.parks, ...retiredParks].map((park) => [park.id, park]));
    const retainedSceneUrls = new Map([...snapshot.retainedSceneUrls].filter(([parkId]) => claimed.has(parkId) && !currentIds.has(parkId)));
    this.setStatus({ snapshot: { ...snapshot, parkById, retiredParks, retainedSceneUrls } });
    const state = this.syncState;
    if (state) void this.hydrateCachedRetainedParks(state, snapshot.releaseId, projectionRevision).catch(() => {});
  }

  setBusy(busy: boolean): void {
    if (this.stopped) return;
    const wasBusy = this.busy;
    this.busy = busy;
    if (wasBusy && !busy && this.pendingActivationId) void this.activatePending();
  }

  async ensureFile(releaseId: string, path: string, purpose: "core" | "nearby" | "bulk" | "update", signal?: AbortSignal): Promise<void> {
    this.assertRunning();
    const release = await this.options.store.getRelease(releaseId);
    const manifest = release?.manifest ?? this.syncManifests.get(releaseId);
    if (!manifest) throw new Error(`Content release ${releaseId} is not available locally`);
    const file = fileByPath(manifest, path);
    const key = fileKey(file.sha256, file.byte_size);
    this.trackFile(file);
    if (this.verifiedHashes.has(key)) return;
    const hasLocal = await this.hasVerifiedLocalFile(file);
    if (hasLocal) return;
    if (path.startsWith("map/") && releaseId.startsWith(`sync-${this.environment}-`) && !this.artworkReadyReleases.has(releaseId)) {
      throw new ContentUnavailableOfflineError("map details are waiting for verified badge art");
    }
    if (!this.connectivity().connected) throw new ContentUnavailableOfflineError(path);
    if (this.hasSyncApi() && path.startsWith("map/") &&
      (!this.syncState?.map || manifest.version !== this.syncState.map.version)) {
      throw new ContentUnavailableOfflineError(path);
    }
    const effectivePurpose = isMapChunk(path) && purpose !== "nearby" && purpose !== "update" ? "bulk" : purpose;
    this.incrementInFlight(file.sha256);
    try {
      await this.scheduler.enqueue({
      key: file.sha256,
      path: file.path,
      purpose: effectivePurpose,
      priority: requestPriority(effectivePurpose, file.path),
      run: (downloadSignal) => this.downloadFile(file, downloadSignal, effectivePurpose),
      }, signal);
      this.verifiedHashes.add(key);
      this.localFileSizes.set(file.sha256, file.byte_size);
      this.refreshProgress();
    } finally {
      this.decrementInFlight(file.sha256);
    }
  }

  async readFile(releaseId: string, path: string, offset?: number, length?: number): Promise<ArrayBuffer> {
    const release = await this.options.store.getRelease(releaseId);
    const manifest = release?.manifest ?? this.syncManifests.get(releaseId);
    if (!manifest) throw new Error(`Content release ${releaseId} is not available locally`);
    const file = fileByPath(manifest, path);
    const purpose = isMapChunk(path) ? "nearby" : "core";
    await this.ensureFile(releaseId, path, purpose);
    try {
      return await this.withInFlight(file, () => this.options.store.readFile(file.sha256, offset, length));
    } catch (error) {
      this.invalidateLocalFile(file);
      if (isMapChunk(file.path)) resetAllowedMapChunks(releaseId);
      throw error;
    }
  }

  isConnected(): boolean {
    return this.connectivity().connected;
  }

  /**
   * Offline map reads go straight to saved files of the build's map version, so
   * the map does not wait for park content to be published.
   */
  async readLocalMapFile(version: string, path: string, offset?: number, length?: number): Promise<ArrayBuffer | null> {
    // Early offline tile requests wait for the store instead of failing and redrawing later.
    await this.storeOpen;
    if (!this.initialized) return null;
    let inventory = this.localMapInventories.get(version);
    if (!inventory) {
      inventory = this.getVerifiedMapInventory(version).catch(() => null);
      this.localMapInventories.set(version, inventory);
    }
    const resolved = await inventory;
    if (!resolved) {
      if (this.localMapInventories.get(version) === inventory) this.localMapInventories.delete(version);
      return null;
    }
    const file = resolved.files.find((entry) => entry.path === path);
    if (!file) return null;
    try {
      return await this.options.store.readFile(file.sha256, offset, length);
    } catch {
      return null;
    }
  }

  async hasLocalFile(releaseId: string, path: string): Promise<boolean> {
    const release = await this.options.store.getRelease(releaseId);
    const manifest = release?.manifest ?? this.syncManifests.get(releaseId);
    if (!manifest) return false;
    const file = fileByPath(manifest, path);
    return this.verifiedHashes.has(fileKey(file.sha256, file.byte_size)) || await this.hasVerifiedLocalFile(file);
  }

  async deleteMapChunk(releaseId: string, path: string): Promise<void> {
    this.assertRunning();
    if (!isMapChunk(path)) throw new Error("Only detailed map chunks can be removed");
    const release = await this.options.store.getRelease(releaseId);
    const manifest = release?.manifest ?? this.syncManifests.get(releaseId);
    if (!manifest) return;
    const file = fileByPath(manifest, path);
    this.invalidateLocalFile(file);
    await this.options.store.deleteFile(file.sha256, { optionalMapChunk: true });
    const index = mapChunkIndex(path);
    if (index !== null) removeAllowedMapChunks(releaseId, [index]);
  }

  async listStoredFiles(): Promise<StoredFileSummary[]> {
    const pathByHash = new Map((this.status.snapshot?.manifest.files ?? []).map((file) => [file.sha256, file.path]));
    return (await this.options.store.listFiles()).map((file) => ({ hash: file.hash, size: file.size, path: pathByHash.get(file.hash) ?? null }));
  }

  async deleteUnusedFiles(): Promise<number> {
    this.assertRunning();
    const current = new Set((this.status.snapshot?.manifest.files ?? []).map((file) => file.sha256));
    for (const [hash, count] of this.inFlightHashes) if (count > 0) current.add(hash);
    let freed = 0;
    for (const file of await this.options.store.listFiles()) {
      if (current.has(file.hash)) continue;
      try {
        // The store still refuses files that earned badges or other retained content need.
        await this.options.store.deleteFile(file.hash);
        freed += file.size;
        this.localFileSizes.delete(file.hash);
        for (const key of this.verifiedHashes) if (key.startsWith(`${file.hash}:`)) this.verifiedHashes.delete(key);
        for (const [key] of this.fileUrlPromises) if (key.startsWith(`${file.hash}:`)) this.fileUrlPromises.delete(key);
      } catch {
        // Kept because something still references it.
      }
    }
    return freed;
  }

  async getFileUrl(releaseId: string, path: string): Promise<string> {
    const release = await this.options.store.getRelease(releaseId);
    const manifest = release?.manifest ?? this.syncManifests.get(releaseId);
    if (!manifest) throw new Error(`Content release ${releaseId} is not available locally`);
    const file = fileByPath(manifest, path);
    await this.ensureFile(releaseId, path, isMapChunk(path) ? "nearby" : "core");
    return this.localFileUrl(file);
  }

  async stop(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    this.clearSyncRetry();
    if (this.nearbyTimer !== undefined) globalThis.clearTimeout(this.nearbyTimer);
    this.nearbyTimer = undefined;
    this.nearbyAbort?.abort();
    this.syncAbort?.abort();
    this.mapAbort?.abort();
    for (const controller of this.archivedSceneAborts.values()) controller.abort();
    this.scheduler.dispose();
    this.closePromise = (async () => {
      await Promise.allSettled([
        this.startPromise ?? Promise.resolve(),
        this.discoveryPromise ?? Promise.resolve(),
        this.syncPromise ?? Promise.resolve(),
        this.mapSyncPromise ?? Promise.resolve(),
        ...this.candidatePromises.values(),
        ...this.bulkPromises.values(),
        ...this.archivedScenePromises.values(),
      ]);
      if (this.initialized) await this.options.store.close();
    })();
    return this.closePromise;
  }

  private async startInternal(): Promise<void> {
    this.setStatus({ phase: "starting", error: null, waitingForWifi: false });
    try {
      await this.startInternalSteps();
    } finally {
      this.startupSettled = true;
      this.markStoreOpen();
    }
  }

  private async startInternalSteps(): Promise<void> {
    try {
      await this.options.store.initialize();
      this.initialized = true;
      this.markStoreOpen();
      if (this.hasSyncApi()) {
        await this.startSyncInternal();
        return;
      }
      const initialActiveId = await this.options.store.getActiveId();
      let activeId = initialActiveId;
      if (activeId) {
        let release = await this.options.store.getRelease(activeId);
        if (!release) throw new Error("The active content release record is missing");
        let activeSnapshot: ContentSnapshot;
        let startupError: string | null = null;
        try {
          activeSnapshot = await this.hydrateStoredRelease(release);
        } catch (activeError) {
          const fallback = (await this.options.store.listReleases())
            .filter((candidate) => candidate.id !== activeId && candidate.healthy && candidate.channel.generation < release!.channel.generation)
            .sort((a, b) => b.channel.generation - a.channel.generation)[0];
          if (!fallback) throw activeError;
          activeSnapshot = await this.hydrateStoredRelease(fallback);
          await this.options.store.activateRelease(fallback.id, activeId);
          activeId = fallback.id;
          release = fallback;
          startupError = errorText(activeError);
        }
        const verifiedRelease = await this.options.store.getRelease(release.id);
        if (!verifiedRelease) throw new Error("The hydrated content release record is missing");
        if (!verifiedRelease.healthy) await this.options.store.putRelease({ ...verifiedRelease, healthy: true });
        this.publishSnapshot(activeSnapshot, phaseForActive(this.connectivity().connected), startupError);
        if (this.canDownloadContent() && this.foreground) {
          void prefetchMapArea(this, activeSnapshot.releaseId, this.mapAnchor(), "starter", undefined, activeSnapshot).catch(() => {});
        }
        this.refreshLocalFileIndexInBackground();
        await this.refreshMapReadiness(activeSnapshot);
      } else {
        this.refreshLocalFileIndexInBackground();
        this.setStatus({ phase: this.connectivity().connected ? "downloading" : "error", error: this.connectivity().connected ? null : "Connect to the internet to download park content." });
      }
      if (this.connectivity().connected && this.foreground) await this.checkCurrentRelease(true);
      else if (!this.status.snapshot) this.setStatus({ phase: "error", error: "Connect to the internet to download park content." });
      if (this.status.snapshot) {
        this.startBulkMap(this.status.snapshot.releaseId);
        this.scheduleNearbyPrefetch(false);
      }
      // A replaced release may still be referenced by mounted map readers in this
      // session. Reclaim it on a later startup, after those readers have gone away.
      if (initialActiveId && activeId === initialActiveId && this.status.snapshot?.releaseId === initialActiveId) {
        await this.collectGarbage();
      }
    } catch (error) {
      this.setStatus({ phase: "error", error: errorText(error) });
    }
  }

  private async startSyncInternal(): Promise<void> {
    if (this.options.apiUrl === null) {
      this.setStatus({ phase: "error", syncStage: "error", error: "The content API is not configured for this environment." });
      return;
    }
    const sourceId = this.configuredSourceId();
    let stored: ContentSyncState | null = null;
    let cacheNeedsRepair = false;
    try {
      stored = await this.options.store.getSyncState(this.environment);
      if (stored) {
        stored = this.withBuildMap(validateContentSyncState(stored));
        if (stored.sourceId !== sourceId) {
          this.sourceMismatch = true;
          this.syncCacheInvalid = true;
          this.syncPreviousState = stored;
          stored = null;
        } else {
          this.syncState = stored;
          this.refreshLocalFileIndexInBackground();
          this.trackFiles(stored.assets);
          if (await this.requiredSceneAssetsAreLocal(stored)) {
            await this.publishSyncState(stored, phaseForActive(this.connectivity().connected), null);
            const releaseId = this.status.snapshot?.releaseId;
            if (releaseId) this.hydrateCachedSnapshotInBackground(stored, releaseId);
          } else {
            cacheNeedsRepair = true;
          }
        }
      }
    } catch {
      stored = null;
      this.syncState = null;
      this.syncCacheInvalid = true;
    }
    if (!stored) this.refreshLocalFileIndexInBackground();
    if (!stored && !this.syncCacheInvalid) {
      try {
        const cursor = await this.options.store.getSyncCursor(this.environment);
        if (cursor) {
          this.syncCacheInvalid = true;
          this.sourceMismatch = cursor.sourceId !== sourceId;
        }
      } catch {
        this.syncCacheInvalid = true;
      }
    }

    if (stored && stored.parks.length === 0 && stored.revision > 0) {
      this.syncPreviousState = stored;
      this.syncState = null;
      this.syncCacheInvalid = true;
      cacheNeedsRepair = true;
      stored = null;
    }

    // Existing v1 installs keep their last verified release usable while the
    // first normalized snapshot is fetched only when no source-bound cache has
    // ever been installed. A cache from another API source must stay hidden.
    if (!stored && !this.status.snapshot && !this.sourceMismatch && !this.syncCacheInvalid) {
      const activeId = await this.options.store.getActiveId();
      const legacy = activeId ? await this.options.store.getRelease(activeId) : undefined;
      if (legacy) {
        try {
          const channel = parseContentChannel(legacy.channel, this.environment);
          const manifest = parseContentManifest(legacy.manifest, channel);
          const required = coreFiles(manifest);
          const allLocal = await Promise.all(required.map((file) => this.hasVerifiedLocalFile(file)));
          if (allLocal.every(Boolean)) {
            const payload = await this.readAndValidatePayload(legacy, manifest);
            const snapshot = await this.prepareSnapshot({ ...legacy, channel, manifest, payload }, payload);
            this.legacyMapReleaseId = legacy.id;
            this.publishSnapshot(snapshot, phaseForActive(this.connectivity().connected), null);
            await this.refreshMapReadiness(snapshot);
          }
        } catch {
          // A partial legacy cache must not prevent the normalized API snapshot.
        }
      }
    }

    this.startupSettled = true;
    if (this.canDownloadContent() && this.foreground) {
      await this.syncContent(true, false);
    } else {
      const waitingForWifi = !this.hasSyncApi() && this.isWaitingForWifi();
      const needsRepair = cacheNeedsRepair || this.syncCacheInvalid || this.sourceMismatch;
      this.setStatus({
        phase: this.status.snapshot ? phaseForActive(this.connectivity().connected) : this.connectivity().connected ? "error" : "offline",
        error: !this.status.snapshot && needsRepair
          ? "Saved park content needs repair. Connect to the internet to restore it."
          : !this.status.snapshot && !this.connectivity().connected
            ? "Connect to the internet to download park content."
            : null,
        syncStage: !this.status.snapshot && needsRepair ? "error" : waitingForWifi ? "waiting-for-wifi" : "idle",
        waitingForWifi: this.waitingForBulkWifi || this.waitingForUpdateWifi,
      });
    }

    if (this.status.snapshot) {
      if (this.hasSyncApi()) this.startMapSync();
      else this.startBulkMap(this.status.snapshot.releaseId);
      this.scheduleNearbyPrefetch(false);
    }
  }

  private hasSyncApi(): boolean {
    return this.options.apiUrl !== undefined;
  }

  private configuredSourceId(): string {
    const url = new URL(this.contentApiUrl("snapshot"));
    return `${this.environment}|${url.origin}/api/content`;
  }

  private contentApiUrl(endpoint: "snapshot" | "changes" | "scene"): string {
    if (this.options.apiUrl === null) throw new Error("The content API is not configured for this environment.");
    const configured = this.options.apiUrl ?? this.options.discoveryUrl;
    if (!configured) throw new Error("Content API URL is not configured");
    const base = typeof globalThis.location === "undefined" ? "https://parkdex.invalid/" : globalThis.location.href;
    const url = new URL(configured, base);
    url.pathname = url.pathname.replace(/\/(?:current|snapshot|changes|scene)\/?$/, "");
    if (!url.pathname.endsWith("/api/content")) url.pathname = `${url.pathname.replace(/\/$/, "")}/api/content`;
    url.pathname = `${url.pathname}/${endpoint}`;
    url.search = "";
    url.hash = "";
    // The server sends fields newer than reader 1 only when asked, so strict older builds keep working.
    if (endpoint !== "scene") url.searchParams.set("reader", String(CONTENT_READER_VERSION));
    return url.href;
  }

  private async requestContent(url: string, signal: AbortSignal): Promise<Response> {
    if (!this.canDownloadContent()) throw this.contentUnavailableError();
    if (!this.foreground) throw new DOMException("Content sync paused in the background", "AbortError");
    if (signal.aborted) throw signal.reason ?? new DOMException("Content sync cancelled", "AbortError");
    const response = await this.fetcher(url, {
      signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    assertUnredirected(response, url, "Content API request");
    return response;
  }

  private async syncContent(force: boolean, manual: boolean): Promise<void> {
    if (this.stopped || !this.initialized || !this.hasSyncApi()) return;
    if (this.options.apiUrl === null) {
      this.setStatus({ phase: "error", syncStage: "error", error: "The content API is not configured for this environment." });
      return;
    }
    if (this.syncPromise) return this.syncPromise;
    if (!this.foreground) return;
    if (!this.canDownloadContent()) {
      const waitingForWifi = !this.hasSyncApi() && this.isWaitingForWifi();
      this.setStatus({
        syncStage: waitingForWifi ? "waiting-for-wifi" : "idle",
        waitingForWifi,
        error: !this.connectivity().connected && !this.status.snapshot ? "Connect to the internet to restore park content." : this.status.error,
      });
      return;
    }
    const now = this.now();
    if (!force && !manual && now - this.lastDiscoveryAt < DISCOVERY_COOLDOWN_MS) return;
    this.lastDiscoveryAt = now;
    const controller = new AbortController();
    this.syncAbort = controller;
    const work = this.runContentSync(controller.signal);
    this.syncPromise = work;
    try {
      await work;
    } catch (error) {
      if (!this.stopped && isContentTransportPaused(error)) {
        // Resume restarts the sync at once; this backoff covers a resume that arrives too early.
        this.scheduleSyncRetry();
      } else if (!this.stopped && (error as Error)?.name !== "AbortError") {
        const waitingForWifi = (error as Error)?.name === "WifiUnavailableError";
        this.setStatus({
          phase: this.status.snapshot ? phaseForActive(this.connectivity().connected) : "error",
          syncStage: waitingForWifi ? "waiting-for-wifi" : "error",
          waitingForWifi: waitingForWifi || this.waitingForBulkWifi || this.waitingForUpdateWifi,
          error: waitingForWifi ? (this.status.snapshot ? null : "Connect to Wi-Fi to download detailed maps.") : errorText(error),
        });
        if (this.canDownloadContent()) this.scheduleSyncRetry();
      } else if (!this.stopped && !this.canDownloadContent()) {
        this.setStatus({ syncStage: "idle", waitingForWifi: this.waitingForBulkWifi || this.waitingForUpdateWifi });
      }
    } finally {
      if (this.syncAbort === controller) this.syncAbort = null;
      if (this.syncPromise === work) this.syncPromise = null;
      if (this.syncRetryRequested && !this.stopped && this.foreground && this.canDownloadContent()) {
        this.syncRetryRequested = false;
        this.clearSyncRetry();
        void Promise.resolve().then(() => this.syncContent(true, false));
      }
    }
  }

  private async runContentSync(signal: AbortSignal): Promise<void> {
    this.setStatus({
      phase: this.status.snapshot ? "updating" : "downloading",
      syncStage: "checking",
      waitingForWifi: false,
      error: null,
    });
    const sourceId = this.configuredSourceId();
    let expectedCursor: ContentSyncCursor | null = null;
    let cursorReadFailed = false;
    try {
      expectedCursor = await this.options.store.getSyncCursor(this.environment);
    } catch {
      cursorReadFailed = true;
      this.syncCacheInvalid = true;
    }
    let state: ContentSyncState | null = null;
    try {
      state = await this.options.store.getSyncState(this.environment);
    } catch {
      this.syncCacheInvalid = true;
    }
    let previous = state ?? this.syncState ?? this.syncPreviousState;
    let resetCursor = this.syncCacheInvalid || cursorReadFailed;
    if (state) {
      try {
        state = this.withBuildMap(validateContentSyncState(state));
        if (state.parks.length === 0 && state.revision > 0) {
          previous = state;
          state = null;
          this.syncCacheInvalid = true;
          resetCursor = true;
        }
      } catch {
        state = null;
        previous = this.syncState ?? this.syncPreviousState;
        this.syncCacheInvalid = true;
        resetCursor = true;
      }
    }
    if (state && expectedCursor && (state.revision !== expectedCursor.revision || state.sourceId !== expectedCursor.sourceId)) {
      this.syncState = null;
      throw new Error("Content sync cursor changed while a local snapshot was being read");
    }
    if (state && !expectedCursor) {
      previous = state;
      this.syncCacheInvalid = true;
      resetCursor = true;
      state = null;
    }
    if (!state && expectedCursor) {
      this.syncCacheInvalid = true;
      resetCursor = true;
    }
    if (state) {
      try {
        if (state.sourceId !== sourceId) {
          this.syncPreviousState = state;
          state = null;
          previous = this.syncPreviousState;
          this.sourceMismatch = true;
          this.syncCacheInvalid = true;
          resetCursor = true;
        }
      } catch {
        state = null;
        previous = this.syncState ?? this.syncPreviousState;
        this.syncCacheInvalid = true;
        resetCursor = true;
      }
    }
    // A build that reads more fields than the one that wrote this cache replaces
    // it with one full snapshot. The cache stays on screen until that commits.
    if (state && (expectedCursor?.readerVersion ?? 1) < CONTENT_READER_VERSION) {
      previous = state;
      state = null;
      resetCursor = true;
    }
    if (!state) {
      state = await this.fetchFullSnapshot(sourceId, signal);
      if (!previous) previous = this.syncPreviousState ?? state;
    }

    let fullSnapshotFallbacks = 0;
    while (!signal.aborted && this.foreground && this.canDownloadContent()) {
      const url = new URL(this.contentApiUrl("changes"));
      url.searchParams.set("after", String(state.revision));
      url.searchParams.set("limit", String(SYNC_BATCH_LIMIT));
      const response = await this.requestContent(url.href, signal);
      if (response.status === 410 || response.status === 413 || response.status === 400) {
        if (fullSnapshotFallbacks >= 1) throw new Error("Content changes repeatedly require a fresh snapshot; retrying shortly");
        fullSnapshotFallbacks += 1;
        const replacement = await this.fetchFullSnapshot(sourceId, signal);
        resetCursor ||= response.status === 400;
        state = replacement;
        continue;
      }
      if (!response.ok) throw new Error(`Content changes returned HTTP ${response.status}`);
      const changes = parseContentChanges(await response.json(), state.revision);
      for (const batch of changes.batches) state = applyContentChangeBatch(state, batch);
      if (!changes.hasMore) break;
    }
    this.assertSyncCanCommit(signal);
    await this.commitContentSnapshot(state, previous, expectedCursor, signal, resetCursor);
    this.syncCacheInvalid = false;
    this.sourceMismatch = false;
    this.syncPreviousState = null;
    this.syncRetryAttempt = 0;
    this.clearSyncRetry();
    this.setStatus({
      phase: this.status.snapshot ? phaseForActive(this.connectivity().connected) : "ready",
      syncStage: "idle",
      waitingForWifi: this.waitingForBulkWifi || this.waitingForUpdateWifi,
      error: null,
    });
    if (this.hasSyncApi()) this.startMapSync();
    else if (this.status.snapshot) this.startBulkMap(this.status.snapshot.releaseId);
  }

  /**
   * One complete catalogue: the API snapshot, or, when the API names a CDN catalogue
   * release, its index and every boundary chunk, checked exactly like an API snapshot.
   */
  private async fetchFullSnapshot(sourceId: string, signal: AbortSignal): Promise<ContentSyncState> {
    const response = await this.requestContent(this.contentApiUrl("snapshot"), signal);
    if (!response.ok) throw new Error(`Content snapshot returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    const pointer = parseCatalogueSnapshotPointer(body);
    if (!pointer) return { ...parseContentSnapshot(body), sourceId };
    this.setStatus({ syncStage: "downloading" });
    const index = parseCatalogueIndex(parseJsonBytes(await this.fetchCatalogueFile(catalogueIndexFile(pointer), signal)), pointer);
    const features: unknown[][] = new Array(index.chunks.length);
    let next = 0;
    const worker = async () => {
      while (next < index.chunks.length) {
        const position = next++;
        const chunk = index.chunks[position]!;
        features[position] = parseCatalogueChunk(parseJsonBytes(await this.fetchCatalogueFile(chunk, signal)), chunk);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CATALOGUE_CHUNK_CONCURRENCY, index.chunks.length) }, worker));
    return { ...assembleCatalogueSnapshot(index, features), sourceId };
  }

  private async fetchCatalogueFile(file: ContentFile, signal: AbortSignal): Promise<ArrayBuffer> {
    if (!this.canDownloadContent()) throw this.contentUnavailableError();
    if (signal.aborted) throw signal.reason ?? new DOMException("Content sync cancelled", "AbortError");
    // The catalogue is essential content, so it uses any connection, like the API snapshot.
    const init: ContentRequestInit = { signal, cache: "force-cache", anyNetwork: true };
    const response = await this.fetcher(file.url, init);
    if (!response.ok) throw new Error(`Content catalogue file ${file.path} returned HTTP ${response.status}`);
    assertUnredirected(response, file.url, `Content catalogue file ${file.path}`);
    const bytes = await response.arrayBuffer();
    await assertFileBytes(file, bytes);
    return bytes;
  }

  private async commitContentSnapshot(next: ContentSyncState, previous: ContentSyncState | null, expectedCursor: ContentSyncCursor | null, signal: AbortSignal, resetCursor = false): Promise<void> {
    const sourceId = this.configuredSourceId();
    const candidate = this.withBuildMap(validateContentSyncState({ ...next, sourceId }));
    await this.retainChangedClaimedScenes(previous, candidate);
    await this.ensureSyncAssets(candidate, signal);
    this.assertSyncCanCommit(signal);
    const expectedRevision = expectedCursor?.revision ?? null;
    const expectedSourceId = expectedCursor?.sourceId ?? null;
    const sourceChanged = expectedSourceId !== sourceId;
    const replaceCursorReset = sourceChanged || resetCursor || this.syncCacheInvalid;
    if (expectedRevision !== null && candidate.revision < expectedRevision && !replaceCursorReset) {
      throw new Error("Content snapshot is older than the saved sync cursor");
    }
    this.setStatus({ syncStage: "applying" });
    this.assertSyncCanCommit(signal);
    try {
      await this.options.store.replaceSyncState(this.environment, expectedRevision, candidate, sourceId, expectedSourceId, replaceCursorReset);
    } catch (error) {
      this.syncState = null;
      throw error;
    }
    this.syncState = candidate;
    this.assertSyncCanCommit(signal);
    await this.publishSyncState(candidate, phaseForActive(this.connectivity().connected), null, () => this.assertSyncCanCommit(signal));
  }

  private assertSyncCanCommit(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason ?? new DOMException("Content sync cancelled", "AbortError");
    if (this.stopped || !this.foreground || !this.canDownloadContent()) {
      throw new DOMException("Content sync paused before its snapshot was committed", "AbortError");
    }
  }

  /**
   * Files a catalogue needs on the device before it is shown: art for claimed parks and for
   * parks near the visitor, plus any asset that is not badge art. Other art loads on demand.
   */
  private requiredAssets(state: ContentSyncState): ContentFile[] {
    const claimed = new Set(this.options.claimedParkIds());
    const near = this.currentLocation;
    const wanted = new Set<string>();
    for (const park of state.parks) {
      if (!park.scene || this.options.badgeArt === false) continue;
      if (claimed.has(park.id) || (near && distanceKm(near, [park.lng, park.lat]) <= NEARBY_ART_KM)) {
        wanted.add(`${SCENE_PREFIX}${park.scene}.webp`);
      }
    }
    return state.assets.filter((file) => !file.path.startsWith(SCENE_PREFIX) || wanted.has(file.path));
  }

  private async requiredSceneAssetsAreLocal(state: ContentSyncState): Promise<boolean> {
    for (const file of state.assets) this.trackFile(file);
    const checks = await Promise.all(this.requiredAssets(state).map((file) => this.hasVerifiedLocalFile(file)));
    return checks.every(Boolean);
  }

  private async ensureSyncAssets(state: ContentSyncState, signal: AbortSignal): Promise<void> {
    for (const file of state.assets) this.trackFile(file);
    const missing: ContentFile[] = [];
    for (const file of this.requiredAssets(state)) {
      if (!(await this.hasVerifiedLocalFile(file))) missing.push(file);
    }
    if (missing.length === 0) return;
    this.setStatus({ syncStage: "downloading" });
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.all(missing.map((file) => this.scheduleFileDownload(file, "update", controller.signal).catch((error) => {
        controller.abort(error);
        throw error;
      })));
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private async scheduleFileDownload(file: ContentFile, purpose: "core" | "nearby" | "bulk" | "update", signal?: AbortSignal): Promise<void> {
    const key = fileKey(file.sha256, file.byte_size);
    if (await this.hasVerifiedLocalFile(file)) return;
    const snapshot = this.status.snapshot;
    if (file.path.startsWith("map/") && snapshot?.releaseId.startsWith(`sync-${this.environment}-`) && !this.artworkReadyReleases.has(snapshot.releaseId)) {
      throw new ContentUnavailableOfflineError("map details are waiting for verified badge art");
    }
    if (!this.canDownloadContent()) throw this.contentUnavailableError();
    this.incrementInFlight(file.sha256);
    try {
      await this.scheduler.enqueue({
        key: file.sha256,
        path: file.path,
        purpose,
        priority: requestPriority(purpose, file.path),
        run: (downloadSignal) => this.downloadFile(file, downloadSignal, purpose),
      }, signal);
      this.verifiedHashes.add(key);
      this.localFileSizes.set(file.sha256, file.byte_size);
      this.refreshProgress();
    } finally {
      this.decrementInFlight(file.sha256);
    }
  }

  private async retainChangedClaimedScenes(previous: ContentSyncState | null, next: ContentSyncState): Promise<void> {
    const previousParks = previous?.parks ?? this.status.snapshot?.parks ?? [];
    const previousFiles = previous?.assets ?? this.status.snapshot?.manifest.files ?? [];
    const nextParks = new Map(next.parks.map((park) => [park.id, park]));
    const nextFiles = new Map(next.assets.map((file) => [file.path, file]));
    const claimed = new Set(this.options.claimedParkIds());
    const retained: RetainedPark[] = [];
    for (const park of previousParks) {
      if (!claimed.has(park.id) || !park.scene) continue;
      const nextPark = nextParks.get(park.id);
      const sceneFile = previousFiles.find((file) => file.path === `art/badges/scenes/${park.scene}.webp`);
      if (!sceneFile) continue;
      const nextFile = nextFiles.get(sceneFile.path);
      if (nextPark?.scene === park.scene && nextFile?.key === sceneFile.key && nextFile.sha256 === sceneFile.sha256) continue;
      const releaseId = versionFromAssetKey(sceneFile, park.scene);
      if (releaseId) {
        const archived = { releaseId, scene: park.scene, file: sceneFile };
        assertArchivedSceneDescriptor(archived);
        await this.options.store.retainArchivedScene(archived);
      }
      if (nextPark?.scene !== park.scene) retained.push({ park, sceneFile });
    }
    if (retained.length) await this.options.store.retainParks(retained);
  }

  private async publishSyncState(state: ContentSyncState, phase: ContentPhase, error: string | null, beforePublish?: () => void): Promise<void> {
    const retainedProjectionRevision = this.retainedProjectionRevision;
    const validated = this.withBuildMap(validateContentSyncState(state));
    let inventory: ContentMapInventory | null = null;
    if (validated.map) inventory = await this.getVerifiedMapInventory(validated.map.version);
    if (inventory) this.mapInventories.set(inventory.version, inventory);
    const legacy = inventory || validated.map ? null : await this.getLegacyMapRelease();
    const mapFiles = inventory?.files ?? legacy?.manifest.files.filter((file) => file.path.startsWith("map/")) ?? [];
    const mapManifest = inventory?.mapManifest ?? legacy?.manifest.mapManifest ?? { size: 1, chunkBytes: 1, count: 1 };
    const mapVersion = validated.map?.version ?? inventory?.version ?? legacy?.manifest.version ?? "pending";
    const releaseId = `sync-${this.environment}-${validated.revision}-${mapVersion}`;
    const manifest: ContentManifest = {
      version: mapVersion,
      sourceCommit: "0".repeat(40),
      cdnOrigin: "https://kip-assets.parkdex.app",
      files: [...validated.assets, ...mapFiles],
      parkIds: validated.parks.map((park) => park.id),
      boundaryIds: validated.boundaries.features.map((feature) => feature.properties.id),
      mapManifest,
    };
    this.syncManifests.set(releaseId, manifest);

    const assetUrls = new Map<string, string>();
    const remoteSceneUrls = new Map<string, string>();
    const required = new Set(this.requiredAssets(validated).map((file) => file.path));
    const sceneFiles = validated.parks.flatMap((park) => {
      if (!park.scene) return [];
      const path = `art/badges/scenes/${park.scene}.webp`;
      const file = validated.assets.find((entry) => entry.path === path);
      if (!file) throw new Error(`Required park badge descriptor is missing: ${path}`);
      return [file];
    });
    // Read badge art concurrently: one at a time over the native bridge held the
    // map behind the loading card for many seconds on every cold start.
    await Promise.all(sceneFiles.map(async (file) => {
      remoteSceneUrls.set(file.path, file.url);
      if (!(await this.hasVerifiedLocalFile(file))) {
        if (required.has(file.path)) throw new Error(`Required park badge art is missing: ${file.path}`);
        return;
      }
      assetUrls.set(file.path, await this.localFileUrl(file));
    }));
    let retained: RetainedPark[] = [];
    try {
      retained = await this.options.store.getRetainedParks();
    } catch {
      // Retained badge metadata is optional for current-catalogue readiness.
    }
    retained = retained.filter((entry) => !!entry?.park && typeof entry.park.id === "string");
    const currentIds = new Set(validated.parks.map((park) => park.id));
    const claimedForVerification = new Set(this.options.claimedParkIds());
    const retainedSceneUrls = new Map<string, string>();
    for (const entry of retained) {
      if (!entry?.park || typeof entry.park.id !== "string" || !claimedForVerification.has(entry.park.id) || currentIds.has(entry.park.id) || !entry.sceneFile) continue;
      try {
        if (await this.hasVerifiedLocalFile(entry.sceneFile)) retainedSceneUrls.set(entry.park.id, await this.localFileUrl(entry.sceneFile));
      } catch {
        // A missing retired badge must not block the current catalogue.
      }
    }
    this.syncState = validated;
    const fullMapReady = false;
    const claimedAtPublication = new Set(this.options.claimedParkIds());
    const retiredParks = retained
      .filter((entry) => claimedAtPublication.has(entry.park.id) && !currentIds.has(entry.park.id))
      .map((entry) => entry.park);
    const parkById = new Map([...validated.parks, ...retiredParks].map((park) => [park.id, park]));
    const publishedRetainedSceneUrls = new Map(
      [...retainedSceneUrls].filter(([parkId]) => claimedAtPublication.has(parkId) && !currentIds.has(parkId)),
    );
    const snapshot: ContentSnapshot = {
      releaseId,
      generation: validated.revision,
      manifest,
      parks: validated.parks,
      parkById,
      liveParks: validated.parks.filter((park) => park.scene !== null),
      retiredParks,
      boundaries: validated.boundaries,
      drive: validated.drive,
      assetUrls,
      remoteSceneUrls,
      retainedSceneUrls: publishedRetainedSceneUrls,
    };
    this.artworkReadyReleases.add(releaseId);
    const glyphFiles = inventory?.files.filter((file) => file.path.startsWith("map/fonts/")) ?? legacy?.manifest.files.filter((file) => file.path.startsWith("map/fonts/")) ?? [];
    const hasMapManifest = !!(inventory || legacy);
    const glyphChecks = await Promise.all(glyphFiles.map(async (file) => {
      try { return await this.hasVerifiedLocalFile(file); }
      catch { return false; }
    }));
    const allGlyphsVerified = hasMapManifest && glyphFiles.length > 0 && glyphChecks.every(Boolean);
    const mapDetailReady = hasMapManifest && allGlyphsVerified;
    const previousReleaseId = this.status.snapshot?.releaseId;
    const previousGeneration = this.status.snapshot?.generation;
    if (previousReleaseId && previousReleaseId !== releaseId && previousGeneration !== snapshot.generation) {
      const reason = new DOMException("Map catalogue changed", "AbortError");
      this.mapAbort?.abort(reason);
      this.nearbyAbort?.abort(reason);
      for (const [oldReleaseId, controller] of this.bulkControllers) {
        if (oldReleaseId !== releaseId) controller.abort(reason);
      }
    }
    beforePublish?.();
    this.setStatus({ snapshot, phase, syncStage: "idle", fullMapReady, mapDetailReady, error, waitingForWifi: this.waitingForUpdateWifi || this.waitingForBulkWifi });
    if (retainedProjectionRevision !== this.retainedProjectionRevision) this.refreshClaimedParks();
    void this.hydrateCachedMapChunks(validated, releaseId).catch(() => {});
    this.scheduleNearbyArt();
  }

  /** Download badge art for parks around the visitor, then point those badges at the saved copies. */
  private scheduleNearbyArt(): void {
    const point = this.currentLocation;
    const state = this.syncState;
    if (!point || !state || !this.status.snapshot || this.nearbyArtPromise || this.stopped || !this.foreground) return;
    if (!this.connectivity().connected || !this.canDownloadContent()) return;
    if (this.nearbyArtAnchor && distanceKm(this.nearbyArtAnchor, point) < NEARBY_ART_MOVE_KM) return;
    const work = (async () => {
      const missing: ContentFile[] = [];
      for (const file of this.requiredAssets(state)) {
        if (!(await this.hasVerifiedLocalFile(file))) missing.push(file);
      }
      const results = await Promise.allSettled(missing.map((file) => this.scheduleFileDownload(file, "nearby")));
      await this.refreshLocalSceneUrls();
      if (results.every((result) => result.status === "fulfilled")) this.nearbyArtAnchor = point;
    })();
    this.nearbyArtPromise = work.catch(() => {}).finally(() => {
      this.nearbyArtPromise = null;
    });
  }

  /** Swap CDN art for saved copies that finished downloading after the catalogue was shown. */
  private async refreshLocalSceneUrls(): Promise<void> {
    const snapshot = this.status.snapshot;
    const state = this.syncState;
    if (!snapshot || !state) return;
    const found: [string, string][] = [];
    for (const file of state.assets) {
      if (!file.path.startsWith(SCENE_PREFIX) || snapshot.assetUrls.has(file.path)) continue;
      try {
        if (await this.hasVerifiedLocalFile(file)) found.push([file.path, await this.localFileUrl(file)]);
      } catch {
        // The CDN copy keeps showing until the saved file can be read.
      }
    }
    const current = this.status.snapshot;
    if (!found.length || !current || current.releaseId !== snapshot.releaseId) return;
    this.setStatus({ snapshot: { ...current, assetUrls: new Map([...current.assetUrls, ...found]) } });
  }

  private hydrateCachedSnapshotInBackground(state: ContentSyncState, releaseId: string): void {
    void this.hydrateCachedRetainedParks(state, releaseId, this.retainedProjectionRevision).catch(() => {});
    void this.hydrateCachedMapChunks(state, releaseId).catch(() => {});
  }

  private async hydrateCachedRetainedParks(state: ContentSyncState, releaseId: string, projectionRevision: number): Promise<void> {
    const retained = await this.options.store.getRetainedParks();
    if (!this.isCurrentCachedSnapshot(state, releaseId) || projectionRevision !== this.retainedProjectionRevision) return;
    const currentIds = new Set(state.parks.map((park) => park.id));
    const claimed = new Set(this.options.claimedParkIds());
    const retiredParks = retained.filter((entry) => claimed.has(entry.park.id) && !currentIds.has(entry.park.id)).map((entry) => entry.park);
    const retainedFiles = retained
      .filter((entry) => claimed.has(entry.park.id) && !currentIds.has(entry.park.id) && entry.sceneFile)
      .map((entry) => ({ parkId: entry.park.id, file: entry.sceneFile! }));
    const retainedUrls = await this.verifyFilesBounded(retainedFiles, 6, async ({ file }) => {
      try {
        return await this.hasVerifiedLocalFile(file) ? await this.localFileUrl(file) : null;
      } catch {
        return null;
      }
    });
    if (!this.isCurrentCachedSnapshot(state, releaseId) || projectionRevision !== this.retainedProjectionRevision) return;
    const snapshot = this.status.snapshot;
    if (!snapshot) return;
    const parkById = new Map([...snapshot.parks, ...retiredParks].map((park) => [park.id, park]));
    const retainedSceneUrls = new Map(snapshot.retainedSceneUrls);
    for (let index = 0; index < retainedFiles.length; index += 1) {
      const url = retainedUrls[index];
      if (url) retainedSceneUrls.set(retainedFiles[index]!.parkId, url);
    }
    this.setStatus({ snapshot: { ...snapshot, parkById, retiredParks, retainedSceneUrls } });
  }

  private async hydrateCachedMapChunks(state: ContentSyncState, releaseId: string): Promise<void> {
    const manifest = this.syncManifests.get(releaseId);
    if (!manifest || !manifest.files.some((file) => file.path.startsWith("map/"))) return;
    const mapFile = mapLayoutFile(manifest.files);
    if (!mapFile || !(await this.hasVerifiedLocalFile(mapFile))) return;
    try {
      parseMapFile(await this.options.store.readFile(mapFile.sha256), manifest.mapManifest);
    } catch {
      this.invalidateLocalFile(mapFile);
      return;
    }
    const glyphFiles = manifest.files.filter((file) => file.path.startsWith("map/fonts/"));
    const glyphsVerified = glyphFiles.length > 0 && (await Promise.all(glyphFiles.map((file) => this.hasVerifiedLocalFile(file)))).every(Boolean);
    if (!this.isCurrentCachedSnapshot(state, releaseId)) return;
    this.setStatus({ mapDetailReady: glyphsVerified });
    const chunks = mapChunkFiles(manifest);
    const checked = await this.verifyFilesBounded(chunks, 6, async (file) => {
      try { return await this.hasVerifiedLocalFile(file) ? file : null; }
      catch { return null; }
    });
    if (!this.isCurrentCachedSnapshot(state, releaseId)) return;
    const allowed = chunkIndices(checked.filter((file): file is ContentFile => file !== null));
    setAllowedMapChunks(releaseId, allowed);
    this.setStatus({ fullMapReady: chunks.length > 0 && allowed.length === chunks.length });
  }

  private async verifyFilesBounded<TFile, TResult>(
    files: readonly TFile[],
    concurrency: number,
    verify: (file: TFile) => Promise<TResult>,
  ): Promise<TResult[]> {
    const results = new Array<TResult>(files.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      while (nextIndex < files.length) {
        const index = nextIndex++;
        results[index] = await verify(files[index]!);
      }
    });
    await Promise.all(workers);
    return results;
  }

  private isCurrentCachedSnapshot(state: ContentSyncState, releaseId: string): boolean {
    return !this.stopped && this.status.snapshot?.releaseId === releaseId &&
      this.syncState?.revision === state.revision && this.syncState.sourceId === state.sourceId;
  }

  private async getLegacyMapRelease(): Promise<StoredRelease | null> {
    try {
      const id = this.legacyMapReleaseId ?? await this.options.store.getActiveId();
      if (!id) return null;
      const stored = await this.options.store.getRelease(id);
      if (!stored) return null;
      const channel = parseContentChannel(stored.channel, this.environment);
      const manifest = parseContentManifest(stored.manifest, channel);
      this.legacyMapReleaseId = id;
      return { ...stored, channel, manifest };
    } catch {
      return null;
    }
  }

  private async getVerifiedMapInventory(version: string): Promise<ContentMapInventory | null> {
    let cached: ContentMapInventory | null;
    try {
      cached = this.mapInventories.get(version) ?? await this.options.store.getMapInventory(version);
    } catch {
      return null;
    }
    if (!cached) return null;
    try {
      const inventory = parseContentMapInventory(cached, version);
      const manifestFile = mapLayoutFile(inventory.files);
      if (!manifestFile || !(await this.hasVerifiedLocalFile(manifestFile))) return null;
      parseMapFile(await this.options.store.readFile(manifestFile.sha256), inventory.mapManifest);
      return inventory;
    } catch {
      let manifestFile: ContentFile | undefined;
      try {
        if (cached && Array.isArray(cached.files)) manifestFile = mapLayoutFile(cached.files);
      } catch {
        // The cache descriptor itself can be malformed.
      }
      if (manifestFile) this.invalidateLocalFile(manifestFile);
      return null;
    }
  }

  private startMapSync(): void {
    if (!this.hasSyncApi() || this.options.apiUrl === null || !this.initialized || this.stopped || !this.foreground || !this.syncState) return;
    const snapshot = this.status.snapshot;
    if (!snapshot || !this.artworkReadyReleases.has(snapshot.releaseId)) return;
    const pointer = this.syncState.map;
    if (!pointer) return;
    if (this.mapSyncPromise && this.mapSyncVersion === pointer.version) return;
    this.mapAbort?.abort(new DOMException("Map inventory changed", "AbortError"));
    const controller = new AbortController();
    this.mapAbort = controller;
    this.mapSyncVersion = pointer.version;
    const work = this.runMapSync(pointer, controller.signal);
    this.mapSyncPromise = work;
    void work.catch(() => {
      // Map inventory and chunks are optional for catalogue activation.
    }).finally(() => {
      if (this.mapSyncPromise === work) this.mapSyncPromise = null;
      if (this.mapAbort === controller) this.mapAbort = null;
      this.updateWaitingStatus();
      if (this.mapRetryRequested && !this.stopped && this.foreground && this.canDownloadContent() && this.syncState?.map?.version === pointer.version) {
        this.mapRetryRequested = false;
        this.startMapSync();
      }
    });
  }

  private async runMapSync(pointer: ContentMapPointer, signal: AbortSignal): Promise<void> {
    if (!this.canDownloadContent()) return;
    let inventory = await this.getVerifiedMapInventory(pointer.version);
    if (!inventory) {
      const response = await this.requestContent(pointer.manifestUrl, signal);
      if (!response.ok) throw new Error(`Map inventory returned HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if ((await sha256Hex(bytes)) !== pointer.manifestSha256) throw new ContentValidationError("map inventory failed SHA-256 verification");
      inventory = parseContentMapInventory(parseJsonBytes(bytes), pointer.version);
      const innerManifest = mapLayoutFile(inventory.files);
      if (!innerManifest) throw new ContentValidationError("map inventory has no chunk layout");
      await this.scheduleFileDownload(innerManifest, "bulk", signal);
      parseMapFile(await this.options.store.readFile(innerManifest.sha256), inventory.mapManifest);
      await this.options.store.putMapInventory(inventory);
      this.mapInventories.set(inventory.version, inventory);
    }
    if (signal.aborted) throw signal.reason ?? new DOMException("Map sync cancelled", "AbortError");
    if (this.syncState?.map?.version !== pointer.version) return;
    const glyphs = inventory.files.filter((file) => file.path.startsWith("map/fonts/"));
    await Promise.all(glyphs.map((file) => this.scheduleFileDownload(file, "bulk", signal)));
    if (signal.aborted) throw signal.reason ?? new DOMException("Map sync cancelled", "AbortError");
    if (this.stopped || !this.foreground) return;
    if (this.syncState?.map?.version !== pointer.version) return;
    this.publishMapInventory(pointer, inventory);
    this.waitingForBulkWifi = this.isWaitingForWifi();
    this.updateWaitingStatus();
    const snapshot = this.status.snapshot;
    if (!snapshot || !this.artworkReadyReleases.has(snapshot.releaseId)) return;
    await prefetchMapArea(this, snapshot.releaseId, this.mapAnchor(), "starter", signal, snapshot);
    if (signal.aborted || this.syncState?.map?.version !== pointer.version) return;
    this.startBulkMap(snapshot.releaseId);
    this.scheduleNearbyPrefetch(false);
  }

  private publishMapInventory(pointer: ContentMapPointer, inventory: ContentMapInventory): void {
    const state = this.syncState;
    const current = this.status.snapshot;
    if (!state || !current || state.map?.version !== pointer.version || current.generation !== state.revision ||
      !this.artworkReadyReleases.has(current.releaseId)) return;
    this.mapInventories.set(inventory.version, inventory);
    const manifest: ContentManifest = {
      ...current.manifest,
      version: inventory.version,
      files: [...state.assets, ...inventory.files],
      mapManifest: inventory.mapManifest,
    };
    this.syncManifests.set(current.releaseId, manifest);
    this.setStatus({ snapshot: { ...current, manifest }, mapDetailReady: true });
    void this.hydrateCachedMapChunks(state, current.releaseId).catch(() => {});
  }

  private get foreground() {
    // Web starts visible by default. Native lifecycle wiring sets this explicitly.
    return this.policyForeground;
  }

  private policyForeground = true;

  private allowMobileMapData = false;

  private currentPolicy(): DownloadPolicy {
    return { foreground: this.policyForeground, connectivity: this.connectivity(), allowMobileMapData: this.allowMobileMapData };
  }

  /** Let chosen map squares and the area around the visitor download on mobile data. */
  setAllowMobileMapData(allowed: boolean): void {
    if (this.stopped || this.allowMobileMapData === allowed) return;
    this.allowMobileMapData = allowed;
    this.scheduler.setPolicy(this.currentPolicy());
  }

  private connectivity(): Connectivity {
    return this.options.connectivity ?? { connected: true, wifi: false };
  }

  private canDownloadContent(): boolean {
    return canDownloadContent(this.connectivity());
  }

  private isWaitingForWifi(): boolean {
    return isWaitingForContentWifi(this.connectivity());
  }

  private contentUnavailableError(): Error {
    const connected = this.connectivity().connected;
    const error = new Error(connected
      ? "Park content downloads are unavailable in the current network settings."
      : "Content downloads are unavailable while offline.");
    error.name = connected ? "ContentDownloadUnavailableError" : "ContentOfflineError";
    return error;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private scheduleSyncRetry(): void {
    if (this.syncRetryTimer || this.stopped || !this.foreground || !this.canDownloadContent()) return;
    const delay = Math.min(SYNC_RETRY_BASE_MS * (2 ** this.syncRetryAttempt), SYNC_RETRY_MAX_MS);
    this.syncRetryAttempt += 1;
    this.syncRetryTimer = globalThis.setTimeout(() => {
      this.syncRetryTimer = null;
      if (!this.stopped && this.initialized && this.foreground && this.canDownloadContent()) {
        void this.syncContent(true, false);
      }
    }, delay);
  }

  private clearSyncRetry(resetAttempt = false): void {
    if (this.syncRetryTimer) globalThis.clearTimeout(this.syncRetryTimer);
    this.syncRetryTimer = null;
    if (resetAttempt) this.syncRetryAttempt = 0;
  }

  private async checkCurrentRelease(force: boolean): Promise<void> {
    if (this.hasSyncApi()) {
      await this.syncContent(force, false);
      return;
    }
    if (this.stopped || !this.initialized || !this.foreground || !this.canDownloadContent()) {
      if (this.initialized && this.isWaitingForWifi()) this.setStatus({ syncStage: "waiting-for-wifi", waitingForWifi: true });
      return;
    }
    if (this.discoveryPromise) return this.discoveryPromise;
    const now = this.now();
    if (!force && now - this.lastDiscoveryAt < DISCOVERY_COOLDOWN_MS) return;
    this.lastDiscoveryAt = now;
    const work = this.discoverCurrentRelease();
    this.discoveryPromise = work;
    try {
      await work;
    } finally {
      if (this.discoveryPromise === work) this.discoveryPromise = null;
    }
  }

  private async discoverCurrentRelease(): Promise<void> {
    try {
      const discoveryUrl = this.options.discoveryUrl;
      if (!discoveryUrl) throw new Error("Content discovery URL is not configured");
      const headers: Record<string, string> = {};
      if (this.discoveryEtag) headers["If-None-Match"] = this.discoveryEtag;
      const response = await this.fetcher(discoveryUrl, { headers, cache: "no-store" });
      const nextEtag = response.headers.get("ETag");
      if (nextEtag) this.discoveryEtag = nextEtag;
      if (response.status === 304) {
        await this.resumeStoredCandidate();
        return;
      }
      if (!response.ok) throw new Error(`Content discovery returned HTTP ${response.status}`);
      const channel = parseEnvironment(await response.json(), this.environment);
      this.latestChannel = channel;
      await this.processChannel(channel);
    } catch (error) {
      if (!this.stopped) this.setStatus({ phase: "error", error: errorText(error) });
    }
  }

  private async processChannel(channel: ContentChannel): Promise<void> {
    const current = this.candidatePromises.get(channel.releaseId);
    if (current) return current;
    const work = this.processChannelOnce(channel);
    this.candidatePromises.set(channel.releaseId, work);
    try {
      await work;
    } finally {
      if (this.candidatePromises.get(channel.releaseId) === work) this.candidatePromises.delete(channel.releaseId);
    }
  }

  private async processChannelOnce(channel: ContentChannel): Promise<void> {
    if (this.stopped) return;
    const activeId = await this.options.store.getActiveId();
    const active = activeId ? await this.options.store.getRelease(activeId) : undefined;
    if (activeId && !active) throw new Error("The active content release record is missing");
    if (active && channel.generation < active.channel.generation) return;
    if (active && channel.generation === active.channel.generation && channel.releaseId !== activeId) {
      throw new ContentValidationError("content channel changed release without advancing its generation");
    }

    const existing = await this.options.store.getRelease(channel.releaseId);
    if (activeId === channel.releaseId && active!.channel.manifestSha256 !== channel.manifestSha256) {
      throw new ContentValidationError("an active immutable release changed its manifest hash");
    }
    const manifest = await this.loadManifest(channel, existing);
    if (activeId === channel.releaseId) {
      const updated = { ...active!, channel, manifest };
      await this.options.store.putRelease(updated);
      await this.ensureFiles(coreFiles(manifest), channel.releaseId, "core");
      const payload = await this.readAndValidatePayload(updated, manifest);
      const refreshed = await this.prepareSnapshot({ ...updated, payload }, payload);
      this.publishSnapshot(refreshed, phaseForActive(this.connectivity().connected), null);
      await this.options.store.putRelease({ ...updated, payload, healthy: true });
      await this.refreshMapReadiness(refreshed);
      return;
    }

    if (active && channel.generation <= active.channel.generation) return;
    let candidate: StoredRelease = existing
      ? { ...existing, channel, manifest, healthy: false, readiness: "candidate" }
      : { id: channel.releaseId, channel, manifest, readiness: "candidate", healthy: false };
    await this.options.store.putRelease(candidate);
    this.setStatus({ phase: activeId ? "updating" : "downloading", error: null, waitingForWifi: false });
    const initialFiles = coreFiles(manifest);
    await this.ensureFiles(initialFiles, candidate.id, active ? "update" : "core");
    const payload = await this.readAndValidatePayload(candidate, manifest);
    candidate = { ...candidate, payload, readiness: "candidate", healthy: false };
    await this.options.store.putRelease(candidate);

    if (!active) {
      const snapshot = await this.prepareSnapshot(candidate, payload);
      await prefetchMapArea(this, candidate.id, this.mapAnchor(), "starter", undefined, snapshot);
      candidate = { ...candidate, readiness: "starter" };
      await this.options.store.putRelease(candidate);
    } else {
      const files = remoteFiles(manifest);
      const missingChunks = await this.missingFiles(mapChunkFiles(manifest));
      this.waitingForUpdateWifi = missingChunks.length > 0 && this.isWaitingForWifi();
      this.updateWaitingStatus();
      await this.ensureFiles(files, candidate.id, "update");
      const snapshot = await this.prepareSnapshot(candidate, payload);
      const chunkIds = chunkIndices(mapChunkFiles(manifest));
      setAllowedMapChunks(candidate.id, chunkIds);
      await prefetchMapArea(this, candidate.id, this.mapAnchor(), "starter", undefined, snapshot);
      candidate = { ...candidate, readiness: "complete" };
      await this.options.store.putRelease(candidate);
    }
    if (this.busy) {
      this.pendingActivationId = candidate.id;
      this.setStatus({ phase: active ? "updating" : "downloading", error: null });
      return;
    }
    await this.activateCandidate(candidate.id);
  }

  private async loadManifest(channel: ContentChannel, existing?: StoredRelease): Promise<ContentManifest> {
    if (existing && existing.channel.manifestSha256 === channel.manifestSha256) {
      const storedChannel = parseContentChannel(existing.channel, this.environment);
      return parseContentManifest(existing.manifest, storedChannel);
    }
    const response = await this.fetcher(channel.manifestUrl, { cache: "force-cache" });
    if (!response.ok) throw new Error(`Content manifest returned HTTP ${response.status}`);
    assertUnredirected(response, channel.manifestUrl, "Content manifest");
    const bytes = await response.arrayBuffer();
    if ((await sha256Hex(bytes)) !== channel.manifestSha256) throw new ContentValidationError("content manifest failed SHA-256 verification");
    return parseContentManifest(parseJsonBytes(bytes), channel);
  }

  private async readAndValidatePayload(release: StoredRelease, manifest: ContentManifest): Promise<ContentPayload> {
    const layout = mapLayoutFile(manifest.files);
    if (!layout) throw new ContentValidationError("content manifest has no map chunk layout");
    const mapManifestBytes = await this.readFile(release.id, layout.path);
    parseMapFile(mapManifestBytes, manifest.mapManifest);
    const parks = parseJsonBytes(await this.readFile(release.id, "data/parks.json"));
    const boundaries = parseJsonBytes(await this.readFile(release.id, "boundaries.geojson"));
    const drive = parseJsonBytes(await this.readFile(release.id, "data/drive.json"));
    return validateContentPayload(parks, boundaries, drive, manifest);
  }

  private async ensureFiles(files: ContentFile[], releaseId: string, purpose: "core" | "update" | "bulk", outerSignal?: AbortSignal): Promise<void> {
    const batch = new AbortController();
    const abortBatch = () => batch.abort(outerSignal?.reason);
    if (outerSignal?.aborted) abortBatch();
    else outerSignal?.addEventListener("abort", abortBatch, { once: true });
    try {
      await Promise.all(files.map((file) => this.ensureFile(releaseId, file.path, purpose, batch.signal).catch((error) => {
        batch.abort(error);
        throw error;
      })));
    } catch (error) {
      batch.abort(error);
      throw error;
    } finally {
      outerSignal?.removeEventListener("abort", abortBatch);
    }
  }

  private async missingFiles(files: ContentFile[]): Promise<ContentFile[]> {
    const result: ContentFile[] = [];
    for (const file of files) if (!(await this.hasVerifiedLocalFile(file))) result.push(file);
    return result;
  }

  private async hasVerifiedLocalFile(file: ContentFile): Promise<boolean> {
    const key = fileKey(file.sha256, file.byte_size);
    if (this.verifiedHashes.has(key)) return true;
    let check = this.localFileCheckPromises.get(key);
    if (!check) {
      check = this.options.store.hasFile(file.sha256, file.byte_size).then((exists) => {
        if (exists) {
          this.verifiedHashes.add(key);
          this.localFileSizes.set(file.sha256, file.byte_size);
          this.refreshProgress();
        }
        return exists;
      }).finally(() => this.localFileCheckPromises.delete(key));
      this.localFileCheckPromises.set(key, check);
    }
    return check;
  }

  private async downloadFile(file: ContentFile, signal: AbortSignal, purpose: DownloadPurpose = "core"): Promise<void> {
    const hash = fileKey(file.sha256, file.byte_size);
    this.incrementInFlight(file.sha256);
    try {
      if (signal.aborted) throw signal.reason ?? new DOMException("Download cancelled", "AbortError");
      this.activeDownloads += 1;
      this.setStatus({ activeDownloads: this.activeDownloads });
      let bytes: ArrayBuffer;
      try {
        // Nearby and streamed map detail may use mobile data; other map chunks wait for Wi-Fi.
        const init: ContentRequestInit = {
          signal,
          cache: "force-cache",
          anyNetwork: purpose === "nearby" || (purpose === "bulk" && this.allowMobileMapData),
        };
        const response = await this.fetcher(file.url, init);
        if (!response.ok) throw new Error(`Content file ${file.path} returned HTTP ${response.status}`);
        assertUnredirected(response, file.url, `Content file ${file.path}`);
        bytes = await response.arrayBuffer();
      } finally {
        this.activeDownloads = Math.max(0, this.activeDownloads - 1);
        this.setStatus({ activeDownloads: this.activeDownloads });
      }
      await assertFileBytes(file, bytes);
      await this.options.store.putFile(file.sha256, bytes);
      this.verifiedHashes.add(hash);
      this.localFileSizes.set(file.sha256, file.byte_size);
      this.refreshProgress();
      await this.refreshMapReadinessForHash(file.sha256);
    } finally {
      this.decrementInFlight(file.sha256);
    }
  }

  private async hydrateStoredRelease(release: StoredRelease): Promise<ContentSnapshot> {
    const channel = parseContentChannel(release.channel, this.environment);
    const manifest = parseContentManifest(release.manifest, channel);
    await this.ensureFiles(coreFiles(manifest), release.id, "core");
    const payload = await this.readAndValidatePayload(release, manifest);
    const hydrated = { ...release, channel, manifest, payload };
    const snapshot = await this.prepareSnapshot(hydrated, payload);
    await this.options.store.putRelease(hydrated);
    return snapshot;
  }

  private async prepareSnapshot(release: StoredRelease, payload: ContentPayload): Promise<ContentSnapshot> {
    const retained = await this.options.store.getRetainedParks();
    const currentIds = new Set(payload.parks.map((park) => park.id));
    const claimed = new Set(this.options.claimedParkIds());
    const retiredParks = retained.filter((entry) => claimed.has(entry.park.id) && !currentIds.has(entry.park.id)).map((entry) => entry.park);
    const parks = payload.parks;
    const parkById = new Map([...parks, ...retiredParks].map((park) => [park.id, park]));
    const assetUrls = new Map<string, string>();
    for (const file of coreFiles(release.manifest)) {
      if (!(await this.hasVerifiedLocalFile(file))) {
        throw new Error(`Required park content is missing: ${file.path}`);
      }
      assetUrls.set(file.path, await this.localFileUrl(file));
    }
    const locallyPresentChunks: ContentFile[] = [];
    for (const file of mapChunkFiles(release.manifest)) {
      if (await this.hasVerifiedLocalFile(file)) locallyPresentChunks.push(file);
    }
    if (locallyPresentChunks.length) {
      setAllowedMapChunks(release.id, chunkIndices(locallyPresentChunks));
    }
    const retainedSceneUrls = new Map<string, string>();
    for (const entry of retained) {
      if (!claimed.has(entry.park.id) || currentIds.has(entry.park.id) || !entry.sceneFile) continue;
      if (!(await this.hasVerifiedLocalFile(entry.sceneFile))) continue;
      retainedSceneUrls.set(entry.park.id, await this.localFileUrl(entry.sceneFile));
    }
    return {
      releaseId: release.id,
      generation: release.channel.generation,
      manifest: release.manifest,
      parks,
      parkById,
      liveParks: payload.parks.filter((park) => park.scene !== null),
      retiredParks,
      boundaries: payload.boundaries,
      drive: payload.drive,
      assetUrls,
      retainedSceneUrls,
    };
  }

  private async localFileUrl(file: ContentFile): Promise<string> {
    const key = `${file.sha256}:${file.content_type}`;
    let promise = this.fileUrlPromises.get(key);
    if (!promise) {
      promise = this.options.store.fileUrl(file.sha256, file.content_type);
      this.fileUrlPromises.set(key, promise);
    }
    try {
      return await promise;
    } catch (error) {
      if (this.fileUrlPromises.get(key) === promise) this.fileUrlPromises.delete(key);
      this.invalidateLocalFile(file);
      throw error;
    }
  }

  private invalidateLocalFile(file: ContentFile): void {
    const key = fileKey(file.sha256, file.byte_size);
    this.verifiedHashes.delete(key);
    this.localFileSizes.delete(file.sha256);
    this.localFileCheckPromises.delete(key);
    this.fileUrlPromises.delete(`${file.sha256}:${file.content_type}`);
    this.refreshProgress();
  }

  private async retainRemovedClaimedParks(previous: StoredRelease | undefined, nextPayload: ContentPayload): Promise<void> {
    if (!previous?.payload) return;
    const nextIds = new Set(nextPayload.parks.map((park) => park.id));
    const claims = new Set(this.options.claimedParkIds());
    const retained: RetainedPark[] = [];
    for (const park of previous.payload.parks) {
      if (!claims.has(park.id) || nextIds.has(park.id)) continue;
      const sceneFile = park.scene ? previous.manifest.files.find((file) => file.path === `art/badges/scenes/${park.scene}.webp`) : undefined;
      if (sceneFile) {
        if (!(await this.hasVerifiedLocalFile(sceneFile))) await this.ensureFile(previous.id, sceneFile.path, "core");
      }
      retained.push({ park, sceneFile });
    }
    if (retained.length) await this.options.store.retainParks(retained);
  }

  private async activatePending(): Promise<void> {
    const id = this.pendingActivationId;
    if (!id || this.busy || !this.foreground || this.stopped) return;
    this.pendingActivationId = null;
    try {
      await this.activateCandidate(id);
    } catch (error) {
      if (!this.stopped) this.setStatus({ phase: "error", error: errorText(error) });
    }
  }

  private async activateCandidate(id: string): Promise<void> {
    if (this.busy || !this.foreground || this.stopped) {
      this.pendingActivationId = id;
      return;
    }
    const candidate = await this.options.store.getRelease(id);
    if (!candidate?.payload || candidate.readiness === "candidate") throw new Error("Content candidate is not fully prepared");
    const expectedActiveId = await this.options.store.getActiveId();
    const previous = expectedActiveId ? await this.options.store.getRelease(expectedActiveId) : undefined;
    this.nearbyAbort?.abort();
    if (this.nearbyTimer !== undefined) globalThis.clearTimeout(this.nearbyTimer);
    this.nearbyTimer = undefined;
    if (this.nearbyPromise) await Promise.allSettled([this.nearbyPromise]);
    await this.retainRemovedClaimedParks(previous, candidate.payload);
    const snapshot = await this.prepareSnapshot(candidate, candidate.payload);
    await this.options.store.activateRelease(id, expectedActiveId);
    this.publishSnapshot(snapshot, phaseForActive(this.connectivity().connected), null);
    try {
      await this.options.store.putRelease({ ...candidate, healthy: true });
    } catch (error) {
      // The active pointer is already durable. Startup will rehydrate and mark it healthy.
      this.setStatus({ phase: phaseForActive(this.connectivity().connected), error: errorText(error) });
      return;
    }
    this.waitingForUpdateWifi = false;
    this.pendingActivationId = null;
    for (const [oldReleaseId, controller] of this.bulkControllers) {
      if (oldReleaseId !== id) controller.abort();
    }
    await Promise.allSettled([...this.bulkPromises.entries()].filter(([oldReleaseId]) => oldReleaseId !== id).map(([, promise]) => promise));
    await this.refreshMapReadiness(snapshot);
    this.startBulkMap(id);
    this.scheduleNearbyPrefetch(false);
  }

  private publishSnapshot(snapshot: ContentSnapshot, phase: ContentPhase, error: string | null): void {
    const claimed = new Set(this.options.claimedParkIds());
    const currentIds = new Set(snapshot.parks.map((park) => park.id));
    const retiredParks = snapshot.retiredParks.filter((park) => claimed.has(park.id));
    const currentSnapshot = {
      ...snapshot,
      retiredParks,
      parkById: new Map([...snapshot.parks, ...retiredParks].map((park) => [park.id, park])),
      retainedSceneUrls: new Map([...snapshot.retainedSceneUrls].filter(([parkId]) => claimed.has(parkId) && !currentIds.has(parkId))),
    };
    this.artworkReadyReleases.add(snapshot.releaseId);
    this.setStatus({ snapshot: currentSnapshot, phase, error, waitingForWifi: this.waitingForUpdateWifi || this.waitingForBulkWifi });
  }

  private scheduleNearbyPrefetch(force: boolean): void {
    if (!this.foreground || !this.connectivity().connected || !this.status.snapshot || !this.currentLocation || this.stopped) return;
    const snapshot = this.status.snapshot;
    if (!this.artworkReadyReleases.has(snapshot.releaseId)) return;
    if (this.hasSyncApi() && !this.status.mapDetailReady) return;
    const point = this.currentLocation;
    if (!isPointInsideContentBounds(point)) return;
    if (!force && this.nearbyAnchor?.releaseId === snapshot.releaseId && distanceKm(this.nearbyAnchor.point, point) < LOCATION_MOVE_THRESHOLD_KM) return;
    const activeRequest = this.nearbyRequest;
    if (!force && activeRequest?.releaseId === snapshot.releaseId && !activeRequest.controller.signal.aborted &&
      distanceKm(activeRequest.point, point) < LOCATION_MOVE_THRESHOLD_KM) return;
    if (this.nearbyTimer !== undefined) globalThis.clearTimeout(this.nearbyTimer);
    this.nearbyAbort?.abort();
    const controller = new AbortController();
    const request = { releaseId: snapshot.releaseId, point, controller };
    this.nearbyAbort = controller;
    this.nearbyRequest = request;
    const signal = controller.signal;
    this.nearbyTimer = globalThis.setTimeout(() => {
      this.nearbyTimer = undefined;
      const currentSnapshot = this.status.snapshot;
      if (this.nearbyRequest !== request || signal.aborted || !currentSnapshot || currentSnapshot.releaseId !== request.releaseId ||
        !this.artworkReadyReleases.has(currentSnapshot.releaseId) || (this.hasSyncApi() && !this.status.mapDetailReady) ||
        this.stopped || !this.foreground || !this.connectivity().connected) {
        if (this.nearbyRequest === request) this.nearbyRequest = null;
        return;
      }
      // The visitor's own square downloads on any connection; the squares around it wait for Wi-Fi.
      const work = prefetchMapArea(this, request.releaseId, point, "nearby", signal, currentSnapshot)
        .then(() => prefetchMapArea(this, request.releaseId, point, "surrounding", signal, currentSnapshot))
        .then(() => {
        if (this.nearbyRequest === request && !signal.aborted && this.status.snapshot?.releaseId === request.releaseId) {
          this.nearbyAnchor = { releaseId: request.releaseId, point };
        }
      }).catch((error) => {
        if (!this.stopped && (error as Error)?.name !== "AbortError") this.updateWaitingStatus();
      });
      this.nearbyPromise = work;
      void work.finally(() => {
        if (this.nearbyRequest === request) {
          this.nearbyRequest = null;
          this.nearbyAbort = null;
          if (this.nearbyPromise === work) this.nearbyPromise = null;
        }
      });
    }, LOCATION_DEBOUNCE_MS);
  }

  private startBulkMap(releaseId: string): void {
    if (this.stopped || !this.initialized || !this.artworkReadyReleases.has(releaseId) || this.bulkPromises.has(releaseId)) return;
    if (this.hasSyncApi() && this.status.snapshot?.releaseId === releaseId && !this.status.mapDetailReady) return;
    const controller = new AbortController();
    this.bulkControllers.set(releaseId, controller);
    const task = this.runBulkMap(releaseId, controller.signal);
    this.bulkPromises.set(releaseId, task);
    void task.catch((error) => {
      if (!this.stopped) this.setStatus({ error: this.status.snapshot ? null : errorText(error) });
    }).finally(() => {
      if (this.bulkPromises.get(releaseId) === task) this.bulkPromises.delete(releaseId);
      if (this.bulkControllers.get(releaseId) === controller) this.bulkControllers.delete(releaseId);
      this.updateWaitingStatus();
    });
  }

  /**
   * Allow the detailed chunks already saved on the device. The whole archive is
   * never downloaded automatically: coverage comes from nearby squares, chosen
   * downloads and streaming while online.
   */
  private async runBulkMap(releaseId: string, _signal: AbortSignal): Promise<void> {
    const release = await this.options.store.getRelease(releaseId);
    const manifest = release?.manifest ?? this.syncManifests.get(releaseId);
    if (!manifest) return;
    const chunks = mapChunkFiles(manifest);
    const missing = new Set((await this.missingFiles(chunks)).map((file) => file.path));
    const local = chunks.filter((file) => !missing.has(file.path));
    setAllowedMapChunks(releaseId, chunkIndices(local));
    this.waitingForBulkWifi = false;
    await this.refreshMapReadinessForManifest(releaseId, manifest);
    this.updateWaitingStatus();
  }

  /** Builds that pin a detailed map read it instead of the server's map pointer. */
  private withBuildMap(state: ContentSyncState): ContentSyncState {
    const pointer = this.options.mapPointer;
    if (!pointer || state.map?.version === pointer.version) return state;
    return { ...state, map: { ...pointer } };
  }

  /** Coverage is anchored on the visitor when known, otherwise on the demo start. */
  private mapAnchor(): MapPoint {
    return this.currentLocation ?? VICTORIA;
  }

  private async refreshMapReadiness(snapshot: ContentSnapshot): Promise<void> {
    const release = await this.options.store.getRelease(snapshot.releaseId);
    if (release) await this.refreshMapReadinessForRelease(release);
    else {
      const manifest = this.syncManifests.get(snapshot.releaseId);
      if (manifest) await this.refreshMapReadinessForManifest(snapshot.releaseId, manifest);
    }
  }

  private async refreshMapReadinessForRelease(release: StoredRelease): Promise<void> {
    await this.refreshMapReadinessForManifest(release.id, release.manifest);
  }

  private async refreshMapReadinessForManifest(releaseId: string, manifest: ContentManifest): Promise<void> {
    const chunks = mapChunkFiles(manifest);
    const fullMapReady = chunks.length > 0 && chunks.every((file) => this.verifiedHashes.has(fileKey(file.sha256, file.byte_size)));
    if (this.status.snapshot?.releaseId === releaseId && this.status.fullMapReady !== fullMapReady) this.setStatus({ fullMapReady });
  }

  private async refreshMapReadinessForHash(hash: string): Promise<void> {
    for (const [releaseId, manifest] of this.syncManifests) {
      if (this.status.snapshot?.releaseId === releaseId && manifest.files.some((file) => file.sha256 === hash && isMapChunk(file.path))) {
        await this.refreshMapReadinessForManifest(releaseId, manifest);
      }
    }
    const activeId = await this.options.store.getActiveId();
    const active = activeId ? await this.options.store.getRelease(activeId) : undefined;
    if (active?.manifest.files.some((file) => file.sha256 === hash && isMapChunk(file.path))) await this.refreshMapReadinessForRelease(active);
    const candidate = [...this.candidatePromises.keys()].map((id) => id);
    for (const id of candidate) {
      const release = await this.options.store.getRelease(id);
      if (release?.manifest.files.some((file) => file.sha256 === hash && isMapChunk(file.path))) await this.refreshMapReadinessForRelease(release);
    }
  }

  private async refreshLocalFileIndex(): Promise<void> {
    this.localFileSizes.clear();
    for (const file of await this.options.store.listFiles()) this.localFileSizes.set(file.hash, file.size);
  }

  private refreshLocalFileIndexInBackground(): void {
    if (this.localFileIndexPromise) return;
    const work = this.refreshLocalFileIndex();
    this.localFileIndexPromise = work;
    void work.catch(() => {}).finally(() => {
      if (this.localFileIndexPromise === work) this.localFileIndexPromise = null;
    });
  }

  private trackFile(file: ContentFile): void {
    this.progressFiles.set(file.sha256, file.byte_size);
    this.refreshProgress();
  }

  private trackFiles(files: ContentFile[]): void {
    for (const file of files) this.progressFiles.set(file.sha256, file.byte_size);
    this.refreshProgress();
  }

  private refreshProgress(): void {
    let downloadedBytes = 0;
    let totalBytes = 0;
    for (const [hash, size] of this.progressFiles) {
      totalBytes += size;
      if (this.verifiedHashes.has(fileKey(hash, size))) downloadedBytes += size;
    }
    if (this.status.downloadedBytes !== downloadedBytes || this.status.totalBytes !== totalBytes) {
      this.setStatus({ downloadedBytes, totalBytes });
    }
  }

  private updateWaitingStatus(): void {
    const waitingForWifi = this.waitingForUpdateWifi || this.waitingForBulkWifi;
    if (this.status.waitingForWifi !== waitingForWifi) this.setStatus({ waitingForWifi });
  }

  private hasPendingUpdateChunks(): boolean {
    return !this.hasSyncApi() && this.status.phase === "updating" && this.isWaitingForWifi();
  }

  private hasPendingBulkMap(): boolean {
    return this.bulkPromises.size > 0 && this.isWaitingForWifi();
  }

  private async resumeStoredCandidate(): Promise<void> {
    if (this.stopped || !this.initialized || !this.canDownloadContent() || !this.foreground) return;
    const activeId = await this.options.store.getActiveId();
    const releases = await this.options.store.listReleases();
    const active = activeId ? await this.options.store.getRelease(activeId) : undefined;
    const candidates = releases.filter((release) => release.id !== activeId && (release.readiness === "candidate" || release.readiness === "complete" || release.readiness === "starter"))
      .sort((a, b) => b.channel.generation - a.channel.generation);
    const candidate = candidates[0];
    if (!candidate) return;
    const channel = parseContentChannel(candidate.channel, this.environment);
    if (active && channel.generation <= active.channel.generation) return;
    this.latestChannel = channel;
    await this.processChannel(channel);
  }

  private async collectGarbage(): Promise<void> {
    if (this.stopped || !this.initialized) return;
    const activeId = await this.options.store.getActiveId();
    const releases = await this.options.store.listReleases();
    const protectedIds = new Set<string>([activeId ?? "", this.pendingActivationId ?? "", ...this.candidatePromises.keys()]);
    const activeGeneration = activeId ? releases.find((release) => release.id === activeId)?.channel.generation ?? 0 : 0;
    for (const release of releases) {
      const stagedForActivation = release.readiness === "candidate" || release.readiness === "starter" || release.readiness === "complete";
      const stillCurrent = !this.latestChannel || this.latestChannel.releaseId === release.id;
      if (release.id !== activeId && stagedForActivation && release.channel.generation > activeGeneration && stillCurrent) {
        protectedIds.add(release.id);
      }
    }
    for (const release of releases) {
      if (release.id && !protectedIds.has(release.id)) await this.options.store.deleteRelease(release.id).catch(() => {});
    }
    const remaining = await this.options.store.listReleases();
    const retained = await this.options.store.getRetainedParks();
    const referenced = new Set<string>();
    for (const release of remaining) {
      for (const file of remoteFiles(release.manifest)) referenced.add(file.sha256);
    }
    for (const entry of retained) if (entry.sceneFile) referenced.add(entry.sceneFile.sha256);
    for (const [hash, count] of this.inFlightHashes) if (count > 0) referenced.add(hash);
    for (const file of await this.options.store.listFiles()) {
      if (referenced.has(file.hash)) continue;
      await this.options.store.deleteFile(file.hash).catch(() => {});
      this.localFileSizes.delete(file.hash);
      for (const key of this.verifiedHashes) if (key.startsWith(`${file.hash}:`)) this.verifiedHashes.delete(key);
      for (const [key] of this.fileUrlPromises) if (key.startsWith(`${file.hash}:`)) this.fileUrlPromises.delete(key);
    }
  }

  private incrementInFlight(hash: string) {
    this.inFlightHashes.set(hash, (this.inFlightHashes.get(hash) ?? 0) + 1);
  }

  private decrementInFlight(hash: string) {
    const count = (this.inFlightHashes.get(hash) ?? 1) - 1;
    if (count > 0) this.inFlightHashes.set(hash, count);
    else this.inFlightHashes.delete(hash);
  }

  private async withInFlight<T>(file: ContentFile, work: () => Promise<T>): Promise<T> {
    this.incrementInFlight(file.sha256);
    try {
      return await work();
    } catch (error) {
      this.verifiedHashes.delete(fileKey(file.sha256, file.byte_size));
      this.localFileCheckPromises.delete(fileKey(file.sha256, file.byte_size));
      throw error;
    } finally {
      this.decrementInFlight(file.sha256);
    }
  }

  private setStatus(update: Partial<ContentStatus>): void {
    if (this.stopped) return;
    let next: ContentStatus = { ...this.status, ...update };
    if (update.downloadedBytes === undefined || update.totalBytes === undefined) {
      let downloadedBytes = 0;
      let totalBytes = 0;
      for (const [hash, size] of this.progressFiles) {
        totalBytes += size;
        if (this.verifiedHashes.has(fileKey(hash, size))) downloadedBytes += size;
      }
      next = { ...next, downloadedBytes, totalBytes };
    }
    this.status = next;
    for (const listener of this.listeners) listener();
  }

  private assertRunning() {
    if (this.stopped) throw new Error("Content runtime is stopped");
    if (!this.initialized) throw new Error("Content runtime has not started");
  }
}
