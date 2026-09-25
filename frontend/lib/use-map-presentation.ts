"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { PostcardPhotoState } from "@/components/postcard-print";
import { notifyError } from "@/lib/application-notifications";
import { boundaryPlaceIds, geometryBounds, loadBoundaryIndex, parseBoundaryCollection, type BoundaryCollection, type BoundaryFeature, type BoundaryIndex, type BoundaryLoadState } from "@/lib/boundaries";
import { publicAssetUrl } from "@/lib/public-assets";
import type { Place } from "@/lib/places";
import {
  boundsIntersectViewport,
  mapPresentation,
  type BoundaryViewport,
  type MapPresentation,
  type MapViewport,
  type ParkMapMode,
  type RecentPostcard,
} from "@/lib/map-presentation";

export type { MapViewport } from "@/lib/map-presentation";

const EXPLORATION_TERRITORY_DATA_URL = "/data/exploration-territories.v1.geojson";
const FOCUS_MASK_DATA_URL = "/data/bc-focus-mask.v1.geojson";
const MAX_CACHED_BOUNDARY_IDS = 100;

export type MapPresentationAssets = {
  boundaryIndex: BoundaryIndex;
  explorationData: GeoJSON.FeatureCollection;
  focusMaskData: GeoJSON.FeatureCollection;
};

export type MapAssetsState =
  | { status: "loading"; placeIds: ReadonlySet<string> }
  | { status: "ready"; placeIds: ReadonlySet<string> }
  | { status: "failed"; placeIds: ReadonlySet<string> };

export type MapPostcardPhotoState = {
  url?: string;
  state: PostcardPhotoState;
};

export type ViewportBoundaryCoverage = BoundaryViewport;

export type UseMapPresentationOptions = {
  active?: boolean;
  apiBaseUrl?: string;
  identityKey?: string;
  places: readonly Place[];
  visited: ReadonlySet<string>;
  mode: ParkMapMode;
  selectedId: string | null;
  selectedIds?: ReadonlySet<string>;
  selectedBoundary?: BoundaryFeature | null;
  viewport: MapViewport | null;
  recentPostcard?: RecentPostcard;
  loadPhoto?: (placeId: string) => Promise<Blob>;
  photoOwnerKey?: string;
};

export type UseMapPresentationResult = MapPresentation & {
  boundaryIndex: BoundaryIndex | null;
  explorationData: GeoJSON.FeatureCollection;
  focusMaskData: GeoJSON.FeatureCollection;
  boundaryLoadState: BoundaryLoadState;
  assets: MapAssetsState;
  postcardPhotoState: MapPostcardPhotoState;
};

type PostcardPhoto = {
  key: string;
  url?: string;
  state: PostcardPhotoState;
};

type LoadedViewportBoundaries = {
  scope: string;
  coverage: BoundaryViewport;
  data: BoundaryCollection;
};

type ViewportBoundaryRequest = {
  scope: string;
  key: string;
  status: "loading" | "ready" | "failed";
};

const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const EMPTY_BOUNDARIES: BoundaryCollection = { type: "FeatureCollection", features: [] };
const EMPTY_BOUNDARY_IDS: ReadonlySet<string> = new Set();
let mapAssetRequest: Promise<MapPresentationAssets> | null = null;
type CachedBoundaryFeature = {
  scope: string;
  wave: number;
  priority: boolean;
  feature: BoundaryFeature;
};
const boundaryFeatureCache = new Map<string, CachedBoundaryFeature>();
const boundaryCacheWaveByScope = new Map<string, number>();

function mergeBoundaryCollections(...collections: readonly BoundaryCollection[]): BoundaryCollection {
  const features = new Map<string, BoundaryFeature>();
  collections.forEach((collection) => collection.features.forEach((feature) => features.set(feature.properties.id, feature)));
  return { type: "FeatureCollection", features: [...features.values()] };
}

function parseFeatureCollection(value: unknown, label: string): GeoJSON.FeatureCollection {
  if (typeof value !== "object" || value === null || (value as { type?: unknown }).type !== "FeatureCollection" || !Array.isArray((value as { features?: unknown }).features)) {
    throw new Error(`${label} is not a GeoJSON FeatureCollection`);
  }
  return value as GeoJSON.FeatureCollection;
}

