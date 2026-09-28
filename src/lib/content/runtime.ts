import {
  CONTENT_BOUNDS,
  VICTORIA,
  type Connectivity,
  type ContentChannel,
  type ContentEnvironment,
  type ContentFile,
  type ContentManifest,
  type ContentPayload,
  type ContentPhase,
  type ContentRuntime,
  type ContentRuntimeOptions,
  type ContentSnapshot,
  type ContentStatus,
  type MapPoint,
  type RetainedPark,
  type StoredRelease,
} from "./contracts";
import {
  ContentValidationError,
  assertFileBytes,
  coreFiles,
  fileByPath,
  mapChunkFiles,
  parseContentChannel,
  parseContentManifest,
  parseJsonBytes,
  remoteFiles,
  sha256Hex,
  validateContentPayload,
} from "./manifest";
import { ContentDownloadScheduler, type DownloadPolicy } from "./scheduler";
import { prefetchMapArea } from "./map-downloads";
import { setAllowedMapChunks } from "../offlineTiles";

const DISCOVERY_COOLDOWN_MS = 5 * 60 * 1000;
const LOCATION_DEBOUNCE_MS = 800;
const LOCATION_MOVE_THRESHOLD_KM = 5;
const EMPTY_STATUS: ContentStatus = {
  phase: "starting",
  snapshot: null,
  downloadedBytes: 0,
  totalBytes: 0,
  fullMapReady: false,
  waitingForWifi: false,
  error: null,
};

export class ContentUnavailableOfflineError extends Error {
  constructor(path: string) {
    super(`This content is not downloaded and is unavailable offline: ${path}`);
    this.name = "ContentUnavailableOfflineError";
  }
}

function fileKey(hash: string, size: number) {
  return `${hash}:${size}`;
}

