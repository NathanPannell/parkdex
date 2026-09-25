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

const BOUNDARY_DISPLAY_DATA_URL = "/data/boundaries-display.v1.geojson";
const EXPLORATION_TERRITORY_DATA_URL = "/data/exploration-territories.v1.geojson";
const FOCUS_MASK_DATA_URL = "/data/bc-focus-mask.v1.geojson";

export type MapPresentationAssets = {
  boundaryIndex: BoundaryIndex;
  boundaryAsset: BoundaryCollection;
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
let mapAssetRequest: Promise<MapPresentationAssets> | null = null;

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

/**
 * Load large map geometry into transient application memory. The requests use
 * no-store so Android does not put the display catalogue in its small content
 * cache. A successful request is shared for this page session.
 */
export function loadMapPresentationAssets(): Promise<MapPresentationAssets> {
  if (!mapAssetRequest) {
    mapAssetRequest = Promise.all([
      loadBoundaryIndex(),
      fetchFeatureCollection(BOUNDARY_DISPLAY_DATA_URL, "Display boundaries").then((value) => parseBoundaryCollection(value)),
      fetchFeatureCollection(EXPLORATION_TERRITORY_DATA_URL, "Exploration territories"),
      fetchFeatureCollection(FOCUS_MASK_DATA_URL, "Map focus mask"),
    ]).then(([boundaryIndex, boundaryAsset, explorationData, focusMaskData]) => ({
      boundaryIndex,
      boundaryAsset,
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
  const [postcardPhoto, setPostcardPhoto] = useState<PostcardPhoto>({ key: "", state: "empty" });
  const loadPhotoRef = useRef(loadPhoto);
  useEffect(() => { loadPhotoRef.current = loadPhoto; }, [loadPhoto]);

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
  const presentation = useMemo(() => mapPresentation({
    places,
    visited,
    mode,
    selectedId,
    selectedIds,
    viewport,
    boundaryIndex: assets?.boundaryIndex ?? null,
    boundaryAsset: assets?.boundaryAsset ?? null,
    selectedBoundary,
  }), [assets, mode, places, selectedBoundary, selectedId, selectedIds, visited, viewport]);
  const ids = assets ? boundaryPlaceIds(assets.boundaryIndex) : new Set<string>();
  const boundaryLoadState: BoundaryLoadState = assetStatus === "ready"
    ? { status: "ready", placeIds: ids }
    : assetStatus === "failed"
      ? { status: "failed", placeIds: new Set() }
      : { status: "loading", placeIds: new Set() };

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
