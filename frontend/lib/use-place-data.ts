"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MapViewport } from "./map-presentation";
import {
  createPlaceGateway,
  PLACE_MAP_RESULT_LIMIT,
  type PlaceDataItem,
  type PlaceDataResult,
  type PlaceGateway,
  type PlaceVisitFilter,
} from "./place-data-gateway";
import type { PlaceCategory } from "./places";
import { currentNativeAppState, NATIVE_APP_STATE_EVENT } from "./native-capabilities";

const EMPTY_RESULT: PlaceDataResult = { places: [], total: 0, limit: PLACE_MAP_RESULT_LIMIT, scope: "full", partial: false };

type Options = {
  apiBaseUrl: string;
  ownerKey: string;
  headers: Record<string, string>;
  viewport: MapViewport | null;
  selectedId: string | null;
  groupId?: string | null;
  groupPlaceIds?: ReadonlySet<string>;
  mapQuery: string;
  mapCategories: ReadonlySet<PlaceCategory>;
  collectionQuery: string;
  collectionCategories: ReadonlySet<PlaceCategory>;
  mapAuthorities: ReadonlySet<string>;
  collectionAuthorities: ReadonlySet<string>;
  visitFilter: PlaceVisitFilter;
  visitedIds: ReadonlySet<string>;
  searchDraft: string;
  searchExpanded: boolean;
  view: string;
};

type Result = {
  map: PlaceDataResult;
  mapSearch: PlaceDataResult;
  collection: PlaceDataResult;
  visited: PlaceDataResult;
  offline: boolean;
  error: string;
  gateway: PlaceGateway | null;
  retry: () => void;
  loadMoreCollection: () => void;
  loadMoreVisited: () => void;
  searchPlaces: (query: string) => Promise<PlaceDataItem[]>;
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The place service is unavailable.";
}

