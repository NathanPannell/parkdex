"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { PostcardPhotoState } from "@/components/postcard-print";
import { notifyError } from "@/lib/application-notifications";
import { boundaryPlaceIds, loadBoundaryIndex, parseBoundaryCollection, type BoundaryCollection, type BoundaryFeature, type BoundaryIndex, type BoundaryLoadState } from "@/lib/boundaries";
import { publicAssetUrl } from "@/lib/public-assets";
import type { Place } from "@/lib/places";
import {
  mapPresentation,
  type MapPresentation,
  type MapViewport,
  type ParkMapMode,
  type RecentPostcard,
} from "@/lib/map-presentation";

export type { MapViewport } from "@/lib/map-presentation";

const EXPLORATION_TERRITORY_DATA_URL = "/data/exploration-territories.v1.geojson";
const FOCUS_MASK_DATA_URL = "/data/bc-focus-mask.v1.geojson";
export const MAX_MAP_BOUNDARY_PLACE_IDS = 50;
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

export type UseMapPresentationOptions = {
  active?: boolean;
  apiBaseUrl?: string;
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

const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const EMPTY_BOUNDARIES: BoundaryCollection = { type: "FeatureCollection", features: [] };
let mapAssetRequest: Promise<MapPresentationAssets> | null = null;
const boundaryFeatureCache = new Map<string, BoundaryFeature | null>();

type SampledBoundaryState = {
  key: string;
  status: MapAssetsState["status"];
  data: BoundaryCollection;
};

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

function normalizedMapBoundaryIds(placeIds: readonly string[]): string[] {
  return [...new Set(placeIds)].sort();
}

function boundaryCacheScope(apiBaseUrl: string | undefined): string {
  return apiBaseUrl?.replace(/\/+$/, "") || (typeof window === "undefined" ? "same-origin" : window.location.origin);
}

function boundaryCacheKey(scope: string, placeId: string): string {
  return JSON.stringify([scope, placeId]);
}

function rememberBoundaryFeature(scope: string, placeId: string, feature: BoundaryFeature | null) {
  const key = boundaryCacheKey(scope, placeId);
  boundaryFeatureCache.delete(key);
  boundaryFeatureCache.set(key, feature);
  while (boundaryFeatureCache.size > MAX_CACHED_BOUNDARY_IDS) {
    const oldestKey = boundaryFeatureCache.keys().next().value;
    if (oldestKey === undefined) break;
    boundaryFeatureCache.delete(oldestKey);
  }
}

export function cachedSampledBoundaryAsset(apiBaseUrl: string | undefined, placeIds: readonly string[]): BoundaryCollection {
  const scope = boundaryCacheScope(apiBaseUrl);
  const features = normalizedMapBoundaryIds(placeIds).flatMap((placeId) => {
    const key = boundaryCacheKey(scope, placeId);
    if (!boundaryFeatureCache.has(key)) return [];
    const feature = boundaryFeatureCache.get(key);
    if (feature === undefined) return [];
    boundaryFeatureCache.delete(key);
    boundaryFeatureCache.set(key, feature);
    return feature ? [feature] : [];
  });
  return { type: "FeatureCollection", features };
}

export function mapBoundaryRequestUrl(apiBaseUrl: string | undefined, placeIds: readonly string[]): string {
  const ids = normalizedMapBoundaryIds(placeIds);
  if (ids.length > MAX_MAP_BOUNDARY_PLACE_IDS) {
    throw new RangeError(`At most ${MAX_MAP_BOUNDARY_PLACE_IDS} map boundaries can be requested`);
  }
  const base = apiBaseUrl?.replace(/\/+$/, "") ?? "";
  const endpoint = `${base}/api/map/boundaries`;
  const params = new URLSearchParams();
  ids.forEach((id) => params.append("place_id", id));
  const query = params.toString();
  return query ? `${endpoint}?${query}` : endpoint;
}

export async function loadSampledBoundaryAsset(
  apiBaseUrl: string | undefined,
  placeIds: readonly string[],
  signal?: AbortSignal,
): Promise<BoundaryCollection> {
  const ids = normalizedMapBoundaryIds(placeIds);
  if (ids.length > MAX_MAP_BOUNDARY_PLACE_IDS) {
    throw new RangeError(`At most ${MAX_MAP_BOUNDARY_PLACE_IDS} map boundaries can be requested`);
  }
  if (ids.length === 0) return EMPTY_BOUNDARIES;
  const scope = boundaryCacheScope(apiBaseUrl);
  cachedSampledBoundaryAsset(apiBaseUrl, ids);
  const missingIds = ids.filter((placeId) => !boundaryFeatureCache.has(boundaryCacheKey(scope, placeId)));
  if (missingIds.length === 0) return cachedSampledBoundaryAsset(apiBaseUrl, ids);

  const response = await fetch(mapBoundaryRequestUrl(apiBaseUrl, missingIds), { cache: "default", signal });
  if (!response.ok) throw new Error(`Map boundaries returned ${response.status}`);
  if (signal?.aborted) throw new Error("Map boundary request was cancelled");
  const collection = parseBoundaryCollection(await response.json());
  const requestedIds = new Set(missingIds);
  const featuresById = new Map(collection.features
    .filter((feature) => requestedIds.has(feature.properties.id))
    .map((feature) => [feature.properties.id, feature]));
  missingIds.forEach((placeId) => rememberBoundaryFeature(scope, placeId, featuresById.get(placeId) ?? null));
  return cachedSampledBoundaryAsset(apiBaseUrl, ids);
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
  const [sampledBoundaryRetrySequence, setSampledBoundaryRetrySequence] = useState(0);
  const [sampledBoundary, setSampledBoundary] = useState<SampledBoundaryState>({ key: "", status: "loading", data: EMPTY_BOUNDARIES });
  const [postcardPhoto, setPostcardPhoto] = useState<PostcardPhoto>({ key: "", state: "empty" });
  const loadPhotoRef = useRef(loadPhoto);
  useEffect(() => { loadPhotoRef.current = loadPhoto; }, [loadPhoto]);
  const sampledPlaceIds = useMemo(() => normalizedMapBoundaryIds(places.map((place) => place.id)), [places]);
  const sampledPlaceIdsKey = JSON.stringify(sampledPlaceIds);
  const sampledBoundaryKey = JSON.stringify([apiBaseUrl ?? "", sampledPlaceIdsKey]);

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
    if (!active) return;
    const requestedIds = JSON.parse(sampledPlaceIdsKey) as string[];
    if (requestedIds.length === 0) return;
    const requestController = new AbortController();
    let subscribed = true;

    void loadSampledBoundaryAsset(apiBaseUrl, requestedIds, requestController.signal)
      .then((data) => {
        if (subscribed) setSampledBoundary({ key: sampledBoundaryKey, status: "ready", data });
      })
      .catch(() => {
        if (subscribed) setSampledBoundary({
          key: sampledBoundaryKey,
          status: "failed",
          data: cachedSampledBoundaryAsset(apiBaseUrl, requestedIds),
        });
      });

    return () => {
      subscribed = false;
      requestController.abort();
    };
  }, [active, apiBaseUrl, sampledBoundaryKey, sampledBoundaryRetrySequence, sampledPlaceIdsKey]);

  useEffect(() => {
    const boundaryRequestIsCurrent = sampledBoundary.key === sampledBoundaryKey;
    if (!active || !boundaryRequestIsCurrent || sampledBoundary.status !== "failed") return;
    const retry = () => {
      setSampledBoundary({ key: sampledBoundaryKey, status: "loading", data: EMPTY_BOUNDARIES });
      setSampledBoundaryRetrySequence((sequence) => sequence + 1);
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
  }, [active, sampledBoundary.key, sampledBoundary.status, sampledBoundaryKey]);

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
  const currentSampledBoundary = sampledBoundary.key === sampledBoundaryKey
    ? sampledBoundary.data
    : cachedSampledBoundaryAsset(apiBaseUrl, sampledPlaceIds);
  const presentation = useMemo(() => mapPresentation({
    places,
    visited,
    mode,
    selectedId,
    selectedIds,
    viewport,
    boundaryIndex: assets?.boundaryIndex ?? null,
    boundaryAsset: assets ? currentSampledBoundary : null,
    selectedBoundary,
  }), [assets, currentSampledBoundary, mode, places, selectedBoundary, selectedId, selectedIds, visited, viewport]);
  const ids = assets ? boundaryPlaceIds(assets.boundaryIndex) : new Set<string>();
  const currentBoundaryStatus = sampledPlaceIds.length === 0
    ? "ready"
    : sampledBoundary.key === sampledBoundaryKey ? sampledBoundary.status : "loading";
  const boundaryLoadState: BoundaryLoadState = assetStatus === "ready"
    ? { status: currentBoundaryStatus, placeIds: currentBoundaryStatus === "ready" ? ids : new Set() }
    : { status: assetStatus, placeIds: new Set() };

  return {
    ...presentation,
    boundaryIndex: assets?.boundaryIndex ?? null,
    explorationData: assets?.explorationData ?? EMPTY_FEATURE_COLLECTION,
    focusMaskData: assets?.focusMaskData ?? EMPTY_FEATURE_COLLECTION,
    boundaryLoadState,
    assets: { status: assetStatus, placeIds: ids },
    postcardPhotoState,
  };
}
