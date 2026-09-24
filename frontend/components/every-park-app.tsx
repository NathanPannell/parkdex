"use client";

import { ArrowLeft, ArrowUpRight, Award, Check, ChevronDown, ChevronRight, Circle, Compass, Heart, BookOpen, Layers, List, Settings, LandPlot, ListFilter, ListPlus, LocateFixed, LogIn, LogOut, MailCheck, Map as MapIcon, MapPin, Pencil, Plus, RotateCcw, Search, Trees, Trash2, UserRound, X } from "lucide-react";
import Image from "next/image";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ParkMap } from "@/components/park-map";
import { PlaceImage } from "@/components/place-image";
import { ClaimVisitPanel } from "@/components/claim-visit-panel";
import { ClaimFlowBanner } from "@/components/claim-flow-banner";
import { FieldDiagnosticRegion } from "@/components/field-diagnostic-region";
import { PostcardCollection } from "@/components/postcard-collection";
import { FieldGuideOnboarding } from "@/components/field-guide-onboarding";
import { AccountDeletionDialog, type AccountDeletionResult } from "@/components/account-deletion-dialog";
import { confirmPasswordReset, loadAuthConfig, requestGoogleAuthorization, requestPasswordReset, type Account, type AuthConfig } from "@/lib/account";
import { resolveApiBaseUrl } from "@/lib/api-base-url";
import { achievements, newlyEarnedAchievementIds, type Achievement } from "@/lib/achievements";
import badgeImages from "@/lib/badge-images.json";
import type { BoundaryLoadState } from "@/lib/boundaries";
import type { ClaimConfirmation, ClaimRecommendation } from "@/lib/claims-client";
import { authorityForPlace, collectionFilter, groupByRegion, type VisitFilter } from "@/lib/collection";
import { clearPhotoRetryOwner, type LocationSample } from "@/lib/native-capabilities";
import { addNativeBackConsumer } from "@/lib/native-back";
import { getPlaceImage } from "@/lib/place-images";
import { categoryLabels, matchesPlaceSearch, type Place, type PlaceCategory } from "@/lib/places";
import { RELEASE_METADATA } from "@/lib/release";
import { useFieldJournal } from "@/lib/use-field-journal";
import { useLiveClaimRecommendation, useLiveLocation } from "@/lib/use-live-location";
import type { Visit } from "@/lib/account";
import { useGroups } from "@/lib/use-groups";
import { readGroupNavigation, rememberGroupNavigation } from "@/lib/group-navigation";

import { usePublicNavigation, notifyNavigationChange } from "@/lib/use-public-navigation";
import { navigationUrl, readNavigation, type View } from "@/lib/navigation";
import { getVisitorInformation } from "@/lib/visitor-information";
import { getPlaceDescriptionSource } from "@/lib/place-description-sources";
import { formatPlaceArea, shortOriginForPlace } from "@/lib/place-detail-facts";

const categories = Object.keys(categoryLabels) as PlaceCategory[];
type BadgeImage = { src: string; alt: string; creator: string; license: string; licenseUrl: string; sourceUrl: string; species: string };
type ShelfItem = { id: string; name: string; kind: "badge" | "place"; image?: string; date?: string };
type LocationIdentity = "guest" | `account:${string}`;
const imageMap = badgeImages as Record<string, BadgeImage>;
const GOOGLE_VERIFIER_KEY = "parkdex:google-code-verifier:v1";
const ONBOARDING_KEY = "parkdex:onboarding:v1";
const PUBLIC_INFORMATION_ORIGIN = "https://parkdex.app";
const formatDate = (value?: string) => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.valueOf()) ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(date) : "Date unavailable"; };
const formatShelfDate = (value?: string) => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.valueOf()) ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" }).format(date) : "Date unavailable"; };
function useDialogFocus(onClose?: () => void, trapFocus = true) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const closable = onClose !== undefined;
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!closable) return;
    return addNativeBackConsumer(() => closeRef.current?.());
  }, [closable]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    const focusable = () => [...(node?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled])') ?? [])];
    if (trapFocus) focusable()[0]?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape" && closeRef.current) { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab" || !trapFocus) return;
      const items = focusable(); if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [trapFocus]);
  return ref;
}

