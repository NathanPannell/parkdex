import { getPlatformStorage, type KeyValueStore } from "./platform-storage";
import { matchesPlaceSearch, type PlaceCategory, type PlaceCatalogueSummary } from "./places";

export const PLACE_DATA_CACHE_LIMIT = 100;
export const PLACE_MAP_RESULT_LIMIT = 50;
export const OFFLINE_PLACE_DATA_MESSAGE = "You are in offline mode. Showing saved places only.";

const CACHE_VERSION = 1;
const CACHE_KEY_PREFIX = "parkdex:place-data-cache:v1:";
const LEGACY_PLACE_CACHE_KEY = "every-park:places:v1";
const CATEGORIES: readonly PlaceCategory[] = ["national", "provincial", "regional", "island"];

export type PlaceVisitFilter = "all" | "visited" | "unseen";
export type PlaceCacheReason = "viewport" | "interaction" | "visited";

/** Compact display data shared by the map, search, and visited-place views. */
export type PlaceDataItem = PlaceCatalogueSummary & {
  authority?: string;
  listRegion?: string;
  visited: boolean;
  priorityTier: 0 | 1 | 2;
  priorityKey: string;
  distanceKm?: number | null;
};

export type PlaceDataResult = {
  places: PlaceDataItem[];
  /** Full server count online; matching cache count offline. */
  total: number;
  limit: number;
  scope: "full" | "cached";
  /** True when the response cannot represent the entire matching catalogue. */
  partial: boolean;
  offset?: number;
};

export type PlaceViewport = { west: number; south: number; east: number; north: number };

export type MapPlacesQuery = {
  viewport: PlaceViewport;
  query?: string;
  categories?: readonly PlaceCategory[] | ReadonlySet<PlaceCategory>;
  authorities?: readonly string[] | ReadonlySet<string>;
  visited?: PlaceVisitFilter;
  /** The authoritative local visit set for offline filtering, when hydrated. */
  visitedPlaceIds?: ReadonlySet<string>;
  groupId?: string | null;
  groupPlaceIds?: ReadonlySet<string>;
  selectedPlaceId?: string | null;
  limit?: number;
};

export type PlaceSearchQuery = {
  query?: string;
  categories?: readonly PlaceCategory[] | ReadonlySet<PlaceCategory>;
  authorities?: readonly string[] | ReadonlySet<string>;
  visited?: PlaceVisitFilter;
  visitedPlaceIds?: ReadonlySet<string>;
  limit?: number;
  offset?: number;
};

export type VisitedPlacesQuery = {
  query?: string;
  categories?: readonly PlaceCategory[] | ReadonlySet<PlaceCategory>;
  visitedPlaceIds?: ReadonlySet<string>;
  limit?: number;
  offset?: number;
};

export type PlaceGatewayStatus = {
  offline: boolean;
  message: string | null;
};

export type PlaceGatewayOptions = {
  apiBaseUrl: string;
  /** Stable account:<id> or guest:<hash> namespace. Never use an access token here. */
  identityKey: string;
  store?: KeyValueStore;
  fetcher?: typeof fetch;
  getHeaders?: () => HeadersInit | Promise<HeadersInit>;
  isOnline?: () => boolean;
  now?: () => number;
  cacheLimit?: number;
  legacyStorageKey?: string | null;
};

export type PlaceGateway = {
  fetchMap(query: MapPlacesQuery): Promise<PlaceDataResult>;
  /** Force one online attempt after a browser-online or app-resume signal. */
  retryMap(query: MapPlacesQuery): Promise<PlaceDataResult>;
  fetchSearch(query: PlaceSearchQuery): Promise<PlaceDataResult>;
  retrySearch(query: PlaceSearchQuery): Promise<PlaceDataResult>;
  fetchVisited(query: VisitedPlacesQuery): Promise<PlaceDataResult>;
  retryVisited(query: VisitedPlacesQuery): Promise<PlaceDataResult>;
  /** Protect a clicked place or a locally recorded visit from ordinary map-result eviction. */
  remember(place: PlaceDataItem, reason?: PlaceCacheReason): Promise<void>;
  getOfflineStatus(): PlaceGatewayStatus;
  subscribeOfflineStatus(listener: (status: PlaceGatewayStatus) => void): () => void;
};