async function fetchFeatureCollection(path: string, label: string): Promise<GeoJSON.FeatureCollection> {
  const response = await fetch(publicAssetUrl(path), { cache: "no-store" });
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  return parseFeatureCollection(await response.json(), label);
}

function boundaryCacheScope(apiBaseUrl: string | undefined, identityKey: string): string {
  const apiScope = apiBaseUrl?.replace(/\/+$/, "") || (typeof window === "undefined" ? "same-origin" : window.location.origin);
  return JSON.stringify([apiScope, identityKey]);
}

function boundaryCacheKey(scope: string, placeId: string): string {
  return JSON.stringify([scope, placeId]);
}

function rememberBoundaryFeature(scope: string, placeId: string, entry: CachedBoundaryFeature) {
  const key = boundaryCacheKey(scope, placeId);
  boundaryFeatureCache.delete(key);
  boundaryFeatureCache.set(key, entry);
  while (boundaryFeatureCache.size > MAX_CACHED_BOUNDARY_IDS) {
    const oldestKey = boundaryFeatureCache.keys().next().value;
    if (oldestKey === undefined) break;
    boundaryFeatureCache.delete(oldestKey);
  }
}

export function viewportBoundaryRequestUrl(apiBaseUrl: string | undefined, viewport: BoundaryViewport): string {
  const base = apiBaseUrl?.replace(/\/+$/, "") ?? "";
  const endpoint = `${base}/api/map/boundaries`;
  const params = new URLSearchParams();
  params.set("west", String(viewport.west));
  params.set("south", String(viewport.south));
  params.set("east", String(viewport.east));
  params.set("north", String(viewport.north));
  return `${endpoint}?${params.toString()}`;
}

function longitudeSpan(viewport: BoundaryViewport): number {
  const span = viewport.east >= viewport.west
    ? viewport.east - viewport.west
    : viewport.east + 360 - viewport.west;
  return Math.max(0, Math.min(360, span));
}

