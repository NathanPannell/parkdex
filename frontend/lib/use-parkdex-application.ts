"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type UIEvent } from "react";
import type { BoundaryLoadState } from "@/lib/boundaries";
import type { ClaimConfirmation, ClaimRecommendation } from "@/lib/claims-client";
import { type Achievement } from "@/lib/achievements";
import { groupByRegion, type VisitFilter } from "@/lib/collection";
import { addNativeBackConsumer } from "@/lib/native-back";
import type { Place, PlaceCategory } from "@/lib/places";
import { resolveApiBaseUrl } from "@/lib/api-base-url";
import { useFieldJournal } from "@/lib/use-field-journal";
import { useLiveClaimRecommendation, useLiveLocation } from "@/lib/use-live-location";
import { useGroups } from "@/lib/use-groups";
import { readGroupNavigation, rememberGroupNavigation } from "@/lib/group-navigation";
import { usePublicNavigation } from "@/lib/use-public-navigation";
import { readNavigation, type View } from "@/lib/navigation";
import { notifyError, notifyInfo } from "@/lib/application-notifications";
import { useMapPresentation, type MapViewport } from "@/lib/use-map-presentation";
import { useRecentPlace } from "@/lib/use-recent-place";
import { usePlaceData } from "@/lib/use-place-data";
import { stablePlacePriorityKey, type PlaceDataItem } from "@/lib/place-data-gateway";

const ONBOARDING_KEY = "parkdex:onboarding:v1";
const EMPTY_CATEGORIES = new Set<PlaceCategory>();
const EMPTY_AUTHORITIES = new Set<string>();
type LocationIdentity = "guest" | `account:${string}`;