export function ParkdexApp({ apiBaseUrl: configuredApiBaseUrl, googleAuthAllowed = true, geolocationAllowed = true, automaticLocationAllowed = false }: { apiBaseUrl: string; googleAuthAllowed?: boolean; geolocationAllowed?: boolean; automaticLocationAllowed?: boolean }) {
  const apiBaseUrl = resolveApiBaseUrl(configuredApiBaseUrl, typeof window === "undefined" ? undefined : window.location.origin);
  const journal = useFieldJournal({ apiBaseUrl });
  const { places, visited, visitTimestamps, visitMetadata, account, authenticated, loading, loadError, syncMessage, storageUnavailable, guestProgressAvailable, transitionBusy, visitClaimMode, toggleVisit, retrySync, authenticate: completeAuth, authenticateWithGoogle, requestEmailVerification, confirmEmailVerification, logout: signOut, importGuest, resetProgress, deleteAccount: onDeleteAccount, recommendClaim, createClaim, reconcileClaim, uploadVisitPhoto, loadVisitPhoto, removeVisitPhoto, authenticatedRequest } = journal;
  const { state: navigation, update: updateNavigation, set: setNavigation } = usePublicNavigation();
  const { selectedId, detailExpanded, mapSearch, mapCategories, collectionSearch, collectionCategories, collectionAuthorities, collectionVisitFilter, view } = navigation;
  const setMapSearch = (value: React.SetStateAction<string>) => setNavigation("mapSearch", value);
  const setMapCategories = (value: React.SetStateAction<Set<PlaceCategory>>) => setNavigation("mapCategories", value);
  const setCollectionSearch = (value: React.SetStateAction<string>) => setNavigation("collectionSearch", value);
  const setCollectionCategories = (value: React.SetStateAction<Set<PlaceCategory>>) => setNavigation("collectionCategories", value);
  const setCollectionVisitFilter = (value: React.SetStateAction<VisitFilter>) => setNavigation("collectionVisitFilter", value);
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
  const mapStageRef = useRef<HTMLElement>(null), connectionStatusRef = useRef<HTMLDivElement>(null);
  const [viewRevision, setViewRevision] = useState(0), [resetViewRequest, setResetViewRequest] = useState(0);
  const groupsState = useGroups({ apiBaseUrl, authenticated: authenticated && !recoveryActive, identityKey: account?.id ?? "", places, request: authenticatedRequest });
  const selectedGroup = authenticated && !recoveryActive ? groupsState.groups.find((group) => group.id === groupsState.selectedGroupId) ?? null : null;
  const groupNavigationAccountId = account?.id ?? null;
  const groupSelectedIds = useMemo(() => new Set(selectedGroup?.places.map((place) => place.id) ?? []), [selectedGroup]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [boundaryLoadState, setBoundaryLoadState] = useState<BoundaryLoadState>({ status: "loading", placeIds: new Set() });
  const groupMapMode = view === "map" && Boolean(selectedGroup);
  const mapFiltered = useMemo(() => collectionFilter(places, mapSearch, mapCategories, collectionAuthorities, collectionVisitFilter, visited), [places, mapSearch, mapCategories, collectionAuthorities, collectionVisitFilter, visited]);
  const mapSearchMatches = useMemo(() => collectionFilter(places, mapSearchDraft, mapCategories, collectionAuthorities, collectionVisitFilter, visited), [places, mapSearchDraft, mapCategories, collectionAuthorities, collectionVisitFilter, visited]);
  const collectionFiltered = useMemo(() => collectionFilter(places, collectionSearch, collectionCategories, collectionAuthorities, collectionVisitFilter, visited), [places, collectionSearch, collectionCategories, collectionAuthorities, collectionVisitFilter, visited]);
  const groups = useMemo(() => groupByRegion(collectionFiltered), [collectionFiltered]);
  const badgeList = useMemo(() => achievements({ places, visited, visitTimestamps }), [places, visited, visitTimestamps]);
  const earnedBadges = badgeList.filter((badge) => badge.earned).length, selected = places.find((place) => place.id === selectedId) ?? null;
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
  const previousPhotoOwnerRef = useRef(photoOwnerKey);
  const [photoOwnerCleanupAttempt, setPhotoOwnerCleanupAttempt] = useState(0);
  const [photoOwnerCleanupFailed, setPhotoOwnerCleanupFailed] = useState(false);
  const photoOwnerCleanupFailedRef = useRef(false);
  const mapPlaces = useMemo(() => {
    const candidates = selectedGroup ? collectionFilter(selectedGroup.places, "", new Set(), new Set(), collectionVisitFilter, visited) : view === "collection" ? collectionFiltered : mapFiltered;
    return selected && !candidates.some((place) => place.id === selected.id) ? [...candidates, selected] : candidates;
  }, [selectedGroup, collectionVisitFilter, visited, view, collectionFiltered, mapFiltered, selected]);
  const liveRecommendation = liveClaim.recommendation?.status === "recommended" ? liveClaim.recommendation : null;
  const displayedRecommendation = claimFlow?.recommendation ?? (liveRecommendation?.candidate.placeId === dismissedArrival ? null : liveRecommendation);
  const liveClaimPlace = displayedRecommendation ? places.find((place) => place.id === displayedRecommendation.candidate.placeId) ?? null : null;
  const approximateClaimLocation = Boolean(
    claimsAvailable
    && (preciseLocationRequired || (location && claimLocationFresh && location.accuracyMeters > 50))
    && !displayedRecommendation
  );

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
    if (syncMessage !== "Your progress has been reset.") return;
    // Reset Everything also invalidates the UI-side claim operation. This
    // prevents a late camera/upload completion from recreating the flow after
    // the account's durable retry and camera state have been cleared.
    queueMicrotask(() => {
      setClaimFlow(null);
      setRecentImpression(null);
      setDismissedArrival(null);
      clearLiveClaim();
      setClaimFlowResetSignal((current) => current + 1);
    });
  }, [clearLiveClaim, syncMessage]);

  useEffect(() => {
    if (previousPhotoOwnerRef.current === photoOwnerKey && !photoOwnerCleanupFailedRef.current) return;
    const previousOwner = previousPhotoOwnerRef.current;
    let active = true;
    void clearPhotoRetryOwner(previousOwner).then(() => {
      if (!active || previousPhotoOwnerRef.current !== previousOwner) return;
      previousPhotoOwnerRef.current = photoOwnerKey;
      photoOwnerCleanupFailedRef.current = false;
      setPhotoOwnerCleanupFailed(false);
    }).catch(() => {
      if (active) {
        photoOwnerCleanupFailedRef.current = true;
        setPhotoOwnerCleanupFailed(true);
      }
    });
    return () => { active = false; };
  }, [photoOwnerKey, photoOwnerCleanupAttempt]);
  useEffect(() => { if (searchExpanded) searchInputRef.current?.focus(); }, [searchExpanded]);
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
  useEffect(() => {
    if (loading || loadError || !selectedId || places.some((place) => place.id === selectedId)) return;
    queueMicrotask(() => { setNavigationNotice("This place is no longer in the catalogue. Find another place on the map."); updateNavigation({ selectedId: null, view: "map" }); });
  }, [loading, loadError, places, selectedId, updateNavigation]);
  useEffect(() => {
    const stage = mapStageRef.current, status = connectionStatusRef.current;
    if (!stage) return;
    if (!status) { stage.style.removeProperty("--connection-status-height"); return; }
    const updateHeight = () => stage.style.setProperty("--connection-status-height", `${status.getBoundingClientRect().height}px`);
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(status);
    return () => observer.disconnect();
  }, [loadError, syncMessage, storageUnavailable]);

  function focusNavigation() {
    const navigation = [...document.querySelectorAll<HTMLElement>(".desktop-top-nav, .thumb-nav")].find((node) => getComputedStyle(node).display !== "none");
    (navigation?.querySelector<HTMLElement>('button[aria-current="page"]') ?? navigation?.querySelector<HTMLElement>("button") ?? document.querySelector<HTMLElement>(".group-map-exit"))?.focus();
  }
  function focusContent() {
    const heading = document.querySelector<HTMLElement>(".place-sheet h2, .feature-panel h2");
    if (heading) { heading.tabIndex = -1; heading.focus(); }
    else (document.querySelector<HTMLElement>(".maplibregl-canvas") ?? document.getElementById("primary-content"))?.focus();
  }

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
  function toggleSet<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) { setter((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }); }
  const rememberDepartingGroup = useCallback(() => {
    if (view !== "groups" || !selectedGroup) return;
    const panel = document.querySelector<HTMLElement>(".feature-panel");
    rememberGroupNavigation(selectedGroup.id, panel?.scrollTop ?? 0, groupNavigationAccountId);
  }, [groupNavigationAccountId, selectedGroup, view]);
  const rememberGroupPanelScroll = useCallback((event: React.UIEvent<HTMLElement>) => {
    if (!authenticated || recoveryActive || view !== "groups" || !selectedGroup || !groupNavigationAccountId) return;
    rememberGroupNavigation(selectedGroup.id, event.currentTarget.scrollTop, groupNavigationAccountId);
  }, [authenticated, groupNavigationAccountId, recoveryActive, selectedGroup, view]);
  const choosePlace = useCallback((id: string) => {
    rememberDepartingGroup();
    const origin = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    updateNavigation({ selectedId: id, detailExpanded: view !== "map", view: view === "collection" ? "collection" : "map" }, "push");
    window.history.replaceState({ ...window.history.state, parkdexDetailOrigin: origin, parkdexDetailId: id }, "");
    rememberGroupNavigation(null, 0, groupNavigationAccountId);
    setNavigationNotice(""); setShowFilters(false); setSearchExpanded(false);
  }, [view, rememberDepartingGroup, updateNavigation, groupNavigationAccountId]);
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
    await signOut();
  }
  function toggleSelected(place: Place) {
    if (transitionBusy || loading) return;
    if (!visited.has(place.id)) {
      const nextVisited = new Set(visited).add(place.id), nextTimestamps = { ...visitTimestamps, [place.id]: new Date().toISOString() };
      const nextBadges = achievements({ places, visited: nextVisited, visitTimestamps: nextTimestamps });
      const earnedIds = new Set(newlyEarnedAchievementIds(badgeList, nextBadges));
      const newlyEarned = nextBadges.filter((badge) => earnedIds.has(badge.id));
      setCelebrationBadges(newlyEarned);
    }
    void toggleVisit(place);
  }
  function celebrateClaim(confirmation: ClaimConfirmation) {
    if (visited.has(confirmation.placeId)) return;
    const nextVisited = new Set(visited).add(confirmation.placeId);
    const nextTimestamps = { ...visitTimestamps, [confirmation.placeId]: confirmation.visitedAt };
    const nextBadges = achievements({ places, visited: nextVisited, visitTimestamps: nextTimestamps });
    const earnedIds = new Set(newlyEarnedAchievementIds(badgeList, nextBadges));
    const newlyEarned = nextBadges.filter((badge) => earnedIds.has(badge.id));
    setCelebrationBadges(newlyEarned);
  }

  function rememberImpression(confirmation: ClaimConfirmation) {
    setRecentImpression({ owner: photoOwnerKey, confirmation });
    setCelebrationBadges([]);
  }
  function dismissArrival() {
    if (liveClaimPlace) setDismissedArrival(liveClaimPlace.id);
    setClaimFlow(null);
    clearLiveClaim();
  }
  const recentPlace = recentImpression?.owner === photoOwnerKey && authenticated
    ? places.find((place) => place.id === recentImpression.confirmation.placeId) : undefined;
  const recentPostcard = recentPlace && recentImpression ? {
    place: recentPlace,
    visit: visits[recentPlace.id] ?? { placeId: recentPlace.id, visitedAt: recentImpression.confirmation.visitedAt, claim: recentImpression.confirmation.claim },
  } : undefined;

  return <main className="app-shell field-guide-shell"><div className="skip-controls"><button onClick={focusNavigation}>Skip to navigation</button><button onClick={focusContent}>Skip to content</button></div><section ref={mapStageRef} className={`map-stage view-${view} ${groupMapMode ? "group-map-mode" : ""} ${selected ? "has-selected-place" : ""} ${searchExpanded ? "search-panel-open" : ""}`} aria-label="Parkdex explorer">
    <div id={view === "map" ? "primary-content" : undefined} className="map-content-target" tabIndex={-1} aria-label="Map" /><ParkMap places={mapPlaces} visited={visited} selectedId={selectedId} selectedIds={groupSelectedIds} resetViewRequest={resetViewRequest} showZoomControls={view === "map"} onSelect={choosePlace} onBoundaryLoadState={setBoundaryLoadState} mode="explored" currentLocation={location} recentPostcard={view === "map" ? recentPostcard : undefined} loadPhoto={loadVisitPhoto} photoOwnerKey={photoOwnerKey} onOpenPostcard={() => navigate("account")} />
    {(view === "map" || view === "collection") && !groupMapMode && <div className="guide-view-switch" role="group" aria-label="Field Guide view"><span>Field Guide</span><button aria-pressed={view === "map"} onClick={() => view !== "map" && switchGuide("map")}><MapIcon size={17} />Map</button><button aria-pressed={view === "collection"} onClick={() => view !== "collection" && switchGuide("collection")}><List size={17} />List</button></div>}

    <FieldDiagnosticRegion />
    {view === "map" && approximateClaimLocation && <aside className="in-park-banner precise-location-banner" role={preciseLocationMessage ? "alert" : "status"} aria-live="polite"><span className="in-park-marker"><LocateFixed size={21} /></span><div className="in-park-copy"><strong>Improve location to confirm visits</strong><p>{preciseLocationMessage || (preciseLocationRequired ? "Precise location access changed. Enable it again to check park boundaries." : `Your pin is approximate (±${Math.round(location?.accuracyMeters ?? 0)} m). Precise location is needed to check park boundaries.`)}</p></div><button className="in-park-claim" type="button" disabled={preciseLocationBusy} onClick={() => void enablePreciseLocation()}>{preciseLocationBusy ? "Checking…" : "Enable precise location"}</button></aside>}
    {claimsAvailable && (view === "map" || claimFlow) && liveClaimPlace && displayedRecommendation && recommendClaim && createClaim && reconcileClaim && uploadVisitPhoto && <ClaimFlowBanner key={`${photoOwnerKey}:${liveClaimPlace.id}`} place={liveClaimPlace} recommendation={displayedRecommendation} ownerKey={photoOwnerKey} busy={transitionBusy} resetSignal={claimFlowResetSignal} recommendClaim={recommendClaim} createClaim={createClaim} reconcileClaim={reconcileClaim} uploadPhoto={uploadVisitPhoto} onClaimed={rememberImpression} onDismiss={dismissArrival} onViewAccount={() => navigate("account")} onFlowActiveChange={(placeId) => setClaimFlow(placeId ? { placeId, recommendation: displayedRecommendation } : null)} onClearRecommendation={clearLiveClaim} />}
    {view === "map" && recentPostcard && !displayedRecommendation && !selected && <aside className="impression-map-receipt" aria-label="Your saved postcard"><header><Check size={22} /><div><h2>One more place. Yours.</h2><p>{recentPostcard.place.name}</p></div><button className="impression-icon-button" aria-label="Dismiss saved postcard" onClick={() => setRecentImpression(null)}><X size={18} /></button></header><button className="impression-primary" onClick={() => navigate("account")}>Open your postcard<ArrowUpRight size={18} /></button></aside>}
    {groupMapMode && <button className="group-map-exit" onClick={() => navigate("groups")}><ArrowLeft size={17} />Back to collection</button>}
    {groupMapMode && !selected && <div className="map-visit-filter segmented" role="group" aria-label="Visit status">{(["all", "visited", "unseen"] as VisitFilter[]).map((value) => <button key={value} aria-pressed={collectionVisitFilter === value} className={collectionVisitFilter === value ? "active" : ""} onClick={() => setCollectionVisitFilter(value)}>{value === "all" ? "All" : value === "visited" ? "Visited" : "Unvisited"}</button>)}</div>}
    {view === "map" && !groupMapMode && <><div className={`map-utility ${searchExpanded ? "search-open" : ""}`} role="toolbar" aria-label="Map utilities">{geolocationAllowed && <button className="locate-button" onClick={requestLocation} aria-label="Show my current location"><LocateFixed size={19} className={locationStatus === "locating" ? "spin" : ""} /></button>}<div className={`search-dock ${searchExpanded ? "expanded" : "collapsed"}`}>
        <button className="search-toggle" onClick={() => { if (searchExpanded) applyMapSearch(); else openMapSearch(); }} aria-label={searchExpanded ? "Apply search" : "Search places"}><Search size={20} />{!searchExpanded && (mapSearch.trim() || mapCategories.size > 0) && <span className="active-filter-dot" aria-label="Map filter active" />}</button>
        <input ref={searchInputRef} aria-label="Search places" value={searchExpanded ? mapSearchDraft : mapSearch} onFocus={openMapSearch} onClick={openMapSearch} onChange={(event) => { setMapSearchDraft(event.target.value); setSearchExpanded(true); }} onKeyDown={(event) => { if (event.key === "Enter") applyMapSearch(); if (event.key === "Escape" && !mapSearchDraft) setSearchExpanded(false); }} placeholder="Search parks and islands" />
        {(searchExpanded ? mapSearchDraft : mapSearch) && <button className="icon-button" onClick={() => { setMapSearchDraft(""); setMapSearch(""); }} aria-label="Clear search"><X size={17} /></button>}<button className={`filter-button ${mapCategories.size ? "active" : ""} ${showFilters ? "open" : ""}`} onClick={() => setShowFilters((current) => !current)} aria-label={mapCategories.size ? `Filter places, ${mapCategories.size} active` : "Filter places"} aria-expanded={showFilters} aria-pressed={mapCategories.size > 0}><ListFilter size={18} /></button>{searchExpanded && <button className="search-collapse" onClick={applyMapSearch} aria-label="Apply and close search"><ChevronDown size={19} /></button>}
      </div></div>
      {!searchExpanded && (mapSearch.trim() || mapCategories.size > 0 || collectionAuthorities.size > 0) && <div className="applied-map-search"><div role="status"><strong>{mapFiltered.length ? `${mapFiltered.length} ${mapFiltered.length === 1 ? "place" : "places"} found` : "No places match"}</strong><span>{[mapSearch.trim() ? `“${mapSearch.trim()}”` : "", ...[...mapCategories].map((category) => categoryLabels[category]), ...[...collectionAuthorities].map(collectionTitle)].filter(Boolean).join(" · ")}</span></div><button onClick={resetMapFilters} aria-label="Clear map search and filters"><X size={17} /><span>Clear</span></button></div>}
      <div className="map-visit-filter segmented" role="group" aria-label="Visit status">{(["all", "visited", "unseen"] as VisitFilter[]).map((value) => <button key={value} aria-pressed={collectionVisitFilter === value} className={collectionVisitFilter === value ? "active" : ""} onClick={() => setCollectionVisitFilter(value)}>{value === "all" ? "All" : value === "visited" ? "Visited" : "Unvisited"}</button>)}</div>
      {searchExpanded && mapSearchDraft.trim() && !showFilters && <div className="search-results" aria-live="polite">{mapSearchMatches.length ? <><p>{mapSearchMatches.length} {mapSearchMatches.length === 1 ? "place" : "places"} found</p>{mapSearchMatches.map((place) => <button key={place.id} className={`category-${place.category}`} onClick={() => { setMapSearch(mapSearchDraft); choosePlace(place.id); setSearchExpanded(false); }}><span><strong>{place.name}</strong><small><i />{categoryLabels[place.category]} · {place.region}</small></span><ArrowUpRight size={17} /></button>)}</> : <p className="empty-search">No places match “{mapSearchDraft.trim()}”.</p>}</div>}
    </>}
    {view === "map" && !selected && searchExpanded && !mapSearchDraft.trim() && <MapBrowserPanel places={groupMapMode ? mapPlaces : mapFiltered} visited={visited} title={selectedGroup?.name ?? "Explore places"} inert={showFilters} onSelect={choosePlace} />}
    {view !== "map" && <section key={`${view}-${viewRevision}`} onScroll={rememberGroupPanelScroll} className={`feature-panel feature-${view}`}><button className="content-skip" onClick={focusNavigation}>Skip to navigation</button><div id="primary-content" tabIndex={-1} className="primary-content-target" aria-label={view === "collection" ? "Field Guide" : view === "badges" ? "Badges" : view === "groups" ? "Collections" : "My Dex"} />{view === "collection" && <CollectionView groups={groups} places={places} visited={visited} search={collectionSearch} setSearch={setCollectionSearch} selectedCategories={collectionCategories} authorities={collectionAuthorities} visitFilter={collectionVisitFilter} setVisitFilter={setCollectionVisitFilter} toggleCategory={(value) => toggleSet(setCollectionCategories, value)} resetFilters={resetCollectionFilters} clearActiveFilters={clearCollectionActiveFilters} choosePlace={choosePlace} />}{view === "groups" && authenticated && !recoveryActive && <GroupsView places={places} groups={groupsState.groups} selectedGroupId={groupsState.selectedGroupId} loading={groupsState.loading} retrying={groupsState.retrying} error={groupsState.error} busy={groupsState.busy} offline={groupsState.offline} syncStatus={groupsState.syncStatus} syncMessage={groupsState.syncMessage} pendingMemberships={groupsState.pendingMemberships} onRetry={groupsState.retry} onSelect={groupsState.selectGroup} onClear={() => groupsState.selectGroup(null)} onCreate={groupsState.create} onRename={groupsState.rename} onDelete={groupsState.remove} onAddPlace={groupsState.addPlace} onRemovePlace={groupsState.removePlace} onViewMap={viewSelectedGroupOnMap} onOpenPlace={openGroupMember} />}{view === "badges" && <><button className="groups-back" onClick={() => navigate("account")}><ArrowLeft size={18} />My Dex</button><BadgesView badges={badgeList} earned={earnedBadges} places={places} visited={visited} onOpenPlace={choosePlace} /></>}{(view === "account" || (view === "groups" && (!authenticated || recoveryActive))) && <AccountView section={view === "groups" ? "collections" : "account"} settingsRoute={navigation.settingsOpen} onSettingsRouteChange={changeSettingsRoute} apiBaseUrl={apiBaseUrl} googleAuthAllowed={googleAuthAllowed} account={account} authenticated={authenticated && !recoveryActive} sessionAuthenticated={authenticated} loading={loading} busy={transitionBusy || Boolean(claimFlow)} guestProgressAvailable={guestProgressAvailable} onAuth={completeAuth} onGoogleAuth={authenticateWithGoogle} onExitRecovery={() => setRecoveryActive(false)} onRequestVerification={requestEmailVerification} onConfirmVerification={confirmEmailVerification} onImport={importGuest} onLogout={logoutAndClearGroupHistory} onReset={async () => { await resetProgress(); setCelebrationBadges([]); try { await groupsState.refreshAfterReset(); } catch { setNavigationNotice("Progress was reset, but saved collection data still needs cleanup. Open Collections and retry sync."); } }} onDeleteAccount={onDeleteAccount} badges={badgeList} places={places.filter((place) => visited.has(place.id))} allPlaces={places} visits={visits} visitTimestamps={visitTimestamps} loadPhoto={loadVisitPhoto} removePhoto={removeVisitPhoto} photoOwnerKey={photoOwnerKey} choosePlace={choosePlace} onBrowseBadges={() => navigate("badges")} onShowGuide={() => setShowOnboarding(true)} />}</section>}
    {showFilters && view === "map" && <div className="filter-tray category-chips"><div className="filter-tray-heading"><strong>Filter places</strong><button onClick={() => setShowFilters(false)} aria-label="Close filters"><X size={19} /></button></div>{categories.map((category) => <button key={category} className={`category-${category} ${mapCategories.has(category) ? "selected active" : ""}`} onClick={() => toggleSet(setMapCategories, category)} aria-pressed={mapCategories.has(category)}>{categoryLabels[category]}</button>)}{mapCategories.size > 0 && <button className="clear-filter" onClick={resetMapFilters}>Clear filters</button>}</div>}
    {navigationNotice && <p className="navigation-notice" role="status">{navigationNotice}<button onClick={() => setNavigationNotice("")} aria-label="Dismiss navigation message"><X size={17} /></button></p>}
    {photoOwnerCleanupFailed && <p className="navigation-notice" role="alert">A private photo from the previous account could not be removed yet.<button className="claim-refresh" onClick={() => setPhotoOwnerCleanupAttempt((current) => current + 1)}>Retry private photo cleanup</button></p>}
    {(loadError || syncMessage || storageUnavailable) && <div ref={connectionStatusRef} className="connection-status" role="status" aria-live="polite" aria-atomic="false">{loadError && <p className="connection-note">{loadError}</p>}{syncMessage && <p className="sync-note">{syncMessage}{syncMessage.includes("waiting") && <button onClick={() => void retrySync()}>Retry</button>}</p>}{storageUnavailable && <p className="storage-note">Private storage is blocked; guest progress lasts for this tab.</p>}</div>}
    {selected && <PlaceDetail key={selected.id} place={selected} visit={visits[selected.id]} visited={visited.has(selected.id)} busy={transitionBusy} authenticated={authenticated} claimsAvailable={claimsAvailable} legacyVisitCreationAvailable={legacyVisitCreationAvailable} recommendClaim={recommendClaim} createClaim={createClaim} uploadPhoto={uploadVisitPhoto} loadPhoto={loadVisitPhoto} removePhoto={removeVisitPhoto} ownerKey={photoOwnerKey} onClaimed={celebrateClaim} onOpenPlace={choosePlace} groupsState={groupsState} boundaryState={boundaryLoadState} expanded={detailExpanded} onExpand={() => updateNavigation({ detailExpanded: !detailExpanded })} onClose={closePlace} onToggle={() => toggleSelected(selected)} openCollection={openCollection} />}

    <nav className="thumb-nav parkdex-nav" aria-label="Primary navigation"><span className="rail-brand" aria-hidden="true"><Trees size={22} /></span><Nav active={view === "map" || view === "collection"} click={() => navigate(view === "collection" ? "collection" : "map")} icon={<BookOpen size={20} />} label="Field Guide" /><Nav active={view === "groups"} click={() => navigate("groups")} icon={<Layers size={20} />} label="Collections" /><Nav active={view === "account" || view === "badges"} click={() => navigate("account")} icon={<UserRound size={20} />} label="My Dex" /><button className="navigation-skip" onClick={focusContent}>Skip to content</button></nav>
    <button className={`desktop-profile ${view === "account" || view === "badges" ? "active" : ""}`} onClick={() => navigate("account")} aria-label="Open profile" aria-current={view === "account" || view === "badges" ? "page" : undefined}><UserRound size={22} /></button>
    {showOnboarding && <FieldGuideOnboarding place={places.find((place) => place.id === "provincial-goldstream-park") ?? places[0]} onComplete={completeOnboarding} />}
    {celebrationBadges[0] && <BadgeCelebration key={celebrationBadges[0].id} badge={celebrationBadges[0]} onClaim={() => setCelebrationBadges((current) => current.slice(1))} />}
  </section></main>;
}