function isMapChunk(path: string) {
  return /^map\/island\/\d{3,}\.bin$/.test(path);
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

function isPointInsideContentBounds(point: MapPoint): boolean {
  const [lng, lat] = point;
  return Number.isFinite(lng) && Number.isFinite(lat) &&
    lng >= CONTENT_BOUNDS[0] && lng <= CONTENT_BOUNDS[2] &&
    lat >= CONTENT_BOUNDS[1] && lat <= CONTENT_BOUNDS[3];
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ContentValidationError("map/island/manifest.json must be an object");
  const map = value as Record<string, unknown>;
  const keys = Object.keys(map).sort();
  if (keys.length !== 3 || keys[0] !== "chunkBytes" || keys[1] !== "count" || keys[2] !== "size") {
    throw new ContentValidationError("map/island/manifest.json has an unsupported shape");
  }
  if (map.size !== expected.size || map.chunkBytes !== expected.chunkBytes || map.count !== expected.count) {
    throw new ContentValidationError("map/island/manifest.json disagrees with the immutable release manifest");
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
  private startPromise: Promise<void> | null = null;
  private discoveryPromise: Promise<void> | null = null;
  private initialized = false;
  private stopped = false;
  private closePromise: Promise<void> | null = null;
  private lastDiscoveryAt = Number.NEGATIVE_INFINITY;
  private discoveryEtag: string | null = null;
  private latestChannel: ContentChannel | null = null;
  private currentLocation: MapPoint | null = null;
  private nearbyAnchor: MapPoint | null = null;
  private nearbyTimer: ReturnType<typeof setTimeout> | undefined;
  private nearbyAbort: AbortController | null = null;
  private nearbyPromise: Promise<unknown> | null = null;
  private busy = false;
  private pendingActivationId: string | null = null;
  private waitingForUpdateWifi = false;
  private waitingForBulkWifi = false;

  constructor(private readonly options: ContentRuntimeOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
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
    if (!this.connectivity().connected) {
      if (this.status.snapshot) this.setStatus({ phase: "offline", error: null });
      else this.setStatus({ phase: "error", error: "Connect to the internet to download park content." });
      return;
    }
    this.setStatus({ error: null, phase: this.status.snapshot ? "updating" : "downloading" });
    if (this.status.snapshot) this.startBulkMap(this.status.snapshot.releaseId);
    await this.checkCurrentRelease(true);
  }

  setForeground(foreground: boolean): void {
    if (this.stopped) return;
    this.policyForeground = foreground;
    this.scheduler.setPolicy({ ...this.currentPolicy(), foreground });
    if (!foreground) {
      if (this.nearbyTimer !== undefined) globalThis.clearTimeout(this.nearbyTimer);
      this.nearbyTimer = undefined;
      return;
    }
    if (this.initialized) {
      if (this.pendingActivationId && !this.busy) void this.activatePending();
      void this.checkCurrentRelease(false);
      if (this.status.snapshot) {
        this.startBulkMap(this.status.snapshot.releaseId);
        this.scheduleNearbyPrefetch(true);
      }
    }
  }

  setConnectivity(connectivity: Connectivity): void {
    if (this.stopped) return;
    const wasWifi = this.options.connectivity?.wifi ?? false;
    this.options.connectivity = { connected: connectivity.connected, wifi: connectivity.wifi };
    this.scheduler.setPolicy(this.currentPolicy());
    if (!connectivity.wifi) this.waitingForUpdateWifi = this.waitingForUpdateWifi || this.hasPendingUpdateChunks();
    else this.waitingForUpdateWifi = false;
    if (!connectivity.wifi) this.waitingForBulkWifi = this.waitingForBulkWifi || this.hasPendingBulkMap();
    else this.waitingForBulkWifi = false;
    if (this.status.snapshot && !connectivity.connected && this.status.phase !== "updating") {
      this.setStatus({ phase: "offline", error: null, waitingForWifi: false });
    } else if (this.status.snapshot && connectivity.connected && this.status.phase === "offline") {
      this.setStatus({ phase: "ready", error: null });
    }
    this.updateWaitingStatus();
    if (this.initialized && connectivity.connected && this.foreground) {
      void this.checkCurrentRelease(false);
      if (connectivity.wifi && !wasWifi && this.status.snapshot) this.startBulkMap(this.status.snapshot.releaseId);
      if (this.currentLocation && this.status.snapshot) this.scheduleNearbyPrefetch(false);
    }
  }

  setLocation(point: MapPoint | null): void {
    if (this.stopped) return;
    this.currentLocation = validMapPoint(point) && isPointInsideContentBounds(point) ? [point[0], point[1]] : null;
    if (this.status.snapshot) this.scheduleNearbyPrefetch(false);
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
    if (!release) throw new Error(`Content release ${releaseId} is not available locally`);
    const file = fileByPath(release.manifest, path);
    const key = fileKey(file.sha256, file.byte_size);
    this.trackFile(file);
    if (this.verifiedHashes.has(key)) return;
    const hasLocal = await this.hasVerifiedLocalFile(file);
    if (hasLocal) return;
    if (!this.connectivity().connected) throw new ContentUnavailableOfflineError(path);
    const effectivePurpose = isMapChunk(path) && purpose !== "nearby" && purpose !== "update" ? "bulk" : purpose;
    this.incrementInFlight(file.sha256);
    try {
      await this.scheduler.enqueue({
      key: file.sha256,
      path: file.path,
      purpose: effectivePurpose,
      priority: requestPriority(effectivePurpose, file.path),
      run: (downloadSignal) => this.downloadFile(file, downloadSignal),
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
    if (!release) throw new Error(`Content release ${releaseId} is not available locally`);
    const file = fileByPath(release.manifest, path);
    const purpose = isMapChunk(path) ? "nearby" : "core";
    await this.ensureFile(releaseId, path, purpose);
    return this.withInFlight(file, () => this.options.store.readFile(file.sha256, offset, length));
  }

  async getFileUrl(releaseId: string, path: string): Promise<string> {
    const release = await this.options.store.getRelease(releaseId);
    if (!release) throw new Error(`Content release ${releaseId} is not available locally`);
    const file = fileByPath(release.manifest, path);
    await this.ensureFile(releaseId, path, isMapChunk(path) ? "nearby" : "core");
    const key = `${file.sha256}:${file.content_type}`;
    let promise = this.fileUrlPromises.get(key);
    if (!promise) {
      promise = this.options.store.fileUrl(file.sha256, file.content_type);
      this.fileUrlPromises.set(key, promise);
    }
    return promise;
  }

  async stop(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    if (this.nearbyTimer !== undefined) globalThis.clearTimeout(this.nearbyTimer);
    this.nearbyTimer = undefined;
    this.nearbyAbort?.abort();
    this.scheduler.dispose();
    this.closePromise = (async () => {
      await Promise.allSettled([
        this.startPromise ?? Promise.resolve(),
        this.discoveryPromise ?? Promise.resolve(),
        ...this.candidatePromises.values(),
        ...this.bulkPromises.values(),
      ]);
      if (this.initialized) await this.options.store.close();
    })();
    return this.closePromise;
  }

  private async startInternal(): Promise<void> {
    this.setStatus({ phase: "starting", error: null, waitingForWifi: false });
    try {
      await this.options.store.initialize();
      this.initialized = true;
      await this.refreshLocalFileIndex();
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
        await this.refreshMapReadiness(activeSnapshot);
      } else {
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

  private get foreground() {
    // Web starts visible by default. Native lifecycle wiring sets this explicitly.
    return this.policyForeground;
  }

  private policyForeground = true;

  private currentPolicy(): DownloadPolicy {
    return { foreground: this.policyForeground, connectivity: this.connectivity() };
  }

  private connectivity(): Connectivity {
    return this.options.connectivity ?? { connected: true, wifi: false };
  }

  private async checkCurrentRelease(force: boolean): Promise<void> {
    if (this.stopped || !this.initialized || !this.foreground || !this.connectivity().connected) return;
    if (this.discoveryPromise) return this.discoveryPromise;
    const now = Date.now();
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
      const headers: Record<string, string> = {};
      if (this.discoveryEtag) headers["If-None-Match"] = this.discoveryEtag;
      const response = await this.fetcher(this.options.discoveryUrl, { headers, cache: "no-store" });
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
      await prefetchMapArea(this, candidate.id, VICTORIA, "starter", undefined, snapshot);
      candidate = { ...candidate, readiness: "starter" };
      await this.options.store.putRelease(candidate);
    } else {
      const files = remoteFiles(manifest);
      const missingChunks = await this.missingFiles(mapChunkFiles(manifest));
      this.waitingForUpdateWifi = missingChunks.length > 0 && !this.connectivity().wifi;
      this.updateWaitingStatus();
      await this.ensureFiles(files, candidate.id, "update");
      const snapshot = await this.prepareSnapshot(candidate, payload);
      const chunkIds = mapChunkFiles(manifest)
        .map((file) => Number(file.path.match(/\/(\d{3,})\.bin$/)?.[1]))
        .filter(Number.isSafeInteger);
      setAllowedMapChunks(candidate.id, chunkIds);
      await prefetchMapArea(this, candidate.id, VICTORIA, "starter", undefined, snapshot);
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
    const mapManifestBytes = await this.readFile(release.id, "map/island/manifest.json");
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

  private async downloadFile(file: ContentFile, signal: AbortSignal): Promise<void> {
    const hash = fileKey(file.sha256, file.byte_size);
    this.incrementInFlight(file.sha256);
    try {
      if (signal.aborted) throw signal.reason ?? new DOMException("Download cancelled", "AbortError");
      const response = await this.fetcher(file.url, { signal, cache: "force-cache" });
      if (!response.ok) throw new Error(`Content file ${file.path} returned HTTP ${response.status}`);
      assertUnredirected(response, file.url, `Content file ${file.path}`);
      const bytes = await response.arrayBuffer();
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
    await prefetchMapArea(this, release.id, VICTORIA, "starter", undefined, snapshot);
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
      setAllowedMapChunks(release.id, locallyPresentChunks.map((file) => Number(file.path.match(/\/(\d{3,})\.bin$/)?.[1])).filter(Number.isSafeInteger));
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
    return promise;
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
    this.setStatus({ snapshot, phase, error, waitingForWifi: this.waitingForUpdateWifi || this.waitingForBulkWifi });
  }

  private scheduleNearbyPrefetch(force: boolean): void {
    if (!this.foreground || !this.connectivity().connected || !this.status.snapshot || !this.currentLocation || this.stopped) return;
    const point = this.currentLocation;
    if (!isPointInsideContentBounds(point)) return;
    if (!force && this.nearbyAnchor && distanceKm(this.nearbyAnchor, point) < LOCATION_MOVE_THRESHOLD_KM) return;
    if (this.nearbyTimer !== undefined) globalThis.clearTimeout(this.nearbyTimer);
    this.nearbyAbort?.abort();
    this.nearbyAbort = new AbortController();
    const signal = this.nearbyAbort.signal;
    this.nearbyTimer = globalThis.setTimeout(() => {
      this.nearbyTimer = undefined;
      const snapshot = this.status.snapshot;
      if (!snapshot || this.stopped || !this.foreground || !this.connectivity().connected) return;
      const work = prefetchMapArea(this, snapshot.releaseId, point, "nearby", signal, snapshot).then(() => {
        this.nearbyAnchor = point;
      }).catch((error) => {
        if (!this.stopped && (error as Error)?.name !== "AbortError") this.updateWaitingStatus();
      });
      this.nearbyPromise = work;
      void work.finally(() => {
        if (this.nearbyPromise === work) this.nearbyPromise = null;
      });
    }, LOCATION_DEBOUNCE_MS);
  }

  private startBulkMap(releaseId: string): void {
    if (this.stopped || !this.initialized || this.bulkPromises.has(releaseId)) return;
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

  private async runBulkMap(releaseId: string, signal: AbortSignal): Promise<void> {
    const release = await this.options.store.getRelease(releaseId);
    if (!release) return;
    const chunks = mapChunkFiles(release.manifest);
    this.trackFiles(chunks);
    const missing = await this.missingFiles(chunks);
    this.waitingForBulkWifi = missing.length > 0 && !this.connectivity().wifi;
    this.updateWaitingStatus();
    if (missing.length === 0) {
      setAllowedMapChunks(releaseId, chunks.map((file) => Number(file.path.match(/\/(\d{3,})\.bin$/)?.[1])).filter(Number.isSafeInteger));
      await this.refreshMapReadinessForRelease(release);
      return;
    }
    await this.ensureFiles(missing, releaseId, "bulk", signal);
    setAllowedMapChunks(releaseId, chunks.map((file) => Number(file.path.match(/\/(\d{3,})\.bin$/)?.[1])).filter(Number.isSafeInteger));
    this.waitingForBulkWifi = false;
    await this.refreshMapReadinessForRelease(release);
    this.updateWaitingStatus();
  }

  private async refreshMapReadiness(snapshot: ContentSnapshot): Promise<void> {
    const release = await this.options.store.getRelease(snapshot.releaseId);
    if (release) await this.refreshMapReadinessForRelease(release);
  }

  private async refreshMapReadinessForRelease(release: StoredRelease): Promise<void> {
    const chunks = mapChunkFiles(release.manifest);
    const fullMapReady = chunks.every((file) => this.localFileSizes.get(file.sha256) === file.byte_size || this.verifiedHashes.has(fileKey(file.sha256, file.byte_size)));
    if (this.status.snapshot?.releaseId === release.id && this.status.fullMapReady !== fullMapReady) this.setStatus({ fullMapReady });
  }

  private async refreshMapReadinessForHash(hash: string): Promise<void> {
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
    return this.status.phase === "updating" && !this.connectivity().wifi;
  }

  private hasPendingBulkMap(): boolean {
    return this.bulkPromises.size > 0 && !this.connectivity().wifi;
  }

  private async resumeStoredCandidate(): Promise<void> {
    if (this.stopped || !this.initialized || !this.connectivity().connected || !this.foreground) return;
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