function persistentSyncStatus(message: string) {
  return /syncing your latest checkoffs|waiting to sync|saved on this device and waiting|private device storage could not save|requires location confirmation|progress has been reset|added \d+ guest places?\./i.test(message)
    ? message
    : "";
}
export function useParkdexApplication({ apiBaseUrl: configuredApiBaseUrl, googleAuthAllowed = true, geolocationAllowed = true, automaticLocationAllowed = false }: { apiBaseUrl: string; googleAuthAllowed?: boolean; geolocationAllowed?: boolean; automaticLocationAllowed?: boolean }) {
  const apiBaseUrl = resolveApiBaseUrl(configuredApiBaseUrl, typeof window === "undefined" ? undefined : window.location.origin);
  const journal = useFieldJournal({ apiBaseUrl });
  const [resetCleanupPending, setResetCleanupPending] = useState(false);
  const [resetCleanupBusy, setResetCleanupBusy] = useState(false);
  const [resetCommandBusy, setResetCommandBusy] = useState(false);
  const [claimRetryBusy, setClaimRetryBusy] = useState(false);
  const [rejectedClaimsBusy, setRejectedClaimsBusy] = useState(false);
  const reportedErrorsRef = useRef(new Map<string, string>());
  const reportedErrorIdentityRef = useRef("guest");
  const { places, visited, visitTimestamps, visitMetadata, account, authenticated, loading, loadError, syncMessage, storageUnavailable, guestProgressAvailable, transitionBusy, visitClaimMode, toggleVisit, retrySync, authenticate: completeAuth, authenticateWithGoogle, requestEmailVerification, confirmEmailVerification, logout: signOut, importGuest, deleteAccount: onDeleteAccount, recommendClaim, createClaim, reconcileClaim, uploadVisitPhoto, loadVisitPhoto, removeVisitPhoto, authenticatedRequest } = journal;
  const { state: navigation, update: updateNavigation, set: setNavigation } = usePublicNavigation();
  const { selectedId, detailExpanded, mapSearch, mapCategories, collectionSearch, collectionCategories, collectionAuthorities, collectionVisitFilter, view } = navigation;
  const setMapSearch = (value: SetStateAction<string>) => setNavigation("mapSearch", value);
  const setMapCategories = (value: SetStateAction<Set<PlaceCategory>>) => setNavigation("mapCategories", value);
  const setCollectionSearch = (value: SetStateAction<string>) => setNavigation("collectionSearch", value);
  const setCollectionCategories = (value: SetStateAction<Set<PlaceCategory>>) => setNavigation("collectionCategories", value);
  const setCollectionVisitFilter = (value: SetStateAction<VisitFilter>) => setNavigation("collectionVisitFilter", value);
  const [mapSearchDraft, setMapSearchDraft] = useState("");
  const [navigationNotice, setNavigationNotice] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const onboardingChecked = useRef(false);
  useEffect(() => {
    if (loading || onboardingChecked.current) return;
    onboardingChecked.current = true;
    if (authenticated || visited.size || window.location.search || window.location.hash ||
      !["/", "/map"].includes(window.location.pathname)) return;
    try { if (window.localStorage.getItem(ONBOARDING_KEY)) return; } catch { /* An intro never requires storage access. */ }
    queueMicrotask(() => setShowOnboarding(true));
  }, [authenticated, loading, visited.size]);
  function completeOnboarding() {
    setShowOnboarding(false);
    try { window.localStorage.setItem(ONBOARDING_KEY, "complete"); } catch { /* The app remains usable in private mode. */ }
  }
  const [recoveryActive, setRecoveryActive] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.hash.slice(1)).has("resetToken"));
  const locationIdentity: LocationIdentity | null = loading ? null : authenticated && account?.id ? `account:${account.id}` : "guest";
  const locationGenerationKey = authenticated && account?.id ? `account:${account.id}` : authenticated ? "account:current" : "guest";
  const [manualLocationScope, setManualLocationScope] = useState<"pending" | LocationIdentity | null>(null);
  const [locationAttempt, setLocationAttempt] = useState(0);
  const manualLocationEnabled = manualLocationScope === "pending" || (locationIdentity !== null && manualLocationScope === locationIdentity);
  const locationEnabled = geolocationAllowed && !recoveryActive && ((automaticLocationAllowed && authenticated) || manualLocationEnabled);
  const { location, status: liveLocationStatus, claimLocationFresh, preciseLocationRequired, requestPreciseLocation } = useLiveLocation(locationEnabled, locationAttempt, locationGenerationKey);
  const locationStatus = liveLocationStatus === "starting" ? "locating" : liveLocationStatus;
  const [preciseLocationBusy, setPreciseLocationBusy] = useState(false);
  const [preciseLocationMessage, setPreciseLocationMessage] = useState("");
  const [showFilters, setShowFilters] = useState(false), [searchExpanded, setSearchExpanded] = useState(false), [celebrationBadges, setCelebrationBadges] = useState<Achievement[]>([]);
  const [viewRevision, setViewRevision] = useState(0), [resetViewRequest, setResetViewRequest] = useState(0);
  const groupsState = useGroups({ apiBaseUrl, authenticated: authenticated && !recoveryActive, identityKey: account?.id ?? "", places, request: authenticatedRequest });
  const selectedGroup = authenticated && !recoveryActive ? groupsState.groups.find((group) => group.id === groupsState.selectedGroupId) ?? null : null;
  const groupNavigationAccountId = account?.id ?? null;
  const groupSelectedIds = useMemo(() => new Set(selectedGroup?.places.map((place) => place.id) ?? []), [selectedGroup]);
  const [boundaryLoadState, setBoundaryLoadState] = useState<BoundaryLoadState>({ status: "loading", placeIds: new Set() });
  const [mapViewport, setMapViewport] = useState<MapViewport | null>(null);
  const groupMapMode = view === "map" && Boolean(selectedGroup);
  const placeData = usePlaceData({
    apiBaseUrl, ownerKey: journal.catalogueOwnerKey, headers: journal.catalogueHeaders,
    viewport: mapViewport, selectedId, groupId: groupMapMode ? selectedGroup?.id : null,
    groupPlaceIds: groupMapMode ? groupSelectedIds : undefined,
    mapQuery: groupMapMode ? "" : mapSearch,
    mapCategories: groupMapMode ? EMPTY_CATEGORIES : mapCategories,
    mapAuthorities: groupMapMode ? EMPTY_AUTHORITIES : collectionAuthorities,
    collectionQuery: collectionSearch, collectionCategories, collectionAuthorities,
    visitFilter: collectionVisitFilter, visitedIds: visited,
    searchDraft: mapSearchDraft, searchExpanded, view,
  });
  const mapFiltered = placeData.map.places;
  const mapSearchMatches = placeData.mapSearch.places;
  const collectionFiltered = placeData.collection.places;
  const groups = useMemo(() => groupByRegion(collectionFiltered), [collectionFiltered]);
  const badgeList = journal.badges;
  const earnedBadges = badgeList.filter((badge) => badge.earned).length;
  const previousBadgesRef = useRef<{ ownerKey: string; earned: Set<string> } | null>(null);
  useEffect(() => {
    if (loading || !journal.catalogueOwnerKey || badgeList.length === 0) return;
    const earned = new Set(badgeList.filter((badge) => badge.earned).map((badge) => badge.id));
    const previous = previousBadgesRef.current;
    if (previous?.ownerKey === journal.catalogueOwnerKey) {
      const newlyEarned = badgeList.filter((badge) => badge.earned && !previous.earned.has(badge.id));
      if (newlyEarned.length) setCelebrationBadges((current) => [...current, ...newlyEarned]);
    }
    previousBadgesRef.current = { ownerKey: journal.catalogueOwnerKey, earned };
  }, [badgeList, journal.catalogueOwnerKey, loading]);
  const catalogueSelected = mapFiltered.find((place) => place.id === selectedId)
    ?? collectionFiltered.find((place) => place.id === selectedId)
    ?? placeData.visited.places.find((place) => place.id === selectedId)
    ?? places.find((place) => place.id === selectedId) ?? null;
  const selectedRecentPlace = useRecentPlace({ selectedId, apiBaseUrl });
  const selected = selectedRecentPlace.selectedId === selectedId && selectedRecentPlace.status === "ready" && selectedRecentPlace.place
    ? selectedRecentPlace.place
    : catalogueSelected;
  const claimFunctionsAvailable = [recommendClaim, createClaim, reconcileClaim, uploadVisitPhoto, loadVisitPhoto, removeVisitPhoto].every((value) => typeof value === "function");
  const claimsAvailable = authenticated && claimFunctionsAvailable;
  const liveClaim = useLiveClaimRecommendation({
    enabled: claimsAvailable && !recoveryActive,
    sessionKey: account?.id ?? "guest",
    location: claimLocationFresh ? location : null,
    recommend: recommendClaim,
  });
  const clearLiveClaim = liveClaim.clear;
  const [claimFlow, setClaimFlow] = useState<{ placeId: string; recommendation: Extract<ClaimRecommendation, { status: "recommended" }> } | null>(null);
  const [claimFlowResetSignal, setClaimFlowResetSignal] = useState(0);
  const [dismissedArrival, setDismissedArrival] = useState<string | null>(null);
  const [recentImpression, setRecentImpression] = useState<{ owner: string; confirmation: ClaimConfirmation } | null>(null);
  const legacyVisitCreationAvailable = authenticated && (
    visitClaimMode === "legacy" || (visitClaimMode === undefined && !claimFunctionsAvailable)
  );
  const visits = visitMetadata ?? {};
  const photoOwnerKey = account?.id ? `account:${account.id}` : "account:current";
  const mapPlaces = mapFiltered;
  const liveRecommendation = liveClaim.recommendation?.status === "recommended" ? liveClaim.recommendation : null;
  const displayedRecommendation = claimFlow?.recommendation ?? (liveRecommendation?.candidate.placeId === dismissedArrival ? null : liveRecommendation);
  const liveClaimPlaceId = displayedRecommendation?.candidate.placeId ?? null;
  const arrivalRecentPlace = useRecentPlace({
    selectedId: (view === "map" || claimFlow) && liveClaimPlaceId && liveClaimPlaceId !== selectedId ? liveClaimPlaceId : null,
    apiBaseUrl,
  });
  const liveClaimPlace = liveClaimPlaceId
    ? (selectedRecentPlace.selectedId === liveClaimPlaceId ? selectedRecentPlace.place : arrivalRecentPlace.place)
      ?? mapFiltered.find((place) => place.id === liveClaimPlaceId)
      ?? places.find((place) => place.id === liveClaimPlaceId)
      ?? null
    : null;
  const arrivalSelection = liveClaimPlace?.id === selectedRecentPlace.selectedId
    ? selectedRecentPlace
    : arrivalRecentPlace;
  const arrivalPhotoUrl = arrivalSelection.photoUrl;
  const arrivalImage = arrivalSelection.status === "ready" ? arrivalSelection.bundle?.image : undefined;
  const approximateClaimLocation = Boolean(
    claimsAvailable
    && (preciseLocationRequired || (location && claimLocationFresh && location.accuracyMeters > 50))
    && !displayedRecommendation
  );

  const reportErrorState = useCallback((source: string, event: string) => {
    const accountId = account?.id ?? "";
    const identity = accountId ? `account:${accountId}` : "guest";
    if (reportedErrorIdentityRef.current !== identity) {
      reportedErrorsRef.current.clear();
      reportedErrorIdentityRef.current = identity;
    }
    if (!event) {
      reportedErrorsRef.current.delete(source);
      return;
    }
    if (reportedErrorsRef.current.get(source) === event) return;
    reportedErrorsRef.current.set(source, event);
    if ([...reportedErrorsRef.current.entries()].some(([otherSource, activeEvent]) => otherSource !== source && activeEvent === event)) return;
    notifyError(event);
  }, [account]);

  useEffect(() => {
    reportErrorState("catalogue", loadError);
  }, [loadError, reportErrorState]);

  useEffect(() => {
    reportErrorState("place-data", placeData.error);
  }, [placeData.error, reportErrorState]);

  useEffect(() => {
    reportErrorState("collections", groupsState.error);
  }, [groupsState.error, reportErrorState]);

  useEffect(() => {
    reportErrorState("recent-place-photo", selectedRecentPlace.warning ?? "");
  }, [reportErrorState, selectedRecentPlace.warning]);

  useEffect(() => {
    reportErrorState("recent-place", selectedRecentPlace.error ?? "");
  }, [reportErrorState, selectedRecentPlace.error]);

  useEffect(() => {
    reportErrorState("arrival-place-photo", arrivalRecentPlace.warning ?? "");
  }, [arrivalRecentPlace.warning, reportErrorState]);

  useEffect(() => {
    reportErrorState("offline-claim-recovery", journal.offlineClaimRecoveryMessage);
  }, [journal.offlineClaimRecoveryMessage, reportErrorState]);

  useEffect(() => {
    if (!syncMessage
      || /reset successfully|progress has been reset|added \d+ guest places?|account was deleted\.?$/i.test(syncMessage)
      || /waiting to sync|saved on this device|syncing your latest checkoffs|added guest progress|saved and waiting for private storage/i.test(syncMessage)) {
      reportErrorState("sync", "");
      return;
    }
    reportErrorState("sync", syncMessage);
  }, [reportErrorState, syncMessage]);

  useEffect(() => {
    if (!locationIdentity) return;
    queueMicrotask(() => setManualLocationScope((current) => {
      if (current === "pending") return locationIdentity;
      return current && current !== locationIdentity ? null : current;
    }));
  }, [locationIdentity]);

  useEffect(() => {
    queueMicrotask(() => { setClaimFlow(null); setDismissedArrival(null); setRecentImpression(null); });
  }, [account?.id, authenticated]);

  useEffect(() => {
    // Expiry, poor GPS, and going offline are not new arrivals. Only a confirmed
    // departure or a different eligible park makes a dismissed invitation recur.
    if (liveClaim.recommendation?.status === "none" || (liveRecommendation && liveRecommendation.candidate.placeId !== dismissedArrival)) {
      queueMicrotask(() => setDismissedArrival(null));
    }
  }, [dismissedArrival, liveClaim.recommendation, liveRecommendation]);

  useEffect(() => {
    if (!liveRecommendation || claimFlow?.placeId === liveRecommendation.candidate.placeId) return;
    if (visited.has(liveRecommendation.candidate.placeId)) clearLiveClaim();
  }, [claimFlow?.placeId, clearLiveClaim, liveRecommendation, visited]);

  useEffect(() => {
    if (!showFilters && !searchExpanded) return;
    return addNativeBackConsumer(() => {
      if (showFilters) setShowFilters(false);
      else setSearchExpanded(false);
    });
  }, [searchExpanded, showFilters]);
  const selectGroup = groupsState.selectGroup;
  useEffect(() => {
    function restoreHistory() {
      setShowFilters(false); setSearchExpanded(false); setNavigationNotice("");
      const targetView = readNavigation(window.location.href).view;
      const saved = readGroupNavigation(groupNavigationAccountId);
      const restoredGroupId = authenticated && !recoveryActive && (targetView === "groups" || targetView === "map") ? saved.groupId : null;
      selectGroup(restoredGroupId);
      if (restoredGroupId) requestAnimationFrame(() => document.querySelector<HTMLElement>(".feature-panel")?.scrollTo({ top: saved.scrollTop }));
    }
    window.addEventListener("popstate", restoreHistory);
    return () => window.removeEventListener("popstate", restoreHistory);
  }, [authenticated, recoveryActive, selectGroup, groupNavigationAccountId]);
  useEffect(() => {
    if (!authenticated || recoveryActive) rememberGroupNavigation(null, 0, groupNavigationAccountId);
  }, [authenticated, recoveryActive, groupNavigationAccountId]);
  // Detail routes may refer to places outside the current viewport sample.
  function requestLocation() {
    setManualLocationScope(locationIdentity ?? "pending"); setLocationAttempt((current) => current + 1);
  }
  async function enablePreciseLocation() {
    if (preciseLocationBusy) return;
    setPreciseLocationBusy(true);
    setPreciseLocationMessage("");
    try {
      const precise = await requestPreciseLocation();
      if (precise.accuracyMeters > 50) {
        setPreciseLocationMessage(`Precise access is on, but this fix is still ±${Math.round(precise.accuracyMeters)} m. Move into open sky and try again.`);
      }
    } catch (error) {
      setPreciseLocationMessage(error instanceof Error ? error.message : "Precise location is still unavailable. Check Parkdex location access in Android settings, then try again.");
    } finally {
      setPreciseLocationBusy(false);
    }
  }
  function resetMapFilters() { updateNavigation({ mapSearch: "", mapCategories: new Set(), collectionAuthorities: new Set(), collectionVisitFilter: "all" }); setMapSearchDraft(""); }
  function resetCollectionFilters() { updateNavigation({ collectionSearch: "", collectionCategories: new Set(), collectionAuthorities: new Set(), collectionVisitFilter: "all" }); }
  function clearCollectionActiveFilters() { updateNavigation({ collectionCategories: new Set(), collectionAuthorities: new Set(), collectionVisitFilter: "all" }); }
  function toggleSet<T>(setter: Dispatch<SetStateAction<Set<T>>>, value: T) { setter((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }); }
  const rememberDepartingGroup = useCallback(() => {
    if (view !== "groups" || !selectedGroup) return;
    const panel = document.querySelector<HTMLElement>(".feature-panel");
    rememberGroupNavigation(selectedGroup.id, panel?.scrollTop ?? 0, groupNavigationAccountId);
  }, [groupNavigationAccountId, selectedGroup, view]);
  const rememberGroupPanelScroll = useCallback((event: UIEvent<HTMLElement>) => {
    if (!authenticated || recoveryActive || view !== "groups" || !selectedGroup || !groupNavigationAccountId) return;
    rememberGroupNavigation(selectedGroup.id, event.currentTarget.scrollTop, groupNavigationAccountId);
  }, [authenticated, groupNavigationAccountId, recoveryActive, selectedGroup, view]);
  const choosePlace = useCallback((id: string) => {
    const inView = mapFiltered.find((place) => place.id === id)
      ?? collectionFiltered.find((place) => place.id === id)
      ?? placeData.visited.places.find((place) => place.id === id);
    if (inView) void placeData.gateway?.remember(inView, "interaction").catch(() => undefined);
    rememberDepartingGroup();
    const origin = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    updateNavigation({ selectedId: id, detailExpanded: view !== "map", view: view === "collection" ? "collection" : "map" }, "push");
    window.history.replaceState({ ...window.history.state, parkdexDetailOrigin: origin, parkdexDetailId: id }, "");
    rememberGroupNavigation(null, 0, groupNavigationAccountId);
    setNavigationNotice(""); setShowFilters(false); setSearchExpanded(false);
  }, [view, rememberDepartingGroup, updateNavigation, groupNavigationAccountId, mapFiltered, collectionFiltered, placeData.visited.places, placeData.gateway]);
  function openGroupMember(id: string) { groupsState.selectGroup(null); choosePlace(id); }
  function navigate(next: View) {
    const resetting = view === next;
    setShowFilters(false); setNavigationNotice("");
    rememberDepartingGroup();
    if (next !== "groups") groupsState.selectGroup(null);
    if (next === "map" && resetting) { resetMapFilters(); setSearchExpanded(false); setResetViewRequest((current) => current + 1); }
    if (next === "collection" && resetting) resetCollectionFilters();
    if (next === "groups" && resetting) groupsState.selectGroup(null);
    if (resetting) { setViewRevision((current) => current + 1); requestAnimationFrame(() => document.querySelectorAll<HTMLElement>(".feature-panel, .collection-scroll").forEach((element) => element.scrollTo({ top: 0 }))); }
    updateNavigation({ view: next, selectedId: null, settingsOpen: false }, "push");
    if (!(next === "groups" && view === "map" && selectedGroup)) rememberGroupNavigation(null, 0, groupNavigationAccountId);
  }
  function changeSettingsRoute(open: boolean) {
    if (!open && window.history.state?.parkdexRouteDepth > 0) {
      window.history.back();
      return;
    }
    updateNavigation({ view: "account", settingsOpen: open, selectedId: null }, open ? "push" : "replace");
  }
  function applyMapSearch() { setMapSearch(mapSearchDraft); setShowFilters(false); setSearchExpanded(false); }
  function openMapSearch() {
    if (!searchExpanded) { setMapSearchDraft(mapSearch); setSearchExpanded(true); }
    if (selectedId) updateNavigation({ selectedId: null, detailExpanded: false }, "replace");
    setShowFilters(false);
  }
  function switchGuide(next: "map" | "collection") {
    setShowFilters(false); setSearchExpanded(false);
    updateNavigation(next === "collection"
      ? { view: next, selectedId: null, collectionSearch: mapSearch, collectionCategories: new Set(mapCategories) }
      : { view: next, selectedId: null, mapSearch: collectionSearch, mapCategories: new Set(collectionCategories) }, "push");
  }
  function closePlace() {
    setSearchExpanded(false);
    if (window.history.state?.parkdexDetailId === selectedId && window.history.state?.parkdexDetailOrigin) window.history.back();
    else updateNavigation({ selectedId: null, detailExpanded: false }, "replace");
  }
  function openCollection(category?: PlaceCategory, authority?: string) {
    rememberDepartingGroup();
    updateNavigation({ view: "collection", selectedId: null, collectionSearch: "", collectionVisitFilter: "all", collectionCategories: category ? new Set([category]) : new Set(), collectionAuthorities: authority ? new Set([authority]) : new Set() }, "push");
    rememberGroupNavigation(null, 0, groupNavigationAccountId); groupsState.selectGroup(null); setShowFilters(false);
  }
  function viewSelectedGroupOnMap() {
    if (selectedGroup) {
      const panel = document.querySelector<HTMLElement>(".feature-panel");
      rememberGroupNavigation(selectedGroup.id, panel?.scrollTop ?? 0, groupNavigationAccountId);
    }
    updateNavigation({ view: "map", selectedId: null, collectionVisitFilter: "all" }, "push");
  }
  async function logoutAndClearGroupHistory() {
    rememberGroupNavigation(null, 0, groupNavigationAccountId);
    groupsState.selectGroup(null);
    await signOut();
  }

  async function resetProgressAndRefresh() {
    if (resetCommandBusy) return;
    setResetCommandBusy(true);
    let prepared = false;
    try {
      try {
        await groupsState.prepareForReset();
        prepared = true;
      } catch (error) {
        try {
          await groupsState.cancelResetPreparation();
        } catch (recoveryError) {
          notifyError(recoveryError, "The reset did not start. Saved collections remain paused until they can be refreshed.");
        }
        notifyError(error);
        throw error;
      }
      try {
        await journal.resetProgress();
      } catch (error) {
        try {
          if (prepared) await groupsState.cancelResetPreparation();
        } catch (cleanupError) {
          notifyError(cleanupError, "The progress reset did not complete. Saved collections remain paused until they can be refreshed.");
        }
        notifyError(error);
        throw error;
      }

      setCelebrationBadges([]);
      setClaimFlow(null);
      setRecentImpression(null);
      setDismissedArrival(null);
      clearLiveClaim();
      setClaimFlowResetSignal((current) => current + 1);
      rememberGroupNavigation(null, 0, groupNavigationAccountId);
      groupsState.selectGroup(null);
      setResetCleanupPending(false);
      try {
        await groupsState.refreshAfterReset();
      } catch (error) {
        setResetCleanupPending(true);
        notifyError(error, "Progress reset. Some saved collection data still needs cleanup.");
      }
    } finally {
      setResetCommandBusy(false);
    }
  }

  async function retryResetCleanup() {
    if (resetCleanupBusy) return;
    setResetCleanupBusy(true);
    try {
      await groupsState.refreshAfterReset();
      setResetCleanupPending(false);
      notifyInfo("Saved collections are ready.");
    } catch (error) {
      notifyError(error, "Some saved collection data still needs cleanup.");
    } finally {
      setResetCleanupBusy(false);
    }
  }
  async function retryPendingClaims() {
    if (claimRetryBusy) return;
    setClaimRetryBusy(true);
    try {
      await journal.retryPendingClaims();
      notifyInfo("Saved visits are synced.");
    } catch (error) {
      notifyError(error, "Could not sync saved visits. Your retry stays on this device.");
    } finally {
      setClaimRetryBusy(false);
    }
  }
  async function discardRejectedClaims() {
    const count = journal.rejectedClaimCount;
    if (!count || rejectedClaimsBusy) return;
    const accepted = typeof window !== "undefined" && window.confirm(
      `Dismiss ${count} rejected saved ${count === 1 ? "visit" : "visits"}? This removes only rejected attempts. Confirmed visits, visits waiting to sync, and saved photo drafts will stay on this device.`,
    );
    if (!accepted) return;
    setRejectedClaimsBusy(true);
    try {
      const removed = await journal.discardRejectedClaims();
      notifyInfo(`${removed} rejected ${removed === 1 ? "visit was" : "visits were"} dismissed.`);
    } catch (error) {
      notifyError(error, "Rejected visits could not be dismissed. Their saved recovery data stays on this device.");
    } finally {
      setRejectedClaimsBusy(false);
    }
  }
  function toggleSelected(place: Place) {
    if (transitionBusy || loading) return;
    const sampled = mapFiltered.find((item) => item.id === place.id)
      ?? collectionFiltered.find((item) => item.id === place.id)
      ?? placeData.visited.places.find((item) => item.id === place.id);
    const cacheRecord: PlaceDataItem = sampled
      ? { ...sampled, visited: !visited.has(place.id) }
      : { ...place, visited: !visited.has(place.id), priorityTier: place.category === "national" ? 0 : 2,
        priorityKey: stablePlacePriorityKey(place.id) };
    void placeData.gateway?.remember(cacheRecord, "visited").catch(() => undefined);
    void toggleVisit(place);
  }
  function celebrateClaim(confirmation: ClaimConfirmation) {
    if (!confirmation.pendingSync) placeData.retry();
  }

  function rememberImpression(confirmation: ClaimConfirmation) {
    if (confirmation.pendingSync) {
      notifyInfo("Visit saved on this device and waiting to sync.");
      return;
    }
    setRecentImpression({ owner: photoOwnerKey, confirmation });
    setCelebrationBadges([]);
  }
  function dismissArrival() {
    if (liveClaimPlace) setDismissedArrival(liveClaimPlace.id);
    setClaimFlow(null);
    clearLiveClaim();
  }
  const impressionPlace = recentImpression?.owner === photoOwnerKey && authenticated
    ? selectedRecentPlace.place?.id === recentImpression.confirmation.placeId ? selectedRecentPlace.place
      : arrivalRecentPlace.place?.id === recentImpression.confirmation.placeId ? arrivalRecentPlace.place
        : mapFiltered.find((place) => place.id === recentImpression.confirmation.placeId)
          ?? placeData.visited.places.find((place) => place.id === recentImpression.confirmation.placeId)
          ?? places.find((place) => place.id === recentImpression.confirmation.placeId)
    : undefined;
  const recentPostcard = impressionPlace && recentImpression ? {
    place: impressionPlace,
    visit: visits[impressionPlace.id] ?? { placeId: impressionPlace.id, visitedAt: recentImpression.confirmation.visitedAt, claim: recentImpression.confirmation.claim },
  } : undefined;
  const mapPresentation = useMapPresentation({
    apiBaseUrl,
    active: view === "map",
    places: mapPlaces,
    visited,
    mode: "explored",
    selectedId,
    selectedBoundary: selectedRecentPlace.bundle?.boundary ?? null,
    selectedIds: groupSelectedIds,
    viewport: mapViewport,
    recentPostcard,
    loadPhoto: loadVisitPhoto,
    photoOwnerKey,
  });

  return {
    model: {
      apiBaseUrl,
      googleAuthAllowed,
      geolocationAllowed,
      journal,
      navigation,
      selectedId,
      detailExpanded,
      mapSearch,
      mapCategories,
      collectionSearch,
      collectionCategories,
      collectionAuthorities,
      collectionVisitFilter,
      view,
      mapSearchDraft,
      navigationNotice,
      showOnboarding,
      recoveryActive,
      location,
      locationStatus,
      preciseLocationRequired,
      preciseLocationBusy,
      preciseLocationMessage,
      showFilters,
      searchExpanded,
      celebrationBadges,
      viewRevision,
      resetViewRequest,
      groupsState,
      selectedGroup,
      groupSelectedIds,
      boundaryLoadState,
      groupMapMode,
      mapFiltered,
      mapTotal: placeData.map.total,
      mapScope: placeData.map.scope,
      mapSearchMatches,
      mapSearchTotal: placeData.mapSearch.total,
      collectionFiltered,
      collectionTotal: placeData.collection.total,
      collectionScope: placeData.collection.scope,
      collectionHasMore: placeData.collection.places.length < placeData.collection.total,
      visitedPlaces: placeData.visited.places,
      visitedTotal: placeData.visited.total,
      visitedScope: placeData.visited.scope,
      visitedHasMore: placeData.visited.places.length < placeData.visited.total,
      catalogueTotal: journal.total,
      categoryTotals: journal.categoryTotals,
      visitedCategoryTotals: journal.visitedCategoryTotals,
      offlineMode: placeData.offline,
      groups,
      badgeList,
      earnedBadges,
      selected,
      selectedPlacePhotoUrl: selectedRecentPlace.photoUrl,
      selectedPlacePhotoUrls: selectedRecentPlace.photoUrls,
      selectedPlaceImages: selectedRecentPlace.status === "ready" ? selectedRecentPlace.images : undefined,
      recentPlaceStatus: selectedRecentPlace.status,
      claimsAvailable,
      legacyVisitCreationAvailable,
      claimFlow,
      claimFlowResetSignal,
      dismissedArrival,
      liveRecommendation,
      displayedRecommendation,
      liveClaimPlace,
      arrivalPhotoUrl,
      arrivalImage,
      approximateClaimLocation,
      visits,
      photoOwnerKey,
      resetCleanupPending: resetCleanupPending || groupsState.resetCleanupRequired,
      resetCleanupBusy: resetCleanupBusy || resetCommandBusy,
      resetPreparationPending: groupsState.resetPreparationPending,
      resetCancellationAllowed: groupsState.resetCancellationAllowed,
      mapPlaces,
      mapPresentation,
      mapViewport,
      recentPostcard,
      places,
      visited,
      visitTimestamps,
      visitMetadata,
      account,
      authenticated,
      loading,
      loadError,
      syncMessage,
      persistentSyncMessage: persistentSyncStatus(syncMessage),
      groupsErrorStatus: groupsState.error ? "Could not sync collections. Please retry." : "",
      storageUnavailable,
      guestProgressAvailable,
      transitionBusy,
      visitClaimMode,
      pendingClaims: journal.pendingClaims,
      offlineClaimRecoveryCount: journal.offlineClaimRecoveryCount,
      offlineClaimRecoveryMessage: journal.offlineClaimRecoveryMessage,
      claimRetryBusy,
      rejectedClaimCount: journal.rejectedClaimCount,
      rejectedClaimsBusy,
      progressRevision: journal.progressRevision,
    },
    actions: {
      updateNavigation,
      setMapSearch,
      setMapCategories,
      setCollectionSearch,
      setCollectionCategories,
      setCollectionVisitFilter,
      setMapSearchDraft,
      setNavigationNotice,
      setShowOnboarding,
      setRecoveryActive,
      setPreciseLocationMessage,
      setShowFilters,
      setSearchExpanded,
      setCelebrationBadges,
      setClaimFlow,
      setRecentImpression,
      setBoundaryLoadState,
      setMapViewport,
      offlineRetry: () => {
        placeData.retry();
        void journal.retryCatalogue?.();
      },
      searchPlaces: placeData.searchPlaces,
      onCollectionLoadMore: placeData.loadMoreCollection,
      onVisitedLoadMore: placeData.loadMoreVisited,
      completeOnboarding,
      requestLocation,
      enablePreciseLocation,
      resetMapFilters,
      resetCollectionFilters,
      clearCollectionActiveFilters,
      toggleSet,
      rememberGroupPanelScroll,
      choosePlace,
      openGroupMember,
      navigate,
      changeSettingsRoute,
      applyMapSearch,
      openMapSearch,
      switchGuide,
      closePlace,
      openCollection,
      viewSelectedGroupOnMap,
      logoutAndClearGroupHistory,
      resetProgress: resetProgressAndRefresh,
      retryResetCleanup,
      cancelResetPreparation: groupsState.cancelResetPreparation,
      toggleSelected,
      celebrateClaim,
      rememberImpression,
      dismissArrival,
      clearLiveClaim,
      retrySync,
      retryPendingClaims,
      discardRejectedClaims,
      completeAuth,
      authenticateWithGoogle,
      requestEmailVerification,
      confirmEmailVerification,
      importGuest,
      onDeleteAccount,
      loadVisitPhoto,
      removeVisitPhoto,
      groupsState,
    },
  };
}