/** Queries the server after map movement and mirrors those query shapes against saved records offline. */
export function usePlaceData(options: Options): Result {
  const authorization = options.headers.Authorization;
  const collectionKey = options.headers["X-Collection-Key"];
  const gateway = useMemo(() => options.ownerKey
    ? createPlaceGateway({
      apiBaseUrl: options.apiBaseUrl,
      identityKey: options.ownerKey,
      getHeaders: (): Record<string, string> => authorization
        ? { Authorization: authorization }
        : collectionKey ? { "X-Collection-Key": collectionKey } : {},
    })
    : null, [options.apiBaseUrl, options.ownerKey, authorization, collectionKey]);
  const [mapState, setMapState] = useState<{
    scopeKey: string;
    stableQueryKey: string;
    gateway: PlaceGateway | null;
    result: PlaceDataResult;
  }>({ scopeKey: "", stableQueryKey: "", gateway: null, result: EMPTY_RESULT });
  const [mapSearchState, setMapSearchState] = useState<{ key: string; result: PlaceDataResult }>({ key: "", result: EMPTY_RESULT });
  const [collectionState, setCollectionState] = useState<{ key: string; result: PlaceDataResult }>({ key: "", result: EMPTY_RESULT });
  const [visitedState, setVisitedState] = useState<{ key: string; result: PlaceDataResult }>({ key: "", result: EMPTY_RESULT });
  const collectionPageInFlight = useRef<string | null>(null);
  const visitedPageInFlight = useRef<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");
  const [retryGeneration, setRetryGeneration] = useState(0);
  const forceRetryRef = useRef(false);
  const activeViewRef = useRef(options.view);
  useEffect(() => { activeViewRef.current = options.view; }, [options.view]);
  const mapCategoriesKey = [...options.mapCategories].sort().join(",");
  const collectionCategoriesKey = [...options.collectionCategories].sort().join(",");
  const mapAuthoritiesKey = [...options.mapAuthorities].sort().join("\u0001");
  const collectionAuthoritiesKey = [...options.collectionAuthorities].sort().join("\u0001");
  const visitedKey = [...options.visitedIds].sort().join("\u0001");
  const groupPlaceIdsKey = options.groupPlaceIds ? [...options.groupPlaceIds].sort().join("\u0001") : "";
  const mapScopeKey = JSON.stringify([options.apiBaseUrl, options.ownerKey]);
  const mapStableQueryKey = JSON.stringify([options.ownerKey, options.mapQuery, mapCategoriesKey,
    mapAuthoritiesKey, options.visitFilter, visitedKey, options.selectedId, options.groupId,
    groupPlaceIdsKey, offline]);
  const mapQueryKey = JSON.stringify([mapStableQueryKey, options.viewport?.west, options.viewport?.south,
    options.viewport?.east, options.viewport?.north]);
  const mapSearchQueryKey = JSON.stringify([options.ownerKey, options.searchExpanded, options.searchDraft,
    mapCategoriesKey, mapAuthoritiesKey, options.visitFilter, visitedKey, offline]);
  const collectionQueryKey = JSON.stringify([options.ownerKey, options.view, options.collectionQuery,
    collectionCategoriesKey, collectionAuthoritiesKey, options.visitFilter, visitedKey, offline]);
  const visitedQueryKey = JSON.stringify([options.ownerKey, options.view, visitedKey, offline]);
  // Keep the last complete map sample only across viewport-only requests.
  // Filter, visit, group, offline, owner, and gateway changes must not show a
  // result that does not match the active map query.
  const map = mapState.scopeKey === mapScopeKey && mapState.gateway === gateway
    && mapState.stableQueryKey === mapStableQueryKey
    ? mapState.result
    : EMPTY_RESULT;
  const mapSearch = mapSearchState.key === mapSearchQueryKey ? mapSearchState.result : EMPTY_RESULT;
  const collection = collectionState.key === collectionQueryKey ? collectionState.result : EMPTY_RESULT;
  const visited = visitedState.key === visitedQueryKey ? visitedState.result : EMPTY_RESULT;
  const viewport = options.viewport;
  const mapQuery = options.mapQuery;
  const collectionQuery = options.collectionQuery;
  const searchDraft = options.searchDraft;
  const selectedId = options.selectedId;
  const visitFilter = options.visitFilter;

  useEffect(() => {
    queueMicrotask(() => {
      setMapState({ scopeKey: "", stableQueryKey: "", gateway: null, result: EMPTY_RESULT });
      setMapSearchState({ key: "", result: EMPTY_RESULT });
      setCollectionState({ key: "", result: EMPTY_RESULT });
      setVisitedState({ key: "", result: EMPTY_RESULT });
      setError("");
    });
  }, [gateway, mapScopeKey]);

  useEffect(() => {
    if (!gateway) return;
    return gateway.subscribeOfflineStatus((status) => setOffline(status.offline));
  }, [gateway]);

  useEffect(() => {
    if (!gateway || !viewport) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const query = {
        viewport,
        query: mapQuery,
        categories: mapCategoriesKey ? mapCategoriesKey.split(",") as PlaceCategory[] : [],
        authorities: mapAuthoritiesKey ? mapAuthoritiesKey.split("\u0001") : [],
        visited: visitFilter,
        visitedPlaceIds: options.visitedIds,
        selectedPlaceId: selectedId,
        groupId: options.groupId,
        groupPlaceIds: options.groupPlaceIds,
        limit: PLACE_MAP_RESULT_LIMIT,
      };
      const force = activeViewRef.current === "map" && forceRetryRef.current;
      if (force) forceRetryRef.current = false;
      const request = force ? gateway.retryMap(query) : gateway.fetchMap(query);
      void request.then((result) => {
        if (!active) return;
        setMapState({ scopeKey: mapScopeKey, stableQueryKey: mapStableQueryKey, gateway, result });
        setError("");
      }).catch((failure) => {
        if (active) {
          setError(messageFor(failure));
        }
      });
    }, 140);
    return () => { active = false; window.clearTimeout(timer); };
  }, [gateway, mapScopeKey, viewport, mapQuery, mapCategoriesKey,
    mapAuthoritiesKey, visitFilter, visitedKey, options.visitedIds, selectedId, options.groupId, options.groupPlaceIds, groupPlaceIdsKey,
    mapStableQueryKey, mapQueryKey, offline, retryGeneration]);

  useEffect(() => {
    if (!gateway || !options.searchExpanded || !searchDraft.trim()) {
      queueMicrotask(() => setMapSearchState({ key: mapSearchQueryKey, result: EMPTY_RESULT }));
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      const query = {
        query: searchDraft,
        categories: mapCategoriesKey ? mapCategoriesKey.split(",") as PlaceCategory[] : [],
        authorities: mapAuthoritiesKey ? mapAuthoritiesKey.split("\u0001") : [],
        visited: visitFilter,
        visitedPlaceIds: options.visitedIds,
        limit: 20,
      };
      const force = forceRetryRef.current && options.view === "map" && !viewport;
      if (force) forceRetryRef.current = false;
      void (force ? gateway.retrySearch(query) : gateway.fetchSearch(query)).then((result) => {
        if (active) setMapSearchState({ key: mapSearchQueryKey, result });
      }).catch((failure) => {
        if (active) { setMapSearchState({ key: mapSearchQueryKey, result: EMPTY_RESULT }); setError(messageFor(failure)); }
      });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [gateway, options.searchExpanded, options.view, searchDraft, mapCategoriesKey, mapAuthoritiesKey, visitFilter, visitedKey, options.visitedIds, mapSearchQueryKey, viewport, offline, retryGeneration]);

  useEffect(() => {
    if (!gateway || options.view !== "collection") return;
    let active = true;
    const timer = window.setTimeout(() => {
      const query = {
        query: collectionQuery,
        categories: collectionCategoriesKey ? collectionCategoriesKey.split(",") as PlaceCategory[] : [],
        authorities: collectionAuthoritiesKey ? collectionAuthoritiesKey.split("\u0001") : [],
        visited: visitFilter,
        visitedPlaceIds: options.visitedIds,
        limit: 50,
      };
      const force = forceRetryRef.current && options.view === "collection";
      if (force) forceRetryRef.current = false;
      void (force ? gateway.retrySearch(query) : gateway.fetchSearch(query)).then((result) => {
        if (active) { setCollectionState({ key: collectionQueryKey, result }); setError(""); }
      }).catch((failure) => { if (active) setError(messageFor(failure)); });
    }, 160);
    return () => { active = false; window.clearTimeout(timer); };
  }, [gateway, options.view, collectionQuery, collectionCategoriesKey, collectionAuthoritiesKey, visitFilter, visitedKey, options.visitedIds, collectionQueryKey, viewport, offline, retryGeneration]);

  useEffect(() => {
    if (!gateway || options.view !== "account") return;
    let active = true;
    const query = { visitedPlaceIds: options.visitedIds, limit: 50 };
      const force = forceRetryRef.current && options.view === "account";
    if (force) forceRetryRef.current = false;
    void (force ? gateway.retryVisited(query) : gateway.fetchVisited(query)).then((result) => {
      if (active) setVisitedState({ key: visitedQueryKey, result });
    }).catch((failure) => { if (active) setError(messageFor(failure)); });
    return () => { active = false; };
  }, [gateway, options.view, visitedKey, options.visitedIds, visitedQueryKey, viewport, offline, retryGeneration]);

  const retry = useCallback(() => {
    forceRetryRef.current = true;
    setRetryGeneration((value) => value + 1);
  }, []);
  useEffect(() => {
    const onOnline = () => retry();
    const onResume = () => { if (document.visibilityState === "visible" && gateway?.getOfflineStatus().offline) retry(); };
    const onNativeResume = () => {
      if (document.visibilityState !== "hidden" && currentNativeAppState() && gateway?.getOfflineStatus().offline) retry();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener(NATIVE_APP_STATE_EVENT, onNativeResume);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener(NATIVE_APP_STATE_EVENT, onNativeResume);
    };
  }, [gateway, retry]);

  const loadMoreCollection = useCallback(() => {
    if (!gateway || collection.places.length >= collection.total) return;
    const offset = collection.places.length;
    const pageKey = `${collectionQueryKey}:${offset}`;
    if (collectionPageInFlight.current === pageKey) return;
    collectionPageInFlight.current = pageKey;
    void gateway.fetchSearch({
      query: collectionQuery,
      categories: collectionCategoriesKey ? collectionCategoriesKey.split(",") as PlaceCategory[] : [],
      authorities: collectionAuthoritiesKey ? collectionAuthoritiesKey.split("\u0001") : [],
      visited: visitFilter,
      visitedPlaceIds: options.visitedIds,
      limit: 50,
      offset,
    }).then((next) => setCollectionState((current) => current.key === collectionQueryKey && current.result.places.length === offset
      ? { key: collectionQueryKey, result: { ...next, places: [...current.result.places, ...next.places] } }
      : current))
      .catch((failure) => setError(messageFor(failure)))
      .finally(() => { if (collectionPageInFlight.current === pageKey) collectionPageInFlight.current = null; });
  }, [gateway, collection, collectionQuery, collectionCategoriesKey, collectionAuthoritiesKey, visitFilter, options.visitedIds, collectionQueryKey]);

  const loadMoreVisited = useCallback(() => {
    if (!gateway || visited.places.length >= visited.total) return;
    const offset = visited.places.length;
    const pageKey = `${visitedQueryKey}:${offset}`;
    if (visitedPageInFlight.current === pageKey) return;
    visitedPageInFlight.current = pageKey;
    void gateway.fetchVisited({ visitedPlaceIds: options.visitedIds, limit: 50, offset })
      .then((next) => setVisitedState((current) => current.key === visitedQueryKey && current.result.places.length === offset
        ? { key: visitedQueryKey, result: { ...next, places: [...current.result.places, ...next.places] } }
        : current))
      .catch((failure) => setError(messageFor(failure)))
      .finally(() => { if (visitedPageInFlight.current === pageKey) visitedPageInFlight.current = null; });
  }, [gateway, visited, options.visitedIds, visitedQueryKey]);

  const searchPlaces = useCallback(async (query: string) => {
    if (!gateway || !query.trim()) return [];
    const result = await gateway.fetchSearch({ query, limit: 30, visitedPlaceIds: options.visitedIds });
    return result.places;
  }, [gateway, options.visitedIds]);

  return { map, mapSearch, collection, visited, offline, error, gateway, retry, loadMoreCollection, loadMoreVisited, searchPlaces };
}