type CachedPlace = {
  place: PlaceDataItem;
  lastSeenAt: number;
  protection: 0 | 1 | 2;
};

type CachePayload = { version: typeof CACHE_VERSION; places: CachedPlace[] };

class OfflinePlaceDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OfflinePlaceDataError";
  }
}

export type PlaceDataCache = {
  list(): Promise<PlaceDataItem[]>;
  remember(places: PlaceDataItem | readonly PlaceDataItem[], reason?: PlaceCacheReason): Promise<void>;
  touch(placeIds: Iterable<string>): Promise<void>;
  clear(): Promise<void>;
};

export type PlaceDataCacheOptions = {
  identityKey: string;
  store?: KeyValueStore;
  now?: () => number;
  limit?: number;
  /** Set null to disable the one-time, best-effort import from the pre-gateway cache. */
  legacyStorageKey?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCategory(value: unknown): value is PlaceCategory {
  return CATEGORIES.includes(value as PlaceCategory);
}

function boundedLimit(value: number | undefined, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value as number)));
}

/** Repeatable local fallback. The server's MD5 key is used whenever it is present. */
export function stablePlacePriorityKey(id: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fallbackPriorityTier(category: PlaceCategory, id: string): 0 | 1 | 2 {
  if (category === "national") return 0;
  // Keep a stable approximate third of islands when a legacy response has no rank.
  if (category === "island" && Number.parseInt(stablePlacePriorityKey(id).slice(0, 2), 16) < 86) return 1;
  return 2;
}

function normalizePlace(value: unknown): PlaceDataItem | null {
  if (!isRecord(value)
    || typeof value.id !== "string" || value.id.length === 0
    || typeof value.name !== "string"
    || !isCategory(value.category)
    || typeof value.latitude !== "number" || !Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90
    || typeof value.longitude !== "number" || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180
    || typeof value.region !== "string"
    || typeof value.sourceName !== "string") return null;

  const priorityTier = value.priorityTier === 0 || value.priorityTier === 1 || value.priorityTier === 2
    ? value.priorityTier
    : fallbackPriorityTier(value.category, value.id);
  const priorityKey = typeof value.priorityKey === "string" && value.priorityKey.length > 0
    ? value.priorityKey.toLowerCase()
    : stablePlacePriorityKey(value.id);
  const sourceId = typeof value.sourceId === "string" || value.sourceId === null ? value.sourceId : undefined;
  const authority = typeof value.authority === "string" ? value.authority : undefined;
  const listRegion = typeof value.listRegion === "string" ? value.listRegion : undefined;
  const distanceKm = typeof value.distanceKm === "number" && Number.isFinite(value.distanceKm) ? value.distanceKm : undefined;

  return {
    id: value.id,
    name: value.name,
    category: value.category,
    latitude: value.latitude,
    longitude: value.longitude,
    region: value.region,
    description: typeof value.description === "string" ? value.description : "",
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : "",
    sourceName: value.sourceName,
    ...(sourceId !== undefined ? { sourceId } : {}),
    ...(authority !== undefined ? { authority } : {}),
    ...(listRegion !== undefined ? { listRegion } : {}),
    visited: value.visited === true,
    priorityTier,
    priorityKey,
    ...(distanceKm !== undefined ? { distanceKm } : {}),
  };
}

function protectionFor(place: PlaceDataItem, reason: PlaceCacheReason): 0 | 1 | 2 {
  if (reason === "visited" || place.visited) return 2;
  if (reason === "interaction") return 1;
  return 0;
}

function identityNamespace(identityKey: string): string {
  // Two independently seeded FNV-1a hashes avoid storing an account id or guest key in the storage key.
  const hashWithSeed = (seed: number) => {
    let hash = seed >>> 0;
    for (let index = 0; index < identityKey.length; index += 1) {
      hash ^= identityKey.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  return `${hashWithSeed(0x811c9dc5)}${hashWithSeed(0x9e3779b9)}`;
}

function normalizeCachePayload(raw: string | null, limit: number): CachedPlace[] {
  if (!raw) return [];
  try {
    const payload = JSON.parse(raw) as unknown;
    if (!isRecord(payload) || payload.version !== CACHE_VERSION || !Array.isArray(payload.places)) return [];
    const byId = new Map<string, CachedPlace>();
    for (const candidate of payload.places) {
      if (!isRecord(candidate)) continue;
      const place = normalizePlace(candidate.place);
      if (!place || typeof candidate.lastSeenAt !== "number" || !Number.isFinite(candidate.lastSeenAt)) continue;
      const protection = candidate.protection === 2 || candidate.protection === 1 ? candidate.protection : 0;
      const next = { place, lastSeenAt: candidate.lastSeenAt, protection } satisfies CachedPlace;
      const prior = byId.get(place.id);
      if (!prior || next.lastSeenAt >= prior.lastSeenAt) byId.set(place.id, next);
    }
    return [...byId.values()]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.place.id.localeCompare(right.place.id))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function normalizeLegacyPlaceCache(raw: string | null, limit: number, now: () => number): CachedPlace[] {
  if (!raw) return [];
  try {
    const decoded = JSON.parse(raw) as unknown;
    const candidates = Array.isArray(decoded) ? decoded : isRecord(decoded) && Array.isArray(decoded.places) ? decoded.places : [];
    const byId = new Map<string, CachedPlace>();
    candidates.forEach((candidate, index) => {
      const place = normalizePlace(candidate);
      if (!place) return;
      const candidateRecord = isRecord(candidate) ? candidate : {};
      const lastSeenAt = typeof candidateRecord.lastSeenAt === "number" && Number.isFinite(candidateRecord.lastSeenAt)
        ? candidateRecord.lastSeenAt
        : now() - index;
      const protection = place.visited || candidateRecord.protection === 2 ? 2 : candidateRecord.protection === 1 ? 1 : 0;
      byId.set(place.id, { place, lastSeenAt, protection });
    });
    return [...byId.values()]
      .sort((left, right) => right.protection - left.protection || left.place.priorityTier - right.place.priorityTier
        || left.place.priorityKey.localeCompare(right.place.priorityKey) || left.place.id.localeCompare(right.place.id))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function mergePlace(prior: PlaceDataItem | undefined, fresh: PlaceDataItem): PlaceDataItem {
  if (!prior) return fresh;
  return {
    ...prior,
    ...fresh,
    description: fresh.description || prior.description,
    sourceUrl: fresh.sourceUrl || prior.sourceUrl,
    sourceId: fresh.sourceId ?? prior.sourceId,
  };
}

export function createPlaceDataCache(options: PlaceDataCacheOptions): PlaceDataCache {
  const limit = boundedLimit(options.limit, PLACE_DATA_CACHE_LIMIT, PLACE_DATA_CACHE_LIMIT);
  const storageKey = `${CACHE_KEY_PREFIX}${identityNamespace(options.identityKey)}`;
  const now = options.now ?? Date.now;
  const legacyStorageKey = options.legacyStorageKey === undefined ? LEGACY_PLACE_CACHE_KEY : options.legacyStorageKey;
  let storePromise: Promise<KeyValueStore> | null = options.store ? Promise.resolve(options.store) : null;
  let recordsPromise: Promise<CachedPlace[]> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  const storage = () => storePromise ??= getPlatformStorage();
  const records = () => recordsPromise ??= storage().then(async (target) => {
    const current = normalizeCachePayload(await target.getItem(storageKey), limit);
    if (current.length || !legacyStorageKey) return current;
    let legacyRaw: string | null = null;
    try { legacyRaw = await target.getItem(legacyStorageKey); } catch { return current; }
    const migrated = normalizeLegacyPlaceCache(legacyRaw, limit, now);
    if (migrated.length) {
      try { await target.setItem(storageKey, JSON.stringify({ version: CACHE_VERSION, places: migrated } satisfies CachePayload)); } catch { /* Migration must never block online startup or cache reads. */ }
    }
    return migrated;
  });

  async function transact(transform: (current: CachedPlace[]) => CachedPlace[]) {
    const operation = writeQueue.then(async () => {
      const current = await records();
      const next = transform(current.map((record) => ({ ...record, place: { ...record.place } })));
      const pruned = next
        .sort((left, right) => right.protection - left.protection || right.lastSeenAt - left.lastSeenAt || left.place.id.localeCompare(right.place.id))
        .slice(0, limit);
      await (await storage()).setItem(storageKey, JSON.stringify({ version: CACHE_VERSION, places: pruned } satisfies CachePayload));
      recordsPromise = Promise.resolve(pruned);
    });
    writeQueue = operation.catch(() => undefined);
    await operation;
  }

  return {
    async list() {
      await writeQueue;
      return (await records()).map((record) => ({ ...record.place }));
    },
    async remember(value, reason = "viewport") {
      const incoming = (Array.isArray(value) ? value : [value])
        .map(normalizePlace)
        .filter((place): place is PlaceDataItem => place !== null);
      if (incoming.length === 0) return;
      const timestamp = now();
      await transact((current) => {
        const byId = new Map(current.map((record) => [record.place.id, record]));
        for (const place of incoming) {
          const prior = byId.get(place.id);
          byId.set(place.id, {
            place: mergePlace(prior?.place, place),
            lastSeenAt: timestamp,
            protection: Math.max(prior?.protection ?? 0, protectionFor(place, reason)) as 0 | 1 | 2,
          });
        }
        return [...byId.values()];
      });
    },
    async touch(placeIds) {
      const ids = new Set(placeIds);
      if (ids.size === 0) return;
      const timestamp = now();
      await transact((current) => current.map((record) => ids.has(record.place.id) ? { ...record, lastSeenAt: timestamp } : record));
    },
    async clear() {
      await transact(() => []);
    },
  };
}

function isBrowserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function statusFor(offline: boolean): PlaceGatewayStatus {
  return { offline, message: offline ? OFFLINE_PLACE_DATA_MESSAGE : null };
}

function queryCategories(categories?: readonly PlaceCategory[] | ReadonlySet<PlaceCategory>): PlaceCategory[] {
  const values = categories ? [...categories] : [];
  return [...new Set(values.filter(isCategory))].sort();
}

function queryAuthorities(authorities?: readonly string[] | ReadonlySet<string>): string[] {
  const values = authorities ? [...authorities] : [];
  return [...new Set(values.filter((authority) => typeof authority === "string" && authority.trim()).map((authority) => authority.trim()))].sort();
}

function matchesAuthorities(place: PlaceDataItem, selectedAuthorities: ReadonlySet<string>): boolean {
  return selectedAuthorities.size === 0 || (place.authority !== undefined && selectedAuthorities.has(place.authority));
}

function visitFilter(value: PlaceVisitFilter | undefined): PlaceVisitFilter {
  return value === "visited" || value === "unseen" ? value : "all";
}

function placeInViewport(place: PlaceDataItem, viewport: PlaceViewport): boolean {
  const inLongitude = viewport.west <= viewport.east
    ? place.longitude >= viewport.west && place.longitude <= viewport.east
    : place.longitude >= viewport.west || place.longitude <= viewport.east;
  return inLongitude && place.latitude >= viewport.south && place.latitude <= viewport.north;
}

function isVisited(place: PlaceDataItem, visitedPlaceIds?: ReadonlySet<string>): boolean {
  return visitedPlaceIds ? visitedPlaceIds.has(place.id) : place.visited;
}

function byStablePriority(left: PlaceDataItem, right: PlaceDataItem): number {
  return left.priorityTier - right.priorityTier
    || left.priorityKey.localeCompare(right.priorityKey)
    || left.id.localeCompare(right.id);
}

function applySelectedPlace(items: PlaceDataItem[], selectedPlaceId: string | null | undefined, limit: number): PlaceDataItem[] {
  const selected = selectedPlaceId ? items.find((place) => place.id === selectedPlaceId) : undefined;
  const sliced = items.slice(0, limit);
  if (!selected || sliced.some((place) => place.id === selected.id)) return sliced;
  const replaceIndex = sliced.findLastIndex((place) => place.priorityTier === 2 && place.id !== selected.id);
  if (replaceIndex < 0) return sliced;
  sliced[replaceIndex] = selected;
  return sliced;
}

function paged(items: PlaceDataItem[], limit: number, offset: number): PlaceDataItem[] {
  return items.slice(offset, offset + limit);
}

function validateViewport(viewport: PlaceViewport): PlaceViewport {
  const coordinates = [viewport.west, viewport.south, viewport.east, viewport.north];
  if (!coordinates.every(Number.isFinite)
    || viewport.west < -180 || viewport.west > 180
    || viewport.east < -180 || viewport.east > 180
    || viewport.south < -90 || viewport.south > 90
    || viewport.north < -90 || viewport.north > 90
    || viewport.south > viewport.north) {
    throw new Error("Invalid map viewport bounds.");
  }
  return viewport;
}

type PlaceListResponse = { places: unknown[]; total: number; limit: number; offset?: number };

function parseListResponse(value: unknown): PlaceListResponse {
  if (!isRecord(value) || !Array.isArray(value.places)
    || typeof value.total !== "number" || !Number.isFinite(value.total) || value.total < 0
    || typeof value.limit !== "number" || !Number.isFinite(value.limit) || value.limit < 0
    || (value.offset !== undefined && (typeof value.offset !== "number" || !Number.isFinite(value.offset)))) {
    throw new Error("The place service returned an invalid list response.");
  }
  return { places: value.places, total: value.total, limit: value.limit, ...(typeof value.offset === "number" ? { offset: value.offset } : {}) };
}

function parseListPlaces(value: unknown[]): PlaceDataItem[] {
  const places = value.map(normalizePlace);
  if (places.some((place) => place === null)) throw new Error("The place service returned invalid place data.");
  return places as PlaceDataItem[];
}

export function createPlaceGateway(options: PlaceGatewayOptions): PlaceGateway {
  const fetcher = options.fetcher ?? fetch;
  const isOnline = options.isOnline ?? isBrowserOnline;
  const cache = createPlaceDataCache({
    identityKey: options.identityKey,
    store: options.store,
    now: options.now,
    limit: options.cacheLimit,
    legacyStorageKey: options.legacyStorageKey,
  });
  const listeners = new Set<(status: PlaceGatewayStatus) => void>();
  let currentStatus = statusFor(!isOnline());
  let networkEventsAttached = false;

  const setOffline = (offline: boolean) => {
    if (currentStatus.offline === offline) return;
    currentStatus = statusFor(offline);
    listeners.forEach((listener) => listener(currentStatus));
  };

  const onBrowserOffline = () => setOffline(true);
  const attachNetworkEvents = () => {
    if (networkEventsAttached || typeof window === "undefined" || options.isOnline) return;
    window.addEventListener("offline", onBrowserOffline);
    networkEventsAttached = true;
  };
  const detachNetworkEvents = () => {
    if (!networkEventsAttached || typeof window === "undefined") return;
    window.removeEventListener("offline", onBrowserOffline);
    networkEventsAttached = false;
  };

  async function cachedResult(
    filter: (place: PlaceDataItem) => boolean,
    limit: number,
    offset: number | undefined = undefined,
    selectedPlaceId?: string | null,
    visitedPlaceIds?: ReadonlySet<string>,
  ): Promise<PlaceDataResult> {
    let places: PlaceDataItem[] = [];
    try { places = await cache.list(); } catch { /* A blocked local store behaves like an empty offline cache. */ }
    const matching = places.filter(filter)
      .map((place) => visitedPlaceIds ? { ...place, visited: visitedPlaceIds.has(place.id) } : place)
      .sort(byStablePriority);
    const selected = applySelectedPlace(matching, selectedPlaceId, limit);
    const page = selectedPlaceId ? selected : paged(matching, limit, offset ?? 0);
    try { await cache.touch(page.map((place) => place.id)); } catch { /* Display remains available if recency cannot be written. */ }
    return { places: page, total: matching.length, limit, scope: "cached", partial: true, ...(offset !== undefined ? { offset } : {}) };
  }

  async function fetchJson(path: string, force = false): Promise<unknown> {
    if (!force && !isOnline()) {
      setOffline(true);
      throw new OfflinePlaceDataError("The browser is offline.");
    }
    const headers = options.getHeaders ? await options.getHeaders() : undefined;
    let response: Response;
    try {
      response = await fetcher(`${options.apiBaseUrl.replace(/\/$/, "")}${path}`, { cache: "no-store", headers });
    } catch (error) {
      if (error instanceof TypeError || !isOnline()) {
        setOffline(true);
        throw new OfflinePlaceDataError("The place service could not be reached.", { cause: error });
      }
      throw error;
    }
    if (!response.ok) {
      if (response.status >= 500) {
        setOffline(true);
        throw new OfflinePlaceDataError(`The place service returned ${response.status}.`);
      }
      throw new Error(`The place service returned ${response.status}.`);
    }
    setOffline(false);
    return response.json();
  }

  async function onlineList(path: string, force = false): Promise<{ payload: PlaceListResponse; places: PlaceDataItem[] }> {
    const raw = await fetchJson(path, force);
    const payload = parseListResponse(raw);
    const places = parseListPlaces(payload.places);
    try { await cache.remember(places); } catch { /* API results remain usable if local persistence is unavailable. */ }
    return { payload, places };
  }

  async function fetchMap(query: MapPlacesQuery, force = false): Promise<PlaceDataResult> {
      const viewport = validateViewport(query.viewport);
      const limit = boundedLimit(query.limit, PLACE_MAP_RESULT_LIMIT, PLACE_MAP_RESULT_LIMIT);
      const categories = queryCategories(query.categories);
      const authorities = queryAuthorities(query.authorities);
      const visited = visitFilter(query.visited);
      const params = new URLSearchParams({
        west: String(viewport.west), south: String(viewport.south), east: String(viewport.east), north: String(viewport.north),
        limit: String(limit), visited,
      });
      if (query.query?.trim()) params.set("query", query.query.trim());
      categories.forEach((category) => params.append("category", category));
      authorities.forEach((authority) => params.append("authority", authority));
      if (query.groupId) params.set("group_id", query.groupId);
      if (query.selectedPlaceId) params.set("selected_id", query.selectedPlaceId);
      const path = `/api/map/places?${params.toString()}`;
      const fromCache = () => {
        setOffline(true);
        const categorySet = new Set(categories);
        const authoritySet = new Set(authorities);
        return cachedResult((place) => placeInViewport(place, viewport)
          && (categorySet.size === 0 || categorySet.has(place.category))
          && matchesAuthorities(place, authoritySet)
          && (!query.groupPlaceIds || query.groupPlaceIds.has(place.id))
          && matchesPlaceSearch(place, query.query ?? "", `${place.authority ?? ""} ${place.listRegion ?? ""}`)
          && (visited === "all" || (visited === "visited") === isVisited(place, query.visitedPlaceIds)),
        limit, undefined, query.selectedPlaceId, query.visitedPlaceIds);
      };
      if (!force && currentStatus.offline) return fromCache();
      try {
        const { payload, places } = await onlineList(path, force);
        return { places, total: payload.total, limit, scope: "full", partial: payload.total > places.length };
      } catch (error) {
        if (!(error instanceof OfflinePlaceDataError)) throw error;
        return fromCache();
      }
  }

  async function fetchSearch(query: PlaceSearchQuery, force = false): Promise<PlaceDataResult> {
    const limit = boundedLimit(query.limit, 100, 25);
    const offset = Math.max(0, Math.min(10_000, Math.floor(Number.isFinite(query.offset) ? query.offset as number : 0)));
    const categories = queryCategories(query.categories);
    const authorities = queryAuthorities(query.authorities);
    const visited = visitFilter(query.visited);
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset), visited });
    if (query.query?.trim()) params.set("query", query.query.trim());
    categories.forEach((category) => params.append("category", category));
    authorities.forEach((authority) => params.append("authority", authority));
    const path = `/api/places/search?${params.toString()}`;
    const fromCache = () => {
      setOffline(true);
      const categorySet = new Set(categories);
      const authoritySet = new Set(authorities);
      const selectedVisit = (place: PlaceDataItem) => visited === "all" || ((visited === "visited") === isVisited(place, query.visitedPlaceIds));
      return cachedResult((place) => (categorySet.size === 0 || categorySet.has(place.category))
        && matchesAuthorities(place, authoritySet)
        && selectedVisit(place)
        && matchesPlaceSearch(place, query.query ?? "", `${place.authority ?? ""} ${place.listRegion ?? ""}`), limit, offset, undefined, query.visitedPlaceIds);
    };
    if (!force && currentStatus.offline) return fromCache();
    try {
      const { payload, places } = await onlineList(path, force);
      return { places, total: payload.total, limit, offset, scope: "full", partial: offset + places.length < payload.total };
    } catch (error) {
      if (!(error instanceof OfflinePlaceDataError)) throw error;
      return fromCache();
    }
  }

  async function fetchVisited(query: VisitedPlacesQuery, force = false): Promise<PlaceDataResult> {
    const limit = boundedLimit(query.limit, 100, 25);
    const offset = Math.max(0, Math.min(10_000, Math.floor(Number.isFinite(query.offset) ? query.offset as number : 0)));
    const categories = queryCategories(query.categories);
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (query.query?.trim()) params.set("query", query.query.trim());
    categories.forEach((category) => params.append("category", category));
    const path = `/api/catalogue/visited?${params.toString()}`;
    const fromCache = () => {
      setOffline(true);
      const categorySet = new Set(categories);
      return cachedResult((place) => isVisited(place, query.visitedPlaceIds)
        && (categorySet.size === 0 || categorySet.has(place.category))
        && matchesPlaceSearch(place, query.query ?? "", `${place.authority ?? ""} ${place.listRegion ?? ""}`), limit, offset, undefined, query.visitedPlaceIds);
    };
    if (!force && currentStatus.offline) return fromCache();
    try {
      const { payload, places } = await onlineList(path, force);
      return { places, total: payload.total, limit, offset, scope: "full", partial: offset + places.length < payload.total };
    } catch (error) {
      if (!(error instanceof OfflinePlaceDataError)) throw error;
      return fromCache();
    }
  }

  return {
    fetchMap(query) { return fetchMap(query); },
    retryMap(query) { return fetchMap(query, true); },
    fetchSearch(query) { return fetchSearch(query); },
    retrySearch(query) { return fetchSearch(query, true); },
    fetchVisited(query) { return fetchVisited(query); },
    retryVisited(query) { return fetchVisited(query, true); },

    async remember(place, reason = "interaction") {
      await cache.remember(place, reason);
    },

    getOfflineStatus() { return currentStatus; },

    subscribeOfflineStatus(listener) {
      listeners.add(listener);
      attachNetworkEvents();
      listener(currentStatus);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) detachNetworkEvents();
      };
    },
  };
}