function wrapLongitude(longitude: number): number {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

/** Request a small buffer so short pans reuse a complete set of nearby polygons. */
export function paddedBoundaryViewport(viewport: BoundaryViewport, paddingFraction = 0.18): ViewportBoundaryCoverage {
  const span = longitudeSpan(viewport);
  if (span >= 360 || span + span * paddingFraction * 2 >= 360) {
    return { west: -180, south: -90, east: 180, north: 90 };
  }
  const longitudePadding = span * paddingFraction;
  const latitudePadding = (viewport.north - viewport.south) * paddingFraction;
  return {
    west: wrapLongitude(viewport.west - longitudePadding),
    south: Math.max(-90, viewport.south - latitudePadding),
    east: wrapLongitude(viewport.west + span + longitudePadding),
    north: Math.min(90, viewport.north + latitudePadding),
  };
}

function longitudeInterval(viewport: BoundaryViewport): [number, number] {
  return [viewport.west, viewport.west + longitudeSpan(viewport)];
}

export function viewportWithinBoundaryCoverage(viewport: BoundaryViewport, coverage: ViewportBoundaryCoverage): boolean {
  if (viewport.south < coverage.south || viewport.north > coverage.north) return false;
  const targetSpan = longitudeSpan(viewport);
  const coverageSpan = longitudeSpan(coverage);
  if (coverageSpan >= 360) return true;
  if (targetSpan > coverageSpan) return false;
  const [coverageWest, coverageEast] = longitudeInterval(coverage);
  const [targetWest, targetEast] = longitudeInterval(viewport);
  return [-360, 0, 360].some((shift) => targetWest + shift >= coverageWest - 1e-8
    && targetEast + shift <= coverageEast + 1e-8);
}

function boundaryHash(id: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function rememberViewportFeatures(scope: string, collection: BoundaryCollection, priorityIds: readonly string[]) {
  const currentWave = (boundaryCacheWaveByScope.get(scope) ?? 0) + 1;
  const previousWave = currentWave - 1;
  const unique = [...new Map(collection.features.map((feature) => [feature.properties.id, feature])).values()];
  const currentById = new Map(unique.map((feature) => [feature.properties.id, feature]));
  const prioritySet = new Set<string>();
  const priorities = priorityIds.flatMap((id) => {
    const feature = currentById.get(id);
    if (!feature || prioritySet.has(id)) return [];
    prioritySet.add(id);
    return [feature];
  }).slice(0, MAX_CACHED_BOUNDARY_IDS);
  const extras = unique
    .filter((feature) => !prioritySet.has(feature.properties.id))
    .sort((left, right) => boundaryHash(left.properties.id).localeCompare(boundaryHash(right.properties.id))
      || left.properties.id.localeCompare(right.properties.id));
  const currentIds = new Set(unique.map((feature) => feature.properties.id));
  const previous = [...boundaryFeatureCache.values()]
    .filter((entry) => entry.scope === scope && entry.wave === previousWave && !currentIds.has(entry.feature.properties.id))
    .sort((left, right) => Number(right.priority) - Number(left.priority)
      || boundaryHash(left.feature.properties.id).localeCompare(boundaryHash(right.feature.properties.id))
      || left.feature.properties.id.localeCompare(right.feature.properties.id));
  const priorTarget = Math.min(previous.length, Math.floor((MAX_CACHED_BOUNDARY_IDS - priorities.length) / 2));
  const currentExtras = extras.slice(0, Math.max(0, MAX_CACHED_BOUNDARY_IDS - priorities.length - priorTarget));
  const remainingPrior = Math.max(0, MAX_CACHED_BOUNDARY_IDS - priorities.length - currentExtras.length - priorTarget);
  const retainedPrior = previous.slice(0, priorTarget + remainingPrior);

  for (const [key, entry] of boundaryFeatureCache) {
    if (entry.scope === scope) boundaryFeatureCache.delete(key);
  }
  retainedPrior.forEach((entry) => rememberBoundaryFeature(scope, entry.feature.properties.id, entry));
  currentExtras.forEach((feature) => rememberBoundaryFeature(scope, feature.properties.id, {
    scope,
    wave: currentWave,
    priority: false,
    feature,
  }));
  priorities.forEach((feature) => rememberBoundaryFeature(scope, feature.properties.id, {
    scope,
    wave: currentWave,
    priority: true,
    feature,
  }));
  boundaryCacheWaveByScope.set(scope, currentWave);
}

export function cachedViewportBoundaryAsset(
  apiBaseUrl: string | undefined,
  identityKey: string,
  viewport: BoundaryViewport,
): BoundaryCollection {
  const scope = boundaryCacheScope(apiBaseUrl, identityKey);
  const matches: Array<{ key: string; feature: BoundaryFeature }> = [];
  boundaryFeatureCache.forEach((entry, key) => {
    if (entry.scope !== scope) return;
    const bounds = geometryBounds(entry.feature.geometry);
    if (bounds && boundsIntersectViewport(bounds, viewport)) matches.push({ key, feature: entry.feature });
  });
  matches.forEach(({ key }) => {
    const entry = boundaryFeatureCache.get(key);
    if (entry === undefined) return;
    boundaryFeatureCache.delete(key);
    boundaryFeatureCache.set(key, entry);
  });
  return { type: "FeatureCollection", features: matches.map(({ feature }) => feature) };
}

export async function loadViewportBoundaryAsset(
  apiBaseUrl: string | undefined,
  identityKey: string,
  viewport: BoundaryViewport,
  priorityIds: readonly string[] | (() => readonly string[]),
  signal?: AbortSignal,
): Promise<BoundaryCollection> {
  const scope = boundaryCacheScope(apiBaseUrl, identityKey);
  const coverage = paddedBoundaryViewport(viewport);
  const response = await fetch(viewportBoundaryRequestUrl(apiBaseUrl, coverage), { cache: "default", signal });
  if (!response.ok) throw new Error(`Map boundaries returned ${response.status}`);
  if (signal?.aborted) throw new Error("Map boundary request was cancelled");
  const collection = parseBoundaryCollection(await response.json());
  if (signal?.aborted) throw new Error("Map boundary request was cancelled");
  rememberViewportFeatures(scope, collection, typeof priorityIds === "function" ? priorityIds() : priorityIds);
  return collection;
}

/**
 * Load static map overlays into transient application memory. The requests use
 * no-store so Android does not put the large exploration and focus overlays in
 * its small content cache. A successful request is shared for this page session.
 */
export function loadMapPresentationAssets(): Promise<MapPresentationAssets> {
  if (!mapAssetRequest) {
    mapAssetRequest = Promise.all([
      loadBoundaryIndex(),
      fetchFeatureCollection(EXPLORATION_TERRITORY_DATA_URL, "Exploration territories"),
      fetchFeatureCollection(FOCUS_MASK_DATA_URL, "Map focus mask"),
    ]).then(([boundaryIndex, explorationData, focusMaskData]) => ({
      boundaryIndex,
      explorationData,
      focusMaskData,
    })).catch((error) => {
      mapAssetRequest = null;
      throw error;
    });
  }
  return mapAssetRequest;
}

/** Reset the in-memory request cache in tests after mocked asset responses. */
export function resetMapPresentationAssetCache(): void {
  mapAssetRequest = null;
  boundaryFeatureCache.clear();
  boundaryCacheWaveByScope.clear();
}

export function postcardPhotoKey(ownerKey: string, postcard?: RecentPostcard): string {
  const hasPhoto = postcard?.visit.claim?.hasPhoto === true;
  return `${ownerKey}:${postcard?.place.id ?? "none"}:${postcard?.visit.visitedAt ?? "none"}:${hasPhoto ? "photo" : "visit"}`;
}

export function postcardMarkerCoordinates(postcard?: RecentPostcard): Pick<Place, "latitude" | "longitude"> | null {
  if (!postcard) return null;
  const claimed = postcard.visit.claim?.coordinates;
  if (claimed && Number.isFinite(claimed.latitude) && Number.isFinite(claimed.longitude)) {
    return { latitude: claimed.latitude, longitude: claimed.longitude };
  }
  if (Number.isFinite(postcard.place.latitude) && Number.isFinite(postcard.place.longitude)) {
    return { latitude: postcard.place.latitude, longitude: postcard.place.longitude };
  }
  return null;
}

export function loadPostcardPhotoUrl(
  loadPhoto: (placeId: string) => Promise<Blob>,
  placeId: string,
  key: string,
  onLoaded: (url: string, key: string) => void,
  onFailed: (key: string) => void,
): () => void {
  let active = true;
  let objectUrl: string | null = null;
  void loadPhoto(placeId).then((blob) => {
    if (!active) return;
    objectUrl = URL.createObjectURL(blob);
    onLoaded(objectUrl, key);
  }).catch(() => {
    if (active) onFailed(key);
  });
  return () => {
    active = false;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}

export function useMapPresentation({
  active = true,
  apiBaseUrl,
  identityKey = "",
  places,
  visited,
  mode,
  selectedId,
  selectedIds = new Set<string>(),
  selectedBoundary = null,
  viewport,
  recentPostcard,
  loadPhoto,
  photoOwnerKey = "current",
}: UseMapPresentationOptions): UseMapPresentationResult {
  const [assets, setAssets] = useState<MapPresentationAssets | null>(null);
  const [assetStatus, setAssetStatus] = useState<MapAssetsState["status"]>("loading");
  const [assetRetrySequence, setAssetRetrySequence] = useState(0);
  const [viewportBoundaryRetrySequence, setViewportBoundaryRetrySequence] = useState(0);
  const [loadedViewportBoundaries, setLoadedViewportBoundaries] = useState<LoadedViewportBoundaries | null>(null);
  const [viewportBoundaryRequest, setViewportBoundaryRequest] = useState<ViewportBoundaryRequest | null>(null);
  const [postcardPhoto, setPostcardPhoto] = useState<PostcardPhoto>({ key: "", state: "empty" });
  const loadPhotoRef = useRef(loadPhoto);
  useEffect(() => { loadPhotoRef.current = loadPhoto; }, [loadPhoto]);
  const boundaryPriorityIds = useMemo(() => places.map((place) => place.id), [places]);
  const boundaryPriorityIdsRef = useRef(boundaryPriorityIds);
  useEffect(() => { boundaryPriorityIdsRef.current = boundaryPriorityIds; }, [boundaryPriorityIds]);
  const boundaryScope = boundaryCacheScope(apiBaseUrl, identityKey);
  const viewportWest = viewport?.west;
  const viewportSouth = viewport?.south;
  const viewportEast = viewport?.east;
  const viewportNorth = viewport?.north;
  const boundaryViewport = useMemo(() => viewportWest == null || viewportSouth == null || viewportEast == null || viewportNorth == null
    ? null
    : { west: viewportWest, south: viewportSouth, east: viewportEast, north: viewportNorth },
  [viewportEast, viewportNorth, viewportSouth, viewportWest]);
  const boundaryCoverage = useMemo(() => boundaryViewport ? paddedBoundaryViewport(boundaryViewport) : null, [boundaryViewport]);
  const boundaryRequestKey = boundaryCoverage
    ? JSON.stringify([boundaryScope, boundaryCoverage.west, boundaryCoverage.south, boundaryCoverage.east, boundaryCoverage.north])
    : "";
  const loadedBoundaryHasCoverage = Boolean(loadedViewportBoundaries
    && loadedViewportBoundaries.scope === boundaryScope
    && boundaryViewport
    && viewportWithinBoundaryCoverage(boundaryViewport, loadedViewportBoundaries.coverage));

  useEffect(() => {
    if (!active || assets) return;
    let subscribed = true;
    void loadMapPresentationAssets().then((loaded) => {
      if (!subscribed) return;
      setAssets(loaded);
      setAssetStatus("ready");
    }).catch((error: unknown) => {
      if (!subscribed) return;
      setAssetStatus("failed");
      notifyError(error, "Map detail could not load. Reconnect to load park boundaries.");
    });
    return () => { subscribed = false; };
  }, [active, assetRetrySequence, assets]);

  useEffect(() => {
    if (!active || assets || assetStatus !== "failed") return;
    const retry = () => {
      setAssetStatus("loading");
      setAssetRetrySequence((sequence) => sequence + 1);
    };
    const retryOnConnection = () => retry();
    const retryOnForeground = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("online", retryOnConnection);
    document.addEventListener("visibilitychange", retryOnForeground);
    return () => {
      window.removeEventListener("online", retryOnConnection);
      document.removeEventListener("visibilitychange", retryOnForeground);
    };
  }, [active, assetStatus, assets]);

  useEffect(() => {
    if (!active || !boundaryViewport || !boundaryCoverage || loadedBoundaryHasCoverage) return;
    const requestController = new AbortController();
    let subscribed = true;
    let settled = false;
    queueMicrotask(() => {
      if (subscribed && !settled) {
        setViewportBoundaryRequest({ scope: boundaryScope, key: boundaryRequestKey, status: "loading" });
      }
    });

    void loadViewportBoundaryAsset(apiBaseUrl, identityKey, boundaryViewport, () => boundaryPriorityIdsRef.current, requestController.signal)
      .then((data) => {
        settled = true;
        if (!subscribed) return;
        setLoadedViewportBoundaries({ scope: boundaryScope, coverage: boundaryCoverage, data });
        setViewportBoundaryRequest({ scope: boundaryScope, key: boundaryRequestKey, status: "ready" });
      })
      .catch(() => {
        settled = true;
        if (subscribed) setViewportBoundaryRequest({ scope: boundaryScope, key: boundaryRequestKey, status: "failed" });
      });

    return () => {
      subscribed = false;
      requestController.abort();
    };
  }, [active, apiBaseUrl, identityKey, boundaryScope, boundaryRequestKey, boundaryViewport, boundaryCoverage,
    viewportWest, viewportSouth, viewportEast, viewportNorth, loadedBoundaryHasCoverage, viewportBoundaryRetrySequence]);

  useEffect(() => {
    const boundaryRequestIsCurrent = viewportBoundaryRequest?.scope === boundaryScope
      && viewportBoundaryRequest.key === boundaryRequestKey;
    if (!active || !boundaryViewport || !boundaryRequestIsCurrent || viewportBoundaryRequest.status !== "failed") return;
    const retry = () => {
      setViewportBoundaryRetrySequence((sequence) => sequence + 1);
    };
    const retryOnForeground = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", retryOnForeground);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retryOnForeground);
    };
  }, [active, boundaryScope, boundaryRequestKey, boundaryViewport, viewportBoundaryRequest]);

  const postcardPlaceId = recentPostcard?.place.id;
  const postcardHasPhoto = recentPostcard?.visit.claim?.hasPhoto === true;
  const currentPostcardPhotoKey = postcardPhotoKey(photoOwnerKey, recentPostcard);
  const canCreatePhotoUrl = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";

  useEffect(() => {
    if (!active || !postcardPlaceId || !postcardHasPhoto || !loadPhotoRef.current || !canCreatePhotoUrl) return;
    return loadPostcardPhotoUrl(
      (placeId) => loadPhotoRef.current!(placeId),
      postcardPlaceId,
      currentPostcardPhotoKey,
      (url, key) => setPostcardPhoto({ key, url, state: "empty" }),
      (key) => setPostcardPhoto({ key, state: "failed" }),
    );
  }, [active, canCreatePhotoUrl, currentPostcardPhotoKey, postcardHasPhoto, postcardPlaceId]);

  const matchingPostcardPhoto = postcardPhoto.key === currentPostcardPhotoKey ? postcardPhoto : null;
  const postcardPhotoState: MapPostcardPhotoState = matchingPostcardPhoto
    ? { url: matchingPostcardPhoto.url, state: matchingPostcardPhoto.state }
    : { state: postcardHasPhoto && loadPhoto && canCreatePhotoUrl ? "loading" : postcardHasPhoto ? "failed" : "empty" };
  const priorBoundaryData = loadedViewportBoundaries?.scope === boundaryScope ? loadedViewportBoundaries.data : EMPTY_BOUNDARIES;
  const cachedBoundaryData = useMemo(() => boundaryViewport
    ? cachedViewportBoundaryAsset(apiBaseUrl, identityKey, boundaryViewport)
    : EMPTY_BOUNDARIES, [apiBaseUrl, boundaryViewport, identityKey]);
  const currentBoundaryData = useMemo(() => loadedBoundaryHasCoverage
    ? loadedViewportBoundaries!.data
    : viewportBoundaryRequest?.scope === boundaryScope
      && viewportBoundaryRequest.key === boundaryRequestKey
      && viewportBoundaryRequest.status === "failed"
      ? mergeBoundaryCollections(priorBoundaryData, cachedBoundaryData)
      : priorBoundaryData.features.length ? priorBoundaryData : cachedBoundaryData,
  [boundaryRequestKey, boundaryScope, cachedBoundaryData, loadedBoundaryHasCoverage, loadedViewportBoundaries, priorBoundaryData, viewportBoundaryRequest]);
  const boundaryIndex = assets?.boundaryIndex ?? null;
  const presentation = useMemo(() => mapPresentation({
    places,
    visited,
    mode,
    selectedId,
    selectedIds,
    viewport,
    boundaryIndex,
    boundaryAsset: currentBoundaryData,
    selectedBoundary,
  }), [boundaryIndex, currentBoundaryData, mode, places, selectedBoundary, selectedId, selectedIds, visited, viewport]);
  const boundaryIds = useMemo(() => new Set(presentation.boundaryData.features.map((feature) => feature.properties.id)), [presentation.boundaryData]);
  const ids = useMemo(() => assets ? boundaryPlaceIds(assets.boundaryIndex) : EMPTY_BOUNDARY_IDS, [assets]);
  const currentBoundaryStatus = loadedBoundaryHasCoverage
    ? "ready"
    : viewportBoundaryRequest?.scope === boundaryScope && viewportBoundaryRequest.key === boundaryRequestKey
      ? viewportBoundaryRequest.status
      : "loading";
  const boundaryLoadState: BoundaryLoadState = useMemo(() => assetStatus === "ready"
    ? { status: currentBoundaryStatus, placeIds: currentBoundaryStatus === "ready" ? ids : EMPTY_BOUNDARY_IDS }
    : { status: assetStatus, placeIds: EMPTY_BOUNDARY_IDS }, [assetStatus, currentBoundaryStatus, ids]);

  return {
    ...presentation,
    boundaryIds,
    boundaryIndex,
    explorationData: assets?.explorationData ?? EMPTY_FEATURE_COLLECTION,
    focusMaskData: assets?.focusMaskData ?? EMPTY_FEATURE_COLLECTION,
    boundaryLoadState,
    assets: { status: assetStatus, placeIds: ids },
    postcardPhotoState,
  };
}