function Nav({ active, click, icon, label, ariaName }: { active: boolean; click: () => void; icon: React.ReactNode; label: string; ariaName?: string }) { return <button className={active ? "active" : ""} onClick={click} aria-label={ariaName ?? label} aria-current={active ? "page" : undefined}>{icon}<span>{label}</span></button>; }
function MapBrowserPanel({ places, visited, title, inert, onSelect }: { places: Place[]; visited: ReadonlySet<string>; title: string; inert: boolean; onSelect: (id: string) => void }) {
  const regions = groupByRegion(places);
  return <aside className="map-browser-panel" aria-label="Places on the map" inert={inert}>
    <header className="map-browser-heading"><div><h2>{title}</h2><p>{places.length} {places.length === 1 ? "place" : "places"} on the map</p></div></header>
    <div className="map-browser-list">{regions.length ? regions.map((group) => <section key={group.region} className="map-browser-region"><h3>{group.region}<span>{group.places.length}</span></h3>{group.places.map((place) => <PlaceListRow key={place.id} place={place} visited={visited.has(place.id)} onSelect={() => onSelect(place.id)} />)}</section>) : <p className="map-browser-empty">No places match these filters.</p>}</div>
  </aside>;
}
function PlaceDetail({ expanded, onExpand, place, visit, visited, busy, authenticated, claimsAvailable, legacyVisitCreationAvailable, recommendClaim, createClaim, uploadPhoto, loadPhoto, removePhoto, ownerKey, onClaimed, onOpenPlace, groupsState, boundaryState, onClose, onToggle, openCollection }: {
  expanded: boolean;
  onExpand: () => void;
  place: Place;
  visit?: Visit;
  visited: boolean;
  busy: boolean;
  authenticated: boolean;
  claimsAvailable: boolean;
  legacyVisitCreationAvailable: boolean;
  recommendClaim?: (input: { location: LocationSample }) => Promise<ClaimRecommendation>;
  createClaim?: (input: { recommendationToken: string; expectedPlaceId: string }) => Promise<ClaimConfirmation>;
  uploadPhoto?: (placeId: string, file: File) => Promise<void>;
  loadPhoto?: (placeId: string) => Promise<Blob>;
  removePhoto?: (placeId: string) => Promise<void>;
  ownerKey?: string;
  onClaimed?: (confirmation: ClaimConfirmation) => void;
  onOpenPlace?: (placeId: string) => void;
  groupsState: ReturnType<typeof useGroups>;
  boundaryState: BoundaryLoadState;
  onClose: () => void;
  onToggle: () => void;
  openCollection: (category?: PlaceCategory, authority?: string) => void;
}) {
  const [compactLayout, setCompactLayout] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 859px)");
    if (!query) return;
    const update = () => setCompactLayout(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const modal = expanded && compactLayout;
  const detailRef = useDialogFocus(onClose, modal);
  const image = getPlaceImage(place.id);
  const hasImage = Boolean(image);
  const visitor = getVisitorInformation(place.id);
  const descriptionSource = getPlaceDescriptionSource(place.id);
  const area = formatPlaceArea(place.id);
  const origin = shortOriginForPlace(place) ?? (place.sourceName.trim() || "Source unavailable");
  const firstSentence = place.description.split(/(?<=\.)\s+/)[0];
  const genericDescription = /collection\.$|regional park(?: or conservation area)?\.$|national park reserve\.$|officially named island|^No visitor overview is available/i.test(firstSentence);
  const placeStory = descriptionSource?.status === "no-overview" || genericDescription ? null : place.description.trim();
  const pullStartY = useRef<number | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  useEffect(() => {
    if (feedback?.kind !== "success") return;
    const timer = window.setTimeout(() => setFeedback(null), 8000);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  const showSheetActions = authenticated || visited || legacyVisitCreationAvailable;
  return <article ref={detailRef as React.RefObject<HTMLElement>} role="dialog" aria-modal={modal ? "true" : undefined} className={`place-sheet ${expanded ? "place-sheet-full" : ""} ${hasImage ? "with-photo" : "without-photo"} ${authenticated ? "signed-in" : "guest place-sheet-guest"}`} data-authenticated={authenticated ? "true" : "false"} aria-labelledby="place-detail-title">
    <div className="place-sheet-hero" onTouchStart={(event) => { pullStartY.current = event.touches[0]?.clientY ?? null; }} onTouchEnd={(event) => { if (pullStartY.current === null) return; const distance = event.changedTouches[0]?.clientY - pullStartY.current; pullStartY.current = null; if (distance != null && (expanded ? distance > 45 : distance < -45)) onExpand(); }}><PlaceImage place={place} variant="card" showCredit={false} preload /><button className="sheet-pull-handle" onClick={onExpand} aria-label={expanded ? "Collapse place details" : "Open fullscreen place details"} /></div>
    <header className="place-sheet-header"><div><button className={`place-category category-${place.category}`} onClick={() => openCollection(place.category)} aria-label={`Browse ${categoryLabels[place.category]} places`}>{categoryLabels[place.category]}<ChevronRight size={13} /></button><h2 id="place-detail-title">{place.name}</h2></div><button className="sheet-close" onClick={onClose} aria-label="Close place details"><X size={20} /></button></header>
    <div className="place-sheet-content">
      <div className="place-facts"><span><MapPin size={17} /><span><small>Origin</small><strong>{origin}</strong></span></span>{area && <span><LandPlot size={17} /><span><small>Size</small><strong>{area}</strong></span></span>}</div>
      {showSheetActions && <div className="sheet-actions" data-action-track={authenticated ? "account" : "visit"}>{(visited || legacyVisitCreationAvailable) && <button aria-label={visited ? "Undo visited place" : "Mark as visited"} title={visited ? "Undo visited place" : "Mark as visited"} aria-pressed={visited} disabled={busy} className={`visit-button place-primary-action ${visited ? "is-visited" : ""}`} onClick={onToggle}>{visited ? <RotateCcw size={20} /> : <Check size={20} />}<span className="action-hint">{visited ? "Undo visited" : "Mark visited"}</span></button>}
        {authenticated && <GroupActions place={place} groups={groupsState.groups} busy={groupsState.busy} offline={groupsState.offline} onFeedback={setFeedback} onCreate={async (name, placeIds) => { const created = await groupsState.create(name, placeIds); groupsState.selectGroup(null); return created; }} onAddPlace={groupsState.addPlace} onRemovePlace={groupsState.removePlace} />}
      </div>}
      {((visit?.claim && claimsAvailable) || (!authenticated && typeof recommendClaim === "function")) && recommendClaim && createClaim && uploadPhoto && loadPhoto && removePhoto && <div className="place-primary-action-panel" data-primary-action="visit"><ClaimVisitPanel authenticated={authenticated} place={place} visit={visit} busy={busy} recommendClaim={recommendClaim} createClaim={createClaim} uploadPhoto={uploadPhoto} loadPhoto={loadPhoto} removePhoto={removePhoto} onClaimed={onClaimed} ownerKey={ownerKey} onOpenPlace={onOpenPlace} /></div>}
      {feedback && <p className={`place-action-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
      {placeStory && <section className="place-story"><h3>About this place</h3>{placeStory.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</section>}
      <section className="place-visit-info"><h3>Plan your visit</h3>{visitor ? <a className="official-visitor-link" href={visitor.url} target="_blank" rel="noreferrer"><span><strong>Official visitor information</strong><small>Access, facilities and current notices</small></span><ArrowUpRight size={18} /></a> : <p className="place-visitor-unavailable">Official visitor information is not available for this place yet.</p>}</section>
      <button className="place-collection-link" onClick={() => openCollection(undefined, authorityForPlace(place))}>Browse more from {origin}<ChevronRight size={17} /></button>
      <details className="place-credits"><summary>Map data and photo credits<ChevronDown size={17} /></summary><div><p className="place-pin-note">Map pin: {place.latitude.toFixed(4)}, {place.longitude.toFixed(4)}. The pin may be within the park rather than at an entrance.</p><PlaceProvenance place={place} boundaryState={boundaryState} />{descriptionSource && <p className="place-description-source"><a href={descriptionSource.sourceUrl} target="_blank" rel="noreferrer" title={`${descriptionSource.sourceTitle}, ${descriptionSource.sourceSection}`}>{descriptionSource.status === "no-overview" ? "Visitor overview check" : "Description source"}: {descriptionSource.sourceName}</a></p>}{image && <p className="place-photo-credit">Photo by <a href={image.sourceUrl} target="_blank" rel="noreferrer">{image.creator}</a> · <a href={image.originalUrl} target="_blank" rel="noreferrer">Original</a> · <a href={image.licenseUrl} target="_blank" rel="noreferrer">{image.license}</a> · Changes: {image.changes}</p>}{!placeStory && <p className="place-listing-note">{place.description}</p>}</div></details>
    </div>
  </article>;
}
function PlaceProvenance({ place, boundaryState }: { place: Place; boundaryState: BoundaryLoadState }) { const published = boundaryState.status === "ready" && boundaryState.placeIds.has(place.id); return <>{boundaryState.status === "ready" && !published && <p className="boundary-note"><LandPlot size={15} />No sourced boundary is available.</p>}{boundaryState.status === "failed" && <p className="boundary-note"><LandPlot size={15} />Boundary display unavailable.</p>}<a className={`boundary-note source-note ${published ? "available" : ""}`} href={place.sourceUrl} target="_blank" rel="noreferrer"><LandPlot size={15} />{published ? "Published boundary · source" : "Place source"}<ArrowUpRight size={13} /></a></>; }
function PlaceListRow({ place, visited, onSelect, detail }: { place: Place; visited: boolean; onSelect: () => void; detail?: string }) { return <button className={`place-row category-${place.category}`} onClick={onSelect}><PlaceImage place={place} variant="thumbnail" /><span className={`specimen-number ${visited ? "caught" : ""}`}>{visited ? <Check size={16} /> : <MapPin size={15} />}</span><span className="place-row-copy"><strong>{place.name}</strong><small><i />{categoryLabels[place.category]} · {place.region}{detail && <> · <em>{detail}</em></>}</small></span>{!detail && <ChevronDown size={17} />}</button>; }
function JuicyProgress({ value, total, label }: { value: number; total: number; label: string }) { return <div className="juicy-progress"><div><strong>{label}</strong><span>{value} / {total}</span></div><div className="juicy-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}><span style={{ width: `${total ? value / total * 100 : 0}%` }}><i /></span></div></div>; }
function CategoryProgress({ places, visited }: { places: Place[]; visited: Set<string> }) { const counts = categories.map((category) => { const categoryPlaces = places.filter((place) => place.category === category); return { category, total: categoryPlaces.length, visited: categoryPlaces.filter((place) => visited.has(place.id)).length }; }); const collected = counts.reduce((total, count) => total + count.visited, 0); return <section className="collection-progress" aria-label="Visit progress"><header><strong>{collected} of {places.length} visited</strong></header><div className="collection-progress-track" role="progressbar" aria-label={`${collected} of ${places.length} places visited`} aria-valuemin={0} aria-valuemax={places.length} aria-valuenow={collected}><div>{counts.map(({ category, visited: categoryVisited }) => <span key={category} className={`category-${category}`} style={{ width: `${places.length ? categoryVisited / places.length * 100 : 0}%` }} />)}</div></div><ul>{counts.map(({ category, total, visited: categoryVisited }) => <li key={category} className={`category-${category}`}><i /><span>{categoryLabels[category]}</span><b>{categoryVisited}/{total}</b></li>)}</ul></section>; }

function collectionTitle(authority: string) {
  if (authority === "Parks Canada") return "National Parks";
  if (authority === "BC Parks") return "Provincial Parks";
  if (authority === "Major islands") return "Major Islands";
  const abbreviation = authority.match(/\(([^)]+)\)/)?.[1];
  return abbreviation ? `Regional Parks - ${abbreviation}` : authority;
}

function CollectionView({ groups, places, visited, search, setSearch, selectedCategories, authorities, visitFilter, setVisitFilter, toggleCategory, resetFilters, clearActiveFilters, choosePlace }: { groups: ReturnType<typeof groupByRegion>; places: Place[]; visited: Set<string>; search: string; setSearch: (v: string) => void; selectedCategories: Set<PlaceCategory>; authorities: Set<string>; visitFilter: VisitFilter; setVisitFilter: (v: VisitFilter) => void; toggleCategory: (v: PlaceCategory) => void; resetFilters: () => void; clearActiveFilters: () => void; choosePlace: (id: string) => void }) {
  const hasQuery = Boolean(search.trim());
  const activeFilterLabels = [...(visitFilter === "all" ? [] : [visitFilter]), ...categories.filter((category) => selectedCategories.has(category)).map((category) => categoryLabels[category]), ...[...authorities].map(collectionTitle)];
  const hasActiveFilters = activeFilterLabels.length > 0;
  return <div className={`collection-view search-open ${hasQuery ? "has-query" : ""}`} data-query-active={hasQuery ? "true" : "false"} data-filter-count={activeFilterLabels.length}><div className="collection-scroll"><div className="panel-heading collection-heading" data-query-heading={hasQuery ? "compact" : "full"}><div><h2>Find your next place</h2><p>Explore parks and islands across BC.</p></div></div><CategoryProgress places={places} visited={visited} /><div className="filter-block" role="group" aria-label="Visit status"><span>Show</span><div className="segmented">{(["all", "unseen", "visited"] as VisitFilter[]).map((value) => <button key={value} className={visitFilter === value ? "active" : ""} onClick={() => setVisitFilter(value)} aria-pressed={visitFilter === value}>{value === "all" ? "All" : value === "visited" ? "Visited" : "Unvisited"}</button>)}</div></div><div className="chip-row category-chips" role="group" aria-label="Place categories">{categories.map((category) => <button key={category} className={`category-${category} ${selectedCategories.has(category) ? "active selected" : ""}`} onClick={() => toggleCategory(category)} aria-pressed={selectedCategories.has(category)}>{categoryLabels[category]}</button>)}</div>{hasActiveFilters && <div className="collection-filter-summary" role="status"><span><strong>Filters:</strong> {activeFilterLabels.join(" · ")}</span><button onClick={clearActiveFilters} aria-label="Clear active place filters">Clear filters</button></div>}{groups.length === 0 ? <div className="empty-state"><Compass size={30} /><strong>No places match.</strong><button onClick={hasActiveFilters ? clearActiveFilters : resetFilters}>{hasActiveFilters ? "Clear filters" : "Clear search"}</button></div> : <div className="authority-list">{groups.map((group) => <details key={group.region} open={Boolean(search) || authorities.size > 0}><summary><span>{group.region}</span><b>{group.places.filter((place) => visited.has(place.id)).length}/{group.places.length}</b><ChevronDown size={17} /></summary><div>{group.places.map((place) => <PlaceListRow key={place.id} place={place} visited={visited.has(place.id)} onSelect={() => choosePlace(place.id)} />)}</div></details>)}</div>}</div><div className="collection-search-dock"><Search className="collection-search-icon" size={20} aria-hidden="true" /><input aria-label="Search places" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a park or region" />{search && <button className="collection-search-clear" onClick={() => setSearch("")} aria-label="Clear places search"><X size={17} /></button>}</div></div>;
}

function GroupActions({ place, groups, busy, offline, onCreate, onAddPlace, onRemovePlace, onFeedback }: { onFeedback: (value: { kind: "success" | "error"; text: string } | null) => void; place: Place; groups: import("@/lib/groups").Group[]; busy: boolean; offline: boolean; onCreate: (name: string, placeIds: string[]) => Promise<import("@/lib/groups").Group | null>; onAddPlace: (groupId: string, placeId: string) => Promise<void>; onRemovePlace: (groupId: string, placeId: string) => Promise<void> }) {
  const wishlist = groups.find((group) => group.isWishlist);
  const membership = new Set(groups.filter((group) => group.places.some((member) => member.id === place.id)).map((group) => group.id));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState("");
  const setNotice = (text: string) => onFeedback(text ? { kind: "success", text } : null);
  async function toggleWishlist() {
    if (!wishlist) { onFeedback({ kind: "error", text: "Wishlist is still loading." }); return; }
    setError(""); setNotice("");
    try { if (membership.has(wishlist.id)) await onRemovePlace(wishlist.id, place.id); else await onAddPlace(wishlist.id, place.id); }
    catch (caught) { onFeedback({ kind: "error", text: caught instanceof Error ? caught.message : "Could not update Wishlist." }); }
  }
  return <><section className="group-actions" aria-label={`Save ${place.name} to collections`}><button className={`wishlist-button ${wishlist && membership.has(wishlist.id) ? "saved" : ""}`} onClick={() => void toggleWishlist()} disabled={busy || !wishlist} aria-label={wishlist && membership.has(wishlist.id) ? "Remove this place from Wishlist" : "Add this place to Wishlist"} aria-pressed={Boolean(wishlist && membership.has(wishlist.id))} title={wishlist && membership.has(wishlist.id) ? "Remove from Wishlist" : "Add to Wishlist"}><Heart size={20} fill={wishlist && membership.has(wishlist.id) ? "currentColor" : "none"} /><span>{wishlist && membership.has(wishlist.id) ? "Wishlisted" : "Wishlist"}</span></button><button className="group-quick-action" onClick={() => { setPickerOpen(true); setError(""); setNotice(""); }} disabled={busy} aria-label="Add to Collection" title="Add to Collection"><ListPlus size={20} /><span className="group-action-label">Add to Collection</span></button></section>{pickerOpen && <GroupPickerModal place={place} groups={groups} membership={membership} busy={busy} offline={offline} error={error} onError={setError} onClose={() => setPickerOpen(false)} onCreate={async (name, placeIds) => { const created = await onCreate(name, placeIds); if (created) setNotice(`Created ${created.name}.`); return created; }} onAddPlace={async (groupId, placeId) => { await onAddPlace(groupId, placeId); const group = groups.find((item) => item.id === groupId); setNotice(`Added to ${group?.name ?? "collection"}.`); }} />}</>;
}

function GroupPickerModal({ place, groups, membership, busy, offline, error, onError, onClose, onCreate, onAddPlace }: { place: Place; groups: import("@/lib/groups").Group[]; membership: Set<string>; busy: boolean; offline: boolean; error: string; onError: (value: string) => void; onClose: () => void; onCreate: (name: string, placeIds: string[]) => Promise<import("@/lib/groups").Group | null>; onAddPlace: (groupId: string, placeId: string) => Promise<void> }) {
  const ref = useDialogFocus(onClose);
  const [name, setName] = useState("");
  const ordinaryGroups = groups.filter((group) => !group.isWishlist);
  async function add(groupId: string) { onError(""); try { await onAddPlace(groupId, place.id); onClose(); } catch (caught) { onError(caught instanceof Error ? caught.message : "Could not add this place."); } }
  async function create(event: React.FormEvent) { event.preventDefault(); if (offline) { onError("Reconnect to create a new collection."); return; } if (!name.trim()) { onError("Name your collection first."); return; } onError(""); try { await onCreate(name.trim(), [place.id]); onClose(); } catch (caught) { onError(caught instanceof Error ? caught.message : "Could not create this collection."); } }
  const modal = <div ref={ref as React.RefObject<HTMLDivElement>} className="group-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="group-picker-title" onClick={onClose}><section className="group-picker-modal" onClick={(event) => event.stopPropagation()}><header><div><p>Add this place</p><h2 id="group-picker-title">{place.name}</h2></div><button onClick={onClose} aria-label="Close collection picker"><X size={21} /></button></header><div className="group-picker-options">{ordinaryGroups.length ? <><p className="group-picker-label">Your collections</p>{ordinaryGroups.map((group) => { const included = membership.has(group.id); const content = <><span><strong>{group.name}</strong><small>{included ? "Already added" : `${group.places.length} ${group.places.length === 1 ? "place" : "places"}`}</small></span><Circle size={20} fill={included ? "currentColor" : "none"} aria-hidden="true" /></>; return included ? <div key={group.id} className="group-picker-option is-member">{content}</div> : <button key={group.id} className="group-picker-option" onClick={() => void add(group.id)} disabled={busy} aria-label={`Add ${place.name} to ${group.name}`}>{content}</button>; })}</> : <p className="group-picker-empty">Keep your next adventures together.</p>}<form className="group-picker-create" onSubmit={(event) => void create(event)}><label htmlFor="group-picker-new-name">Create a new collection</label><div><input id="group-picker-new-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Coastal weekends" maxLength={80} /><button type="submit" aria-label="Create collection" disabled={busy || offline} title={offline ? "Reconnect to create a collection" : undefined}><Plus size={18} /></button></div>{offline && <small>Reconnect to create a collection. You can still save this place to an existing collection.</small>}</form>{error && <p className="groups-inline-error" role="alert">{error}</p>}</div></section></div>;
  return typeof document === "undefined" ? null : createPortal(modal, document.body);
}

type GroupsViewProps = {
  places: Place[];
  groups: import("@/lib/groups").Group[];
  selectedGroupId: string | null;
  loading: boolean;
  retrying: boolean;
  error: string;
  busy: boolean;
  offline: boolean;
  syncStatus: ReturnType<typeof useGroups>["syncStatus"];
  syncMessage: string;
  pendingMemberships: number;
  onRetry: () => Promise<void>;
  onSelect: (id: string | null) => void;
  onClear: () => void;
  onCreate: (name: string, placeIds: string[]) => Promise<import("@/lib/groups").Group | null>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAddPlace: (groupId: string, placeId: string) => Promise<void>;
  onRemovePlace: (groupId: string, placeId: string) => Promise<void>;
  onViewMap: () => void;
  onOpenPlace: (id: string) => void;
};

function GroupSyncNotice({ offline, retrying, error, syncStatus, syncMessage, pendingMemberships, onRetry }: Pick<GroupsViewProps, "offline" | "retrying" | "error" | "syncStatus" | "syncMessage" | "pendingMemberships" | "onRetry">) {
  if (retrying && pendingMemberships === 0 && syncStatus !== "error") return null;
  if (syncStatus === "idle" && !syncMessage) return null;
  const title = offline ? "Working offline" : syncStatus === "syncing" ? "Syncing collections" : "Collections need attention";
  const count = `${pendingMemberships} ${pendingMemberships === 1 ? "change" : "changes"}`;
  const detail = syncMessage || error || (pendingMemberships ? `${count} waiting to sync.` : "Checking for the latest collections.");
  const canRetry = offline || pendingMemberships > 0 || syncStatus === "error";
  return <div className={`collections-sync-state ${syncStatus}`} role="status" aria-live="polite"><span><strong>{title}</strong><small>{detail}</small></span>{canRetry && <button onClick={() => void onRetry()}>Try again</button>}</div>;
}

function GroupsView({ places, groups, selectedGroupId, loading, retrying, error, busy, offline, syncStatus, syncMessage, pendingMemberships, onRetry, onSelect, onClear, onCreate, onRename, onDelete, onAddPlace, onRemovePlace, onViewMap, onOpenPlace }: GroupsViewProps) {
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [actionError, setActionError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<import("@/lib/groups").Group | null>(null);
  const selected = groups.find((group) => group.id === selectedGroupId) ?? null;

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    if (offline) { setActionError("Reconnect to create a new collection."); return; }
    if (!name.trim()) { setActionError("Name your collection before saving it."); return; }
    setActionError("");
    try { await onCreate(name.trim(), []); setName(""); setShowCreate(false); }
    catch { /* the shared groups error remains visible */ }
  }
  async function saveRename(event: React.FormEvent, id: string) {
    event.preventDefault();
    if (offline) { setActionError("Reconnect to rename this collection."); return; }
    if (!editingName.trim()) { setActionError("A collection needs a name."); return; }
    setActionError("");
    try { await onRename(id, editingName.trim()); setEditingId(null); }
    catch { /* the shared groups error remains visible */ }
  }
  const wishlist = groups.find((group) => group.isWishlist);
  const ordinaryGroups = groups.filter((group) => !group.isWishlist);
  useEffect(() => {
    if (!selected) return;
    return addNativeBackConsumer(onClear);
  }, [onClear, selected]);
  const syncNotice = <GroupSyncNotice offline={offline} retrying={retrying} error={error} syncStatus={syncStatus} syncMessage={syncMessage} pendingMemberships={pendingMemberships} onRetry={onRetry} />;
  if (selected) return <div className="groups-view groups-detail-screen"><button className="groups-back" onClick={onClear}><ArrowLeft size={18} />All collections</button>{syncNotice}<GroupDetail group={selected} places={places} busy={busy} offline={offline} editingId={editingId} editingName={editingName} actionError={actionError} setEditingId={setEditingId} setEditingName={setEditingName} onRename={saveRename} onDelete={() => setDeleteTarget(selected)} onAddPlace={onAddPlace} onRemovePlace={onRemovePlace} onViewMap={onViewMap} onOpenPlace={onOpenPlace} />{deleteTarget && <DeleteGroupConfirmation group={deleteTarget} busy={busy} offline={offline} onCancel={() => setDeleteTarget(null)} onConfirm={async () => { await onDelete(deleteTarget.id); setDeleteTarget(null); }} />}</div>;
  return <div className="groups-view"><div className="panel-heading groups-heading"><div><h2>Collections</h2><p>Keep related places together.</p></div><button className="primary-action groups-create-toggle" onClick={() => { setShowCreate((current) => !current); setActionError(""); }} aria-expanded={showCreate} disabled={busy || offline} title={offline ? "Reconnect to create a collection" : undefined}><Plus size={18} />New collection</button></div>
    {syncNotice}
    {error && <div className="groups-alert" role="alert"><span>{error}</span><button onClick={() => void onRetry()} disabled={loading}>Try again</button></div>}
    {showCreate && <form className="group-create group-create-name-only" onSubmit={(event) => void submitCreate(event)}><h3>Create a collection</h3><label>Collection name<input aria-label="Collection name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Favorite swimming spots" maxLength={80} autoFocus /></label>{actionError && <p className="groups-inline-error" role="alert">{actionError}</p>}<div className="group-form-actions"><button type="button" className="secondary-action" onClick={() => setShowCreate(false)}>Cancel</button><button className="primary-action" disabled={busy || offline}>{offline ? "Reconnect to save" : busy ? "Saving…" : "Save collection"}</button></div></form>}
    {loading && <div className="groups-state" role="status"><span className="state-pulse" />Loading your collections…</div>}
    {retrying && !groups.length && <div className="groups-state" role="status">Loading your collections…</div>}
    {!loading && !retrying && !error && !ordinaryGroups.length && !wishlist && !showCreate && <div className="groups-empty"><MapPin size={34} /><h3>No collections yet</h3><p>{offline ? "No saved collections are available on this device. Reconnect to load them." : "Create a collection to keep related places together and show them on the map."}</p><button className="primary-action" onClick={() => setShowCreate(true)} disabled={offline}><Plus size={18} />{offline ? "Reconnect to create" : "Create your first collection"}</button></div>}
    {!loading && groups.length > 0 && <div className="group-index" aria-label="Your collections">{wishlist && <button className="wishlist-group-card" onClick={() => onSelect(wishlist.id)}><span className="wishlist-group-icon"><Heart size={23} fill="currentColor" /></span><span><strong>Wishlist</strong><small>{wishlist.places.length} {wishlist.places.length === 1 ? "place" : "places"} · saved for later</small></span><ArrowUpRight size={18} /></button>}<div className="group-list-heading"><h3>Your collections</h3><b>{ordinaryGroups.length}</b></div><div className="group-list">{ordinaryGroups.map((group) => <button className="group-item" key={group.id} onClick={() => onSelect(group.id)}><GroupCover group={group} /><span className="group-item-copy"><strong>{group.name}</strong><small>{group.places.length} {group.places.length === 1 ? "place" : "places"}</small></span><ArrowUpRight size={20} /></button>)}</div></div>}
  </div>;
}

function GroupCover({ group }: { group: import("@/lib/groups").Group }) { const photographed = group.places.map((place) => ({ place, image: getPlaceImage(place.id) })).filter((item): item is { place: Place; image: NonNullable<ReturnType<typeof getPlaceImage>> } => Boolean(item.image)); const covers = photographed.length >= 4 ? photographed.slice(0, 4) : photographed.slice(0, 1); return <span className={`group-cover ${covers.length === 4 ? "group-cover-collage" : ""}`} aria-hidden="true">{covers.length ? covers.map(({ place, image }) => <Image key={place.id} src={image.thumbnail.src} alt="" width={image.thumbnail.width} height={image.thumbnail.height} sizes="84px" />) : <MapPin size={28} />}</span>; }

function GroupDetail({ group, places, busy, offline, editingId, editingName, actionError, setEditingId, setEditingName, onRename, onDelete, onAddPlace, onRemovePlace, onViewMap, onOpenPlace }: { group: import("@/lib/groups").Group; places: Place[]; busy: boolean; offline: boolean; editingId: string | null; editingName: string; actionError: string; setEditingId: (value: string | null) => void; setEditingName: (value: string) => void; onRename: (event: React.FormEvent, id: string) => Promise<void>; onDelete: () => void; onAddPlace: (groupId: string, placeId: string) => Promise<void>; onRemovePlace: (groupId: string, placeId: string) => Promise<void>; onViewMap: () => void; onOpenPlace: (id: string) => void }) {
  const [addSearch, setAddSearch] = useState("");
  const members = new Set(group.places.map((place) => place.id));
  const available = places.filter((place) => !members.has(place.id));
  const matches = addSearch.trim() ? available.filter((place) => matchesPlaceSearch(place, addSearch)) : [];
  return <article className="group-detail"><header>{editingId === group.id ? <form className="group-rename" onSubmit={(event) => void onRename(event, group.id)}><label className="sr-only" htmlFor="group-rename-input">Collection name</label><input id="group-rename-input" value={editingName} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditingId(null); }} maxLength={80} aria-describedby={actionError ? "group-rename-error" : undefined} aria-invalid={Boolean(actionError)} autoFocus /><button aria-label="Save collection name" disabled={busy || offline} title={offline ? "Reconnect to rename this collection" : undefined}><Check size={17} /></button>{actionError && <p id="group-rename-error" className="groups-inline-error" role="alert">{actionError}</p>}</form> : <><div><h3>{group.isWishlist ? "Wishlist" : group.name}</h3><p>{group.places.length} {group.places.length === 1 ? "place" : "places"}</p></div>{!group.isWishlist && <div className="group-detail-actions"><button onClick={() => { setEditingId(group.id); setEditingName(group.name); }} aria-label={`Rename ${group.name}`} disabled={offline} title={offline ? "Reconnect to rename this collection" : undefined}><Pencil size={17} /></button><button onClick={onDelete} aria-label={`Delete ${group.name}`} disabled={offline} title={offline ? "Reconnect to delete this collection" : undefined}><Trash2 size={17} /></button></div>}</>}</header><button className="primary-action group-map-action" onClick={onViewMap} disabled={!group.places.length}><MapIcon size={17} />View on map</button><div className="group-members" aria-label={`${group.isWishlist ? "Wishlist" : group.name} places`}>{group.places.length ? group.places.map((place) => { const hasImage = Boolean(getPlaceImage(place.id)); return <article className={`group-member-card ${hasImage ? "with-photo" : "without-photo"}`} key={place.id}>{hasImage && <button className="group-member-photo" onClick={() => onOpenPlace(place.id)} aria-label={`Open ${place.name}`}><PlaceImage place={place} variant="card" showCredit={false} /></button>}<div><button className="group-member-title" onClick={() => onOpenPlace(place.id)}>{place.name}</button><small><i className={`category-dot category-${place.category}`} />{categoryLabels[place.category]} · {place.region}</small></div><button className="group-member-remove" onClick={() => void onRemovePlace(group.id, place.id)} aria-label={`Remove ${place.name} from ${group.isWishlist ? "Wishlist" : group.name}`} disabled={busy}><X size={16} /></button></article>; }) : <p className="group-no-places">This collection is empty. Add a place below.</p>}</div>{available.length > 0 && <section className="group-add" aria-label="Add places">{matches.length > 0 && <div className="group-add-menu">{matches.map((place) => <button className={`category-${place.category}`} key={place.id} onClick={() => { void onAddPlace(group.id, place.id); setAddSearch(""); }} disabled={busy}><span><strong>{place.name}</strong><small><i />{categoryLabels[place.category]} · {place.region}</small></span><Plus size={18} /></button>)}</div>}<div className="group-add-controls"><label><span className="sr-only">Search places to add</span><Search size={18} /><input aria-label="Search places to add" value={addSearch} onChange={(event) => setAddSearch(event.target.value)} placeholder="Search places to add" /></label></div>{addSearch.trim() && !matches.length && <p className="group-no-places">No available places match that search.</p>}</section>}</article>;
}

function DeleteGroupConfirmation({ group, busy, offline, onCancel, onConfirm }: { group: import("@/lib/groups").Group; busy: boolean; offline: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const ref = useDialogFocus(onCancel);
  return <div ref={ref as React.RefObject<HTMLDivElement>} className="reset-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-group-title" onClick={onCancel}><section className="reset-dialog" onClick={(event) => event.stopPropagation()}><Trash2 size={28} /><h2 id="delete-group-title">Delete {group.name}?</h2><p>{offline ? "Reconnect before deleting this collection." : "The places will stay in your Parkdex."}</p><div><button className="secondary-action" onClick={onCancel}>Cancel</button><button className="reset-action" disabled={busy || offline} onClick={() => void onConfirm()}>{offline ? "Reconnect to delete" : busy ? "Deleting…" : "Delete collection"}</button></div></section></div>;
}

function BadgeCard({ badge, onSelect }: { badge: Achievement; onSelect: (badge: Achievement) => void }) { const image = imageMap[badge.species]; return <button className={`achievement ${badge.earned ? "earned" : "locked"}`} onClick={() => onSelect(badge)}><div className={`badge-photo ${badge.species}`}>{image ? <Image src={image.src} alt="" width={90} height={90} /> : <Award size={28} />}</div><div><h3>{badge.name}</h3><p>{badge.description}</p><div className="badge-progress"><span style={{ width: `${badge.current / badge.target * 100}%` }} /></div><strong>{badge.earned ? `Earned · ${formatDate(badge.earnedAt)}` : `${badge.current} / ${badge.target}`}</strong></div></button>; }
function BadgesView({ badges, earned, places, visited, onOpenPlace }: { badges: Achievement[]; earned: number; places: Place[]; visited: Set<string>; onOpenPlace: (id: string) => void }) { const [selectedBadge, setSelectedBadge] = useState<Achievement | null>(null), collected = badges.filter((badge) => badge.earned), uncollected = badges.filter((badge) => !badge.earned); return <><div className="panel-heading badge-heading"><div><h2>Your badges</h2><p>A living field guide of what you have discovered.</p></div></div><JuicyProgress value={earned} total={badges.length} label="Badges earned" /><section className="badge-group collected"><header><h3>Collected</h3><b>{collected.length}</b></header>{collected.length ? <div className="badge-grid">{collected.map((badge) => <BadgeCard key={badge.id} badge={badge} onSelect={setSelectedBadge} />)}</div> : <p className="badge-group-empty">Your first badge is waiting out on the map.</p>}</section><section className="badge-group uncollected"><header><h3>Still out there</h3><b>{uncollected.length}</b></header><div className="badge-grid">{uncollected.map((badge) => <BadgeCard key={badge.id} badge={badge} onSelect={setSelectedBadge} />)}</div></section>{selectedBadge && <BadgeDetail badge={selectedBadge} places={places} visited={visited} onOpenPlace={onOpenPlace} onClose={() => setSelectedBadge(null)} />}</>; }
function BadgeDetail({ badge, places, visited, onOpenPlace, onClose }: { badge: Achievement; places: Place[]; visited: Set<string>; onOpenPlace: (id: string) => void; onClose: () => void }) { const ref = useDialogFocus(onClose), image = imageMap[badge.species], placeById = new Map(places.map((place) => [place.id, place])), requirements = badge.requiredPlaceIds?.map((id) => placeById.get(id)).filter((place): place is Place => Boolean(place)) ?? []; return <div ref={ref as React.RefObject<HTMLDivElement>} className="badge-detail-backdrop" role="dialog" aria-modal="true" aria-labelledby="badge-detail-title" onClick={onClose}><article className="badge-detail" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={onClose} aria-label="Close badge details"><X size={22} /></button><div className="badge-detail-stage">{image ? <div className="badge-detail-image"><Image src={image.src} alt={image.alt} width={190} height={190} priority /></div> : <div className="badge-detail-image"><Award size={80} /></div>}</div><div className="badge-detail-copy"><p>{badge.earned ? `Earned ${formatDate(badge.earnedAt)}` : `${badge.current} of ${badge.target} complete`}</p><h2 id="badge-detail-title">{badge.name}</h2><p>{badge.description}</p>{requirements.length > 0 && <section className="badge-requirements" aria-label="Badge requirements"><h3>Places to visit</h3><ul>{requirements.map((place) => { const complete = visited.has(place.id); return <li className={`badge-requirement ${complete ? "complete" : "remaining"}`} key={place.id}><button type="button" onClick={() => onOpenPlace(place.id)} aria-label={`Open ${place.name}, ${complete ? "visited" : "not visited"}`}><span aria-hidden="true">{complete ? <Check size={16} /> : <Circle size={13} />}</span><strong>{place.name}</strong><small>{complete ? "Visited" : "Open place"}</small><ArrowUpRight size={16} aria-hidden="true" /></button></li>; })}</ul></section>}{image && <p className="badge-credit">Photo: <a href={image.sourceUrl} target="_blank" rel="noreferrer">{image.creator}</a> · <a href={image.licenseUrl} target="_blank" rel="noreferrer">{image.license}</a></p>}</div></article></div>; }

type AccountViewProps = {
  section: "account" | "collections";
  settingsRoute: boolean;
  onSettingsRouteChange: (open: boolean) => void;
  onShowGuide: () => void;
  onBrowseBadges: () => void;
  apiBaseUrl: string; googleAuthAllowed: boolean; account: Account | null; authenticated: boolean; sessionAuthenticated: boolean; loading: boolean; busy: boolean; guestProgressAvailable: boolean;
  onAuth: (mode: "login" | "register", email: string, password: string) => Promise<void>;
  onGoogleAuth: (code: string, state: string, codeVerifier: string) => Promise<void>;
  onExitRecovery: () => void;
  onRequestVerification: () => Promise<void>; onConfirmVerification: (token: string) => Promise<void>;
  onImport: () => Promise<void>; onLogout: () => Promise<void>; onReset: () => Promise<void>; onDeleteAccount?: () => Promise<AccountDeletionResult>;
  badges: Achievement[]; places: Place[]; allPlaces: Place[]; visits: Record<string, Visit>; visitTimestamps: Record<string, string>; loadPhoto?: (placeId: string) => Promise<Blob>; removePhoto?: (placeId: string) => Promise<void>; photoOwnerKey?: string; choosePlace: (id: string) => void;
};

type DeleteAccountHandler = () => Promise<AccountDeletionResult>;

function cleanAuthParams(names: string[]) {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  names.forEach((name) => { url.searchParams.delete(name); fragment.delete(name); });
  const hash = fragment.toString();
  url.hash = hash;
  const state = readNavigation(url.href);
  const next = navigationUrl(url.href, { ...state, view: "account", settingsOpen: names.includes("action") || url.pathname === "/settings", selectedId: null });
  window.history.replaceState(window.history.state, "", next);
  notifyNavigationChange();
}

function emailToken(name: "resetToken" | "verificationToken") { return new URLSearchParams(window.location.hash.slice(1)).get(name) ?? ""; }

function randomVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Challenge(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function authStatus(error: unknown) { return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : null; }

function PasswordResetRequestCard({ email, emailLocked, error, formBusy, emailEnabled, onEmailChange, onSubmit, onBack }: { email: string; emailLocked?: boolean; error: string; formBusy: boolean; emailEnabled: boolean; onEmailChange: (email: string) => void; onSubmit: (event: React.FormEvent) => void; onBack: () => void }) {
  return <div className="password-reset-flow"><div className="password-reset-icon"><MailCheck size={28} /></div><h2 tabIndex={-1}>Reset your password</h2><p>We’ll send a secure, single-use link to your email. The link expires after one hour.</p><form className="auth-form" onSubmit={onSubmit}><label>Email<input type="email" autoComplete="email" required readOnly={emailLocked} value={email} onChange={(event) => onEmailChange(event.target.value)} />{emailLocked && <small>We’ll send the link to your account email.</small>}</label>{error && <p className="auth-error" role="alert">{error}</p>}<button disabled={formBusy || !emailEnabled}>{formBusy ? "Sending…" : error ? "Try again" : emailEnabled ? "Send reset link" : "Email unavailable"}</button></form><button className="auth-link" onClick={onBack}>{emailLocked ? "Back to account" : "Back to log in"}</button><ReleaseFooter /></div>;
}

function PasswordResetSentCard({ onBack, onTryAnother, backLabel, tryAgainLabel }: { onBack: () => void; onTryAnother: () => void; backLabel: string; tryAgainLabel: string }) {
  return <div className="password-reset-flow"><div className="password-reset-icon sent"><MailCheck size={28} /></div><h2 tabIndex={-1}>Check your inbox</h2><p>If that email is connected to a Parkdex account, reset instructions are on their way. The link expires after one hour and can be used once.</p><button className="primary-action" onClick={onTryAnother}>{tryAgainLabel}</button><button className="auth-link" onClick={onBack}>{backLabel}</button><ReleaseFooter /></div>;
}

function PasswordResetExpiredCard({ onRequest, onBack }: { onRequest: () => void; onBack: () => void }) {
  return <div className="password-reset-flow"><div className="password-reset-icon expired"><X size={28} /></div><h2 tabIndex={-1}>That reset link is no longer valid</h2><p>For your security, reset links expire after one hour and work only once. Request a fresh link to continue.</p><button className="primary-action" onClick={onRequest}>Request a new link</button><button className="auth-link" onClick={onBack}>Back to log in</button><ReleaseFooter /></div>;
}

function AccountView({ section, settingsRoute, onSettingsRouteChange, onShowGuide, onBrowseBadges, apiBaseUrl, googleAuthAllowed, account, authenticated, sessionAuthenticated, loading, busy, guestProgressAvailable, onAuth, onGoogleAuth, onExitRecovery, onRequestVerification, onConfirmVerification, onImport, onLogout, onReset, onDeleteAccount, badges, places, allPlaces, visits, visitTimestamps, loadPhoto, removePhoto, photoOwnerKey, choosePlace }: AccountViewProps) {
  const [resetToken] = useState(() => typeof window === "undefined" ? "" : emailToken("resetToken"));
  const deletionIntent = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("action") === "delete-account";
  const [mode, setMode] = useState<"login" | "register" | "forgot" | "sent" | "reset" | "expired">(resetToken ? "reset" : deletionIntent ? "login" : "register"), [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState(""), [formBusy, setFormBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null), [passwordResetOpen, setPasswordResetOpen] = useState(false);
  const [expanded, setExpanded] = useState<"badges" | "places" | null>(null), [confirmReset, setConfirmReset] = useState(false), [selectedBadge, setSelectedBadge] = useState<Achievement | null>(null);
  const settingsOpen = settingsRoute;
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deletionEmail, setDeletionEmail] = useState(""), [deletionResult, setDeletionResult] = useState<AccountDeletionResult | null>(null);
  useEffect(() => { if (settingsOpen) return addNativeBackConsumer(() => onSettingsRouteChange(false)); }, [settingsOpen, onSettingsRouteChange]);
  const previousResetView = useRef("");
  const callbackHandled = useRef(false), deletionIntentHandled = useRef(false), earned = badges.filter((badge) => badge.earned);
  const deletionHandlerRef = useRef<DeleteAccountHandler | null>(null);

  useEffect(() => {
    if (onDeleteAccount) deletionHandlerRef.current = onDeleteAccount;
  }, [onDeleteAccount]);

  useEffect(() => {
    if (!authenticated || passwordResetOpen || busy || !onDeleteAccount || !account || deletionIntentHandled.current) return;
    if (new URLSearchParams(window.location.search).get("action") !== "delete-account") return;
    deletionIntentHandled.current = true;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setDeletionEmail(account.email);
      setDeletionResult(null);
      setDeleteAccountOpen(true);
    });
    cleanAuthParams(["action"]);
    return () => { active = false; };
  }, [account, authenticated, busy, onDeleteAccount, passwordResetOpen]);

  useEffect(() => { let active = true; void loadAuthConfig(apiBaseUrl).then((config) => { if (active) setAuthConfig(config); }).catch(() => { if (active) setAuthConfig({ googleEnabled: false, emailEnabled: false }); }); return () => { active = false; }; }, [apiBaseUrl]);
  useEffect(() => { if (resetToken) cleanAuthParams(["resetToken"]); }, [resetToken]);
  useEffect(() => {
    if (callbackHandled.current) return;
    const params = new URLSearchParams(window.location.search), code = params.get("code"), state = params.get("state"), oauthError = params.get("error"), verificationToken = emailToken("verificationToken");
    if (!code && !verificationToken && !oauthError) return;
    callbackHandled.current = true;
    if (verificationToken) cleanAuthParams(["verificationToken"]);
    async function completeCallback() {
      if (oauthError) {
        window.sessionStorage.removeItem(GOOGLE_VERIFIER_KEY); cleanAuthParams(["code", "error", "error_description", "state"]);
        throw new Error(oauthError === "access_denied" ? "Google sign-in was cancelled. You can try again." : "Google could not complete sign-in. Please try again.");
      }
      if (code && state) {
        const verifier = window.sessionStorage.getItem(GOOGLE_VERIFIER_KEY);
        window.sessionStorage.removeItem(GOOGLE_VERIFIER_KEY); cleanAuthParams(["code", "state"]);
        if (!verifier) throw new Error("Google sign-in expired. Please try again.");
        await onGoogleAuth(code, state, verifier);
        setNotice("Signed in with Google."); return;
      }
      if (verificationToken) { await onConfirmVerification(verificationToken); setNotice("Email verified. Your field journal is ready."); cleanAuthParams(["verificationToken"]); return; }
      throw new Error("The sign-in response was incomplete. Please try again.");
    }
    queueMicrotask(() => { setFormBusy(true); setError(""); void completeCallback().catch((caught) => setError(caught instanceof Error ? caught.message : "Could not complete this account link.")).finally(() => setFormBusy(false)); });
  }, [onConfirmVerification, onGoogleAuth]);

  const resetView = loading ? "loading" : authenticated && !passwordResetOpen ? "account" : mode;
  useEffect(() => {
    const previous = previousResetView.current;
    previousResetView.current = resetView;
    const resetModes = ["forgot", "sent", "reset", "expired"];
    if (resetView !== "loading" && (resetModes.includes(resetView) || resetModes.includes(previous))) {
      const heading = document.querySelector<HTMLElement>(".feature-account h2, .feature-groups h2");
      heading?.focus();
    }
  }, [resetView]);

  function selectShelfItem(item: ShelfItem) { setExpanded(null); if (item.kind === "place") choosePlace(item.id); else setSelectedBadge(earned.find((badge) => badge.id === item.id) ?? null); }
  function openPasswordReset() { setPasswordResetOpen(true); setMode("forgot"); setEmail(account?.email ?? ""); setError(""); setNotice(""); }
  function openAccountDeletion() {
    if (busy || !onDeleteAccount || !account) return;
    setDeletionEmail(account.email);
    setDeletionResult(null);
    setDeleteAccountOpen(true);
  }
  function closeAccountDeletion() {
    setDeleteAccountOpen(false);
    setDeletionResult(null);
  }
  async function handleDeleteAccount() {
    const handler = onDeleteAccount ?? deletionHandlerRef.current;
    if (!handler) throw new Error("Account deletion is unavailable. Please try again.");
    const result = await handler();
    setDeletionResult(result);
    return result;
  }
  function backToLogin() { onExitRecovery(); setPasswordResetOpen(false); setMode("login"); setError(""); setNotice(""); }
  function backToAccount() { setPasswordResetOpen(false); setMode("register"); setError(""); setNotice(""); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setFormBusy(true); setError(""); setNotice("");
    try {
      if (mode === "forgot") { await requestPasswordReset(apiBaseUrl, email); setMode("sent"); }
      else if (mode === "reset") { if (password !== confirmPassword) throw new Error("Passwords do not match."); await confirmPasswordReset(apiBaseUrl, resetToken, password); if (sessionAuthenticated) await onLogout(); setMode("login"); setPassword(""); setConfirmPassword(""); setNotice("Password reset. Log in with your new password."); }
      else if (mode === "login" || mode === "register") await onAuth(mode, email, password);
    } catch (caught) {
      if (mode === "reset" && authStatus(caught) === 400) { setMode("expired"); setError(""); }
      else if (mode === "forgot") { setError(authStatus(caught) === 429 ? "Too many requests. Try again in a few minutes." : "We couldn’t send the reset email. Please try again."); }
      else setError(caught instanceof Error ? caught.message : "Could not continue.");
    } finally { setFormBusy(false); }
  }
  async function startGoogle() { setFormBusy(true); setError(""); try { const verifier = randomVerifier(); window.sessionStorage.setItem(GOOGLE_VERIFIER_KEY, verifier); window.location.assign(await requestGoogleAuthorization(apiBaseUrl, await sha256Challenge(verifier))); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not start Google sign-in."); setFormBusy(false); } }
  async function resendVerification() { setFormBusy(true); setError(""); try { await onRequestVerification(); setNotice("Verification email sent. Check your inbox."); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not send a verification email."); } finally { setFormBusy(false); } }

  const deletionDialog = deleteAccountOpen && deletionEmail && (onDeleteAccount || deletionResult) ? <AccountDeletionDialog key="account-deletion-dialog" accountEmail={deletionEmail} busy={busy && !deletionResult} onClose={closeAccountDeletion} onDeleteAccount={handleDeleteAccount} successResult={deletionResult} /> : null;

  if (loading) return <div className="account-card"><p>Checking your field journal…</p></div>;
  if (authenticated && passwordResetOpen) {
    if (mode === "sent") return <PasswordResetSentCard onTryAnother={() => { setMode("forgot"); setEmail(account?.email ?? ""); setError(""); }} onBack={backToAccount} backLabel="Back to account" tryAgainLabel="Send another link" />;
    return <PasswordResetRequestCard email={email} emailLocked={Boolean(account?.email)} error={error} formBusy={formBusy} emailEnabled={Boolean(authConfig?.emailEnabled)} onEmailChange={setEmail} onSubmit={submit} onBack={backToAccount} />;
  }
  if (authenticated) return <>
    <div className="panel-heading dex-heading"><div><h2 tabIndex={-1}>{settingsOpen ? "Settings" : "My Dex"}</h2><p>{settingsOpen ? "Your account and saved progress." : "The places you’ve made part of your story."}</p></div><button className="dex-settings" aria-label={settingsOpen ? "Back to My Dex" : "Settings"} onClick={() => onSettingsRouteChange(!settingsOpen)}>{settingsOpen ? <ArrowLeft size={22} /> : <Settings size={22} />}</button></div>
    {settingsOpen ? <section className="dex-account-settings"><button className="secondary-action" onClick={onShowGuide}><BookOpen size={18} />How Parkdex works</button><h3>Account</h3><p>{account?.email ?? "Account details will refresh online"}</p>{notice && <p className="auth-notice" role="status">{notice}</p>}{error && <p className="auth-error" role="alert">{error}</p>}{account && !account.emailVerified && <section className="verification-card"><MailCheck size={22} /><div><strong>Verify your email</strong><p>Confirm that this email address belongs to you.</p></div><button disabled={formBusy || !authConfig?.emailEnabled} onClick={() => void resendVerification()}>{authConfig?.emailEnabled ? "Send verification" : "Email unavailable"}</button></section>}{guestProgressAvailable && <div className="import-card"><strong>Guest progress found on this device</strong><p>Add it to this account? This optional step keeps shared-device collections separate.</p><button disabled={busy} onClick={() => void onImport()}>{busy ? "Working…" : "Add guest progress"}</button></div>}<button disabled={busy} className="secondary-action" onClick={openPasswordReset}><MailCheck size={18} />Reset password by email</button><button disabled={busy} className="secondary-action" onClick={() => void onLogout()}><LogOut size={18} />{busy ? "Signing out…" : "Sign out"}</button><button disabled={busy} className="reset-action" onClick={() => setConfirmReset(true)}><Trash2 size={18} />Reset my progress</button>{onDeleteAccount && <div className="account-delete-section"><h3>Delete account</h3><p>This permanently removes your account and saved progress.</p><button disabled={busy} className="reset-action" onClick={openAccountDeletion}><Trash2 size={18} />Delete account</button></div>}<ReleaseFooter />{deletionDialog}</section> : <>
      <dl className="dex-summary"><div><dt>Places visited</dt><dd>{places.length}</dd></div><div><dt>Saved visits</dt><dd>{places.filter((place) => visits[place.id]).length}</dd></div><div><dt>Postcards</dt><dd>{places.filter((place) => visits[place.id]?.claim).length}</dd></div></dl>
      {loadPhoto && removePhoto && <PostcardCollection places={places} visits={visits} loadPhoto={loadPhoto} removePhoto={removePhoto} ownerKey={photoOwnerKey} onOpenPlace={choosePlace} />}<AccountShelf title="Badges" count={earned.length} items={earned.slice(0, 4).map((badge) => ({ id: badge.id, name: badge.name, kind: "badge" as const, image: imageMap[badge.species]?.src, date: badge.earnedAt }))} onSeeAll={() => setExpanded("badges")} onSelect={selectShelfItem} /><AccountShelf title="Places" count={places.length} items={places.slice(0, 4).map((place) => ({ id: place.id, name: place.name, kind: "place" as const, image: getPlaceImage(place.id)?.thumbnail.src, date: visitTimestamps[place.id] }))} onSeeAll={() => setExpanded("places")} onSelect={selectShelfItem} /><button className="dex-badge-guide" onClick={onBrowseBadges}><Award size={20} />Explore all badges<ChevronRight size={18} /></button>
    </>}{expanded && <CollectionModal title={expanded === "badges" ? "All badges" : "All places"} items={expanded === "badges" ? earned.map((badge) => ({ id: badge.id, name: badge.name, kind: "badge" as const, image: imageMap[badge.species]?.src, date: badge.earnedAt })) : places.map((place) => ({ id: place.id, name: place.name, kind: "place" as const, image: getPlaceImage(place.id)?.thumbnail.src, date: visitTimestamps[place.id] }))} onClose={() => setExpanded(null)} onSelect={selectShelfItem} />}{selectedBadge && <BadgeDetail badge={selectedBadge} places={allPlaces} visited={new Set(places.map((place) => place.id))} onOpenPlace={choosePlace} onClose={() => setSelectedBadge(null)} />}{confirmReset && <ResetConfirmation busy={busy} onCancel={() => setConfirmReset(false)} onConfirm={async () => { await onReset(); setConfirmReset(false); }} />}</>;
  if (mode === "sent") return <PasswordResetSentCard onTryAnother={() => { setMode("forgot"); setEmail(""); setError(""); }} onBack={backToLogin} backLabel="Back to log in" tryAgainLabel="Try another email" />;
  if (mode === "expired") return <PasswordResetExpiredCard onRequest={() => { setMode("forgot"); setEmail(""); setError(""); }} onBack={backToLogin} />;
  if (mode === "forgot") return <PasswordResetRequestCard email={email} error={error} formBusy={formBusy} emailEnabled={Boolean(authConfig?.emailEnabled)} onEmailChange={setEmail} onSubmit={submit} onBack={backToLogin} />;
  const guestHeading = section === "collections" ? "Collections" : "My Dex";
  const guestCopy = deletionIntent ? "Sign in to delete your account. You’ll confirm the deletion next." : section === "collections" ? "Create and sync Collections with an account. You can explore and log visits without one." : "Save visits, postcards and collections with an account. You can explore Field Guide without one.";
  return <><div className="panel-heading"><div><h2 tabIndex={-1}>{mode === "reset" ? "Choose a new password" : guestHeading}</h2><p>{mode === "reset" ? "Use a password you do not use elsewhere." : guestCopy}</p></div><LogIn size={28} /></div>{notice && <p className="auth-notice" role="status">{notice}</p>}{mode !== "reset" && <div className="auth-switch"><button className={mode === "register" ? "active" : ""} onClick={() => { setMode("register"); setError(""); setNotice(""); }}>Create account</button><button className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); setNotice(""); }}>Log in</button></div>}<form className="auth-form" onSubmit={submit}>{mode !== "reset" && <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>}<label>{mode === "reset" ? "New password" : "Password"}<input type="password" minLength={mode === "login" ? 1 : 12} autoComplete={mode === "login" ? "current-password" : "new-password"} required value={password} onChange={(event) => setPassword(event.target.value)} />{mode !== "login" && <small>At least 12 characters.</small>}</label>{mode === "reset" && <label>Confirm new password<input type="password" minLength={12} autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>}{error && <p role="alert">{error}</p>}<button disabled={formBusy}>{formBusy ? "Working…" : mode === "login" ? "Log in" : mode === "register" ? "Create account" : "Reset password"}</button></form>{mode === "login" && <button className="auth-link" onClick={() => { setMode("forgot"); setError(""); setNotice(""); }}>Forgot password?</button>}{mode === "reset" && <button className="auth-link" onClick={backToLogin}>Back to log in</button>}{mode !== "reset" && googleAuthAllowed && <><div className="auth-divider"><span>or</span></div><button className="google-auth" disabled={formBusy || !authConfig?.googleEnabled} onClick={() => void startGoogle()}>{authConfig?.googleEnabled ? "Continue with Google" : "Google sign-in unavailable"}</button></>}<ReleaseFooter />{deletionDialog}</>;
}
function ReleaseFooter() { const [showCredits, setShowCredits] = useState(false); return <><footer className="release-footer"><details className="release-diagnostics"><summary>Build details</summary><span>Parkdex {RELEASE_METADATA.version} · {RELEASE_METADATA.commitSha.slice(0, 7)} · <time dateTime={RELEASE_METADATA.commitDate}>{formatDate(RELEASE_METADATA.commitDate)}</time></span></details><nav style={{ display: "flex", gap: "8px" }} aria-label="Parkdex information"><a style={{ color: "var(--water)", textUnderlineOffset: "3px" }} href={`${PUBLIC_INFORMATION_ORIGIN}/privacy`}>Privacy</a><a style={{ color: "var(--water)", textUnderlineOffset: "3px" }} href={`${PUBLIC_INFORMATION_ORIGIN}/support`}>Support</a><a style={{ color: "var(--water)", textUnderlineOffset: "3px" }} href={`${PUBLIC_INFORMATION_ORIGIN}/delete-account`}>Delete account</a></nav><button onClick={() => setShowCredits(true)}>Credits</button></footer>{showCredits && <CreditsModal onClose={() => setShowCredits(false)} />}</>; }
function CreditsModal({ onClose }: { onClose: () => void }) { const ref = useDialogFocus(onClose); return <div ref={ref as React.RefObject<HTMLDivElement>} className="credits-backdrop" role="dialog" aria-modal="true" aria-labelledby="credits-title" onClick={onClose}><section className="credits-modal" onClick={(event) => event.stopPropagation()}><header><h2 id="credits-title">Credits</h2><button onClick={onClose} aria-label="Close credits"><X size={21} /></button></header><div className="credits-list"><a href="https://openfreemap.org/" target="_blank" rel="noreferrer">Map tiles · OpenFreeMap<ArrowUpRight size={15} /></a><a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">Map style · © OpenMapTiles<ArrowUpRight size={15} /></a><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Map data · © OpenStreetMap contributors<ArrowUpRight size={15} /></a><div><strong>Published park boundaries and place details · BC Parks, Parks Canada, and regional authorities</strong><p>The exact official source is linked on every place card.</p></div></div></section></div>; }
function ResetConfirmation({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) { const ref = useDialogFocus(onCancel); const [error, setError] = useState(""); return <div ref={ref as React.RefObject<HTMLDivElement>} className="reset-backdrop" role="dialog" aria-modal="true" aria-labelledby="reset-title" onClick={onCancel}><section className="reset-dialog" onClick={(event) => event.stopPropagation()}><div className="reset-icon"><Trash2 size={24} /></div><h2 id="reset-title">Reset all progress?</h2><p>This removes all visited places, earned badges, collections, Wishlist saves, and private visit photos from your account. Your empty Wishlist will be ready to use again. This cannot be undone.</p>{error && <p className="reset-error" role="alert">{error}</p>}<div><button disabled={busy} onClick={onCancel}>Keep my progress</button><button disabled={busy} onClick={() => { setError(""); void onConfirm().catch((caught) => setError(caught instanceof Error ? caught.message : "Could not reset progress.")); }}>{busy ? "Resetting…" : "Reset everything"}</button></div></section></div>; }

function AccountShelf({ title, count, items, onSeeAll, onSelect }: { title: string; count: number; items: ShelfItem[]; onSeeAll: () => void; onSelect: (item: ShelfItem) => void }) { return <section className="account-shelf"><header><div><h3>{title}</h3><span>{count}</span></div><button onClick={onSeeAll} disabled={!count}>See all</button></header>{items.length ? <div className="shelf-row">{items.map((item) => <button key={item.id} onClick={() => onSelect(item)} aria-label={`Open ${item.name}`}><span className="shelf-item-media">{item.image ? <Image src={item.image} alt="" width={54} height={54} /> : item.kind === "place" ? <Image src="/places/place-placeholder.png" alt="" width={54} height={54} /> : <span><MapPin size={20} /></span>}</span><strong className="shelf-item-name">{item.name}</strong><time className="shelf-item-date" dateTime={item.date}>{formatShelfDate(item.date)}</time></button>)}</div> : <p className="shelf-empty">Your first {title.toLowerCase()} will appear here.</p>}</section>; }
function CollectionModal({ title, items, onClose, onSelect }: { title: string; items: ShelfItem[]; onClose: () => void; onSelect: (item: ShelfItem) => void }) { const ref = useDialogFocus(onClose); return <div ref={ref as React.RefObject<HTMLDivElement>} className="collection-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="collection-modal-title" onClick={onClose}><section className="collection-modal" onClick={(event) => event.stopPropagation()}><header><h2 id="collection-modal-title">{title}</h2><button className="collection-modal-close" onClick={onClose} aria-label={`Close ${title}`}><X size={21} /></button></header><div>{items.map((item) => <button className="collection-modal-row" key={item.id} onClick={() => onSelect(item)} aria-label={`Open ${item.name}`}>{item.image ? <Image src={item.image} alt="" width={48} height={48} /> : item.kind === "place" ? <Image src="/places/place-placeholder.png" alt="" width={48} height={48} /> : <span><MapPin size={20} /></span>}<div><strong>{item.name}</strong><time dateTime={item.date}>{formatDate(item.date)}</time></div><ArrowUpRight size={17} /></button>)}</div></section></div>; }
const confetti = [
  { kind: "tree", x: 7, delay: -1.9, duration: 3.8, size: 31, drift: 28, turn: 420 },
  { kind: "bear", x: 84, delay: -.4, duration: 4.6, size: 38, drift: -34, turn: -380 },
  { kind: "mushroom", x: 29, delay: -3.2, duration: 5.1, size: 27, drift: 52, turn: 510 },
  { kind: "tree", x: 66, delay: -2.4, duration: 4.2, size: 43, drift: -22, turn: 360 },
  { kind: "mushroom", x: 94, delay: -4.1, duration: 5.4, size: 24, drift: -48, turn: -470 },
  { kind: "bear", x: 45, delay: -1.1, duration: 4.9, size: 32, drift: 33, turn: 400 },
  { kind: "tree", x: 17, delay: -4.6, duration: 5.7, size: 25, drift: -19, turn: -520 },
  { kind: "mushroom", x: 74, delay: -3.5, duration: 4.4, size: 35, drift: 46, turn: 390 },
  { kind: "bear", x: 3, delay: -.8, duration: 5.2, size: 29, drift: 38, turn: -440 },
  { kind: "tree", x: 55, delay: -4.8, duration: 6, size: 37, drift: -41, turn: 540 },
  { kind: "mushroom", x: 38, delay: -2, duration: 4.7, size: 22, drift: -27, turn: -350 },
  { kind: "bear", x: 89, delay: -3, duration: 5.8, size: 27, drift: 24, turn: 490 },
] as const;
function ConfettiIcon({ kind }: { kind: typeof confetti[number]["kind"] }) { if (kind === "tree") return <svg viewBox="0 0 32 40"><path d="M16 2 4 20h7L3 31h26l-8-11h7L16 2Z" fill="currentColor"/><path d="M13 30h6v9h-6z" fill="#7c4b2d"/></svg>; if (kind === "mushroom") return <svg viewBox="0 0 36 36"><path d="M3 18a15 15 0 0 1 30 0H3Z" fill="currentColor"/><path d="M14 17h8l3 16H11l3-16Z" fill="#fff5d7"/><circle cx="13" cy="10" r="2" fill="#fff5d7"/><circle cx="23" cy="8" r="2" fill="#fff5d7"/></svg>; return <svg viewBox="0 0 40 36"><circle cx="9" cy="9" r="6" fill="currentColor"/><circle cx="31" cy="9" r="6" fill="currentColor"/><path d="M6 20C6 7 34 7 34 20c0 10-7 14-14 14S6 30 6 20Z" fill="currentColor"/><ellipse cx="20" cy="25" rx="6" ry="5" fill="#f6f0dc"/><circle cx="14" cy="19" r="2" fill="#173d32"/><circle cx="26" cy="19" r="2" fill="#173d32"/></svg>; }
function BadgeCelebration({ badge, onClaim }: { badge: Achievement; onClaim: () => void }) { const ref = useDialogFocus(() => undefined), image = imageMap[badge.species]; return <div ref={ref as React.RefObject<HTMLDivElement>} className="celebration" role="dialog" aria-modal="true" aria-labelledby="celebration-title"><div className="confetti" aria-hidden="true">{confetti.map((piece, index) => <i key={`${piece.kind}-${index}`} data-confetti-kind={piece.kind} style={{ "--x": `${piece.x}%`, "--delay": `${piece.delay}s`, "--duration": `${piece.duration}s`, "--size": `${piece.size}px`, "--drift": `${piece.drift}px`, "--turn": `${piece.turn}deg` } as CSSProperties}><ConfettiIcon kind={piece.kind} /></i>)}</div><div className="celebration-copy"><p>New discovery!</p><div className="celebration-badge">{image ? <Image src={image.src} alt="" width={190} height={190} priority /> : <Award size={90} />}</div><h2 id="celebration-title">{badge.name}</h2><p>{badge.description}</p><button onClick={onClaim}><Check size={21} />Claim my badge</button></div></div>; }
