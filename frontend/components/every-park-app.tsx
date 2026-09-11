"use client";

import { ArrowLeft, ArrowUpRight, Award, Check, ChevronDown, Compass, Heart, LandPlot, ListFilter, ListPlus, LocateFixed, LogIn, LogOut, MailCheck, Map as MapIcon, MapPin, Plus, RotateCcw, Search, Trees, Trash2, UserRound, X } from "lucide-react";
import Image from "next/image";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ParkMap } from "@/components/park-map";
import { PlaceImage } from "@/components/place-image";
import { confirmPasswordReset, loadAuthConfig, requestGoogleAuthorization, requestPasswordReset, type Account, type AuthConfig } from "@/lib/account";
import { achievements, newlyEarnedAchievementIds, type Achievement } from "@/lib/achievements";
import badgeImages from "@/lib/badge-images.json";
import type { BoundaryLoadState } from "@/lib/boundaries";
import { authorityForPlace, collectionFilter, groupByAuthority, type VisitFilter } from "@/lib/collection";
import { formatDistance, modeForSelection, nearestUnseenParks, type Coordinates } from "@/lib/discovery";
import { getPlaceImage } from "@/lib/place-images";
import { categoryLabels, type Place, type PlaceCategory } from "@/lib/places";
import { RELEASE_METADATA } from "@/lib/release";
import { useFieldJournal } from "@/lib/use-field-journal";
import { useGroups } from "@/lib/use-groups";

const categories = Object.keys(categoryLabels) as PlaceCategory[];
type View = "map" | "collection" | "groups" | "badges" | "account";
type BadgeImage = { src: string; alt: string; creator: string; license: string; licenseUrl: string; sourceUrl: string; species: string };
type ShelfItem = { id: string; name: string; kind: "badge" | "place"; image?: string; date?: string };
const imageMap = badgeImages as Record<string, BadgeImage>;
const GOOGLE_VERIFIER_KEY = "parkdex:google-code-verifier:v1";
const formatDate = (value?: string) => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.valueOf()) ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(date) : "Date unavailable"; };
function useDialogFocus(onClose?: () => void) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    const focusable = () => [...(node?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled])') ?? [])];
    focusable()[0]?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape" && closeRef.current) { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable(); if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return ref;
}

export function ParkdexApp({ apiBaseUrl }: { apiBaseUrl: string }) {
  const journal = useFieldJournal({ apiBaseUrl });
  const { places, visited, visitTimestamps, account, authenticated, loading, loadError, syncMessage, storageUnavailable, guestProgressAvailable, transitionBusy, toggleVisit, retrySync, authenticate: completeAuth, authenticateWithGoogle, requestEmailVerification, confirmEmailVerification, logout: signOut, importGuest, resetProgress, authenticatedRequest } = journal;
  const [selectedId, setSelectedId] = useState<string | null>(null), [mapSearch, setMapSearch] = useState(""), [mapSearchDraft, setMapSearchDraft] = useState("");
  const [mapCategories, setMapCategories] = useState<Set<PlaceCategory>>(new Set());
  const [collectionSearch, setCollectionSearch] = useState(""), [collectionCategories, setCollectionCategories] = useState<Set<PlaceCategory>>(new Set()), [collectionAuthorities, setCollectionAuthorities] = useState<Set<string>>(new Set());
  const [collectionVisitFilter, setCollectionVisitFilter] = useState<VisitFilter>("all"), [view, setView] = useState<View>("map"), [mapMode, setMapMode] = useState<"explored" | "discover">("explored");
  const [location, setLocation] = useState<(Coordinates & { accuracyMeters?: number | null; heading?: number | null }) | null>(null), [locationStatus, setLocationStatus] = useState<"idle" | "locating" | "ready" | "denied" | "unavailable">("idle");
  const [showFilters, setShowFilters] = useState(false), [showNearby, setShowNearby] = useState(false), [searchExpanded, setSearchExpanded] = useState(false), [celebrationBadges, setCelebrationBadges] = useState<Achievement[]>([]);
  const [recoveryActive, setRecoveryActive] = useState(false);
  const [groupMapAdding, setGroupMapAdding] = useState(false), [viewRevision, setViewRevision] = useState(0);
  const groupsState = useGroups({ apiBaseUrl, authenticated: authenticated && !recoveryActive, identityKey: account?.id ?? "", places, request: authenticatedRequest });
  const selectedGroup = groupsState.groups.find((group) => group.id === groupsState.selectedGroupId) ?? null;
  const groupSelectedIds = useMemo(() => new Set(selectedGroup?.places.map((place) => place.id) ?? []), [selectedGroup]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [boundaryLoadState, setBoundaryLoadState] = useState<BoundaryLoadState>({ status: "loading", placeIds: new Set() });
  const groupMapMode = view === "map" && Boolean(selectedGroup);
  const mapFiltered = useMemo(() => collectionFilter(places, mapSearch, mapCategories, new Set(), "all", visited), [places, mapSearch, mapCategories, visited]);
  const mapSearchMatches = useMemo(() => collectionFilter(places, mapSearchDraft, mapCategories, new Set(), "all", visited), [places, mapSearchDraft, mapCategories, visited]);
  const collectionFiltered = useMemo(() => collectionFilter(places, collectionSearch, collectionCategories, collectionAuthorities, collectionVisitFilter, visited), [places, collectionSearch, collectionCategories, collectionAuthorities, collectionVisitFilter, visited]);
  const groups = useMemo(() => groupByAuthority(collectionFiltered), [collectionFiltered]);
  const badgeList = useMemo(() => achievements({ places, visited, visitTimestamps }), [places, visited, visitTimestamps]);
  const earnedBadges = badgeList.filter((badge) => badge.earned).length, selected = places.find((place) => place.id === selectedId) ?? null;
  const nearby = useMemo(() => location ? nearestUnseenParks(places, visited, location) : [], [location, places, visited]);

  useEffect(() => { if (searchExpanded) searchInputRef.current?.focus(); }, [searchExpanded]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search), fragment = new URLSearchParams(window.location.hash.slice(1));
    const hasReset = fragment.has("resetToken"), hasAccountCallback = hasReset || fragment.has("verificationToken") || ((params.has("code") || params.has("error")) && params.has("state"));
    queueMicrotask(() => { if (hasReset) setRecoveryActive(true); if (hasAccountCallback) setView("account"); });
  }, []);

  function requestLocation() {
    if (!navigator.geolocation) { setLocationStatus("unavailable"); setShowNearby(true); return; }
    setLocationStatus("locating"); setShowNearby(true); setMapMode("discover"); setView("map"); setSelectedId(null); setShowFilters(false);
    navigator.geolocation.getCurrentPosition(({ coords }) => { setLocation({ latitude: coords.latitude, longitude: coords.longitude, accuracyMeters: coords.accuracy, heading: coords.heading }); setLocationStatus("ready"); }, (error) => setLocationStatus(error.code === error.PERMISSION_DENIED ? "denied" : "unavailable"), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }
  function resetMapFilters() { setMapSearch(""); setMapSearchDraft(""); setMapCategories(new Set()); }
  function resetCollectionFilters() { setCollectionSearch(""); setCollectionCategories(new Set()); setCollectionAuthorities(new Set()); setCollectionVisitFilter("all"); }
  function toggleSet<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) { setter((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }); }
  const choosePlace = useCallback((id: string) => { setMapMode((current) => modeForSelection(current, visited, id)); setSelectedId(id); setView("map"); setShowNearby(false); setShowFilters(false); }, [visited]);
  function navigate(next: View) {
    const resetting = view === next;
    setSelectedId(null); setShowNearby(false); setShowFilters(false); setGroupMapAdding(false);
    if (next === "map") { groupsState.selectGroup(null); if (resetting) { resetMapFilters(); setMapMode("explored"); setSearchExpanded(false); } }
    if (next === "collection" && resetting) resetCollectionFilters();
    if (next === "groups" && resetting) groupsState.selectGroup(null);
    if (resetting) { setViewRevision((current) => current + 1); requestAnimationFrame(() => document.querySelectorAll<HTMLElement>(".feature-panel, .collection-scroll").forEach((element) => element.scrollTo({ top: 0 }))); }
    setView(next);
  }
  function applyMapSearch() { setMapSearch(mapSearchDraft); setMapMode("discover"); setShowFilters(false); setSearchExpanded(false); }
  function openCollection(category?: PlaceCategory, authority?: string) {
    setCollectionSearch(""); setCollectionVisitFilter("all"); setCollectionCategories(category ? new Set([category]) : new Set()); setCollectionAuthorities(authority ? new Set([authority]) : new Set());
    setSelectedId(null); setShowFilters(false); setView("collection");
  }
  function toggleSelected(place: Place) {
    if (transitionBusy || loading) return;
    if (!visited.has(place.id)) {
      const nextVisited = new Set(visited).add(place.id), nextTimestamps = { ...visitTimestamps, [place.id]: new Date().toISOString() };
      const nextBadges = achievements({ places, visited: nextVisited, visitTimestamps: nextTimestamps });
      const earnedIds = new Set(newlyEarnedAchievementIds(badgeList, nextBadges));
      setCelebrationBadges(nextBadges.filter((badge) => earnedIds.has(badge.id)));
    }
    void toggleVisit(place);
  }

  return <main className="app-shell"><section className={`map-stage view-${view} ${groupMapMode ? "group-map-mode" : ""}`} aria-label="Parkdex explorer">
    <ParkMap places={selectedGroup ? (groupMapAdding ? places : selectedGroup.places) : mapMode === "explored" ? places : mapFiltered} visited={visited} selectedId={selectedId} selectedIds={groupSelectedIds} onSelect={(id) => { if (groupMapAdding && selectedGroup) { if (!groupSelectedIds.has(id)) void groupsState.addPlace(selectedGroup.id, id); return; } choosePlace(id); }} onBoundaryLoadState={setBoundaryLoadState} mode={selectedGroup ? "discover" : mapMode} currentLocation={location} />
    {!groupMapMode && <header className="expedition-header"><div className="brand-mark"><Trees size={22} /></div><div className="brand-copy"><h1>Parkdex</h1><p>A completionist map of Vancouver Island</p></div><nav className="desktop-top-nav" aria-label="Primary navigation"><Nav active={view === "map"} click={() => navigate("map")} icon={<MapIcon size={18} />} label="Map" ariaName="Map tab" />{authenticated && <Nav active={view === "collection"} click={() => navigate("collection")} icon={<Trees size={18} />} label="Places" ariaName="Places tab" />}{authenticated && <Nav active={view === "groups"} click={() => navigate("groups")} icon={<MapPin size={18} />} label="Groups" ariaName="Groups tab" />}{authenticated && <Nav active={view === "badges"} click={() => navigate("badges")} icon={<Award size={18} />} label="Badges" ariaName="Badges tab" />}<Nav active={view === "account"} click={() => navigate("account")} icon={<UserRound size={18} />} label="Account" ariaName="Account tab" /></nav></header>}
    {groupMapMode && <button className="group-map-exit" onClick={() => { setGroupMapAdding(false); navigate("groups"); }}><ArrowLeft size={17} />{groupMapAdding ? "Done adding places" : "Back to group"}</button>}
    {view === "map" && !groupMapMode && !selected && <><div className={`map-utility ${searchExpanded || mapSearch ? "search-open" : ""}`} role="toolbar" aria-label="Map utilities"><div className="map-mode-switch"><button className={mapMode === "explored" ? "active" : ""} onClick={() => { setMapMode("explored"); setShowNearby(false); }}><Trees size={16} /><span>My map</span></button><button className={mapMode === "discover" ? "active" : ""} onClick={() => setMapMode("discover")}><Compass size={16} /><span>Find places</span></button></div><div className={`search-dock ${searchExpanded ? "expanded" : "collapsed"}`}>
        <button className="locate-button" onClick={requestLocation} aria-label="Show my current location"><LocateFixed size={19} className={locationStatus === "locating" ? "spin" : ""} /></button>
        <button className="search-toggle" onClick={() => { if (searchExpanded) applyMapSearch(); else { setMapSearchDraft(mapSearch); setMapMode("discover"); setSearchExpanded(true); } }} aria-label={searchExpanded ? "Apply search" : "Search places"}><Search size={20} />{!searchExpanded && (mapSearch.trim() || mapCategories.size > 0) && <span className="active-filter-dot" aria-label="Map filter active" />}</button>
        {searchExpanded && <input ref={searchInputRef} aria-label="Search places" value={mapSearchDraft} onChange={(event) => setMapSearchDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyMapSearch(); if (event.key === "Escape" && !mapSearchDraft) setSearchExpanded(false); }} placeholder="Find a park or region" />}
        {searchExpanded && <>{mapSearchDraft && <button className="icon-button" onClick={() => setMapSearchDraft("")} aria-label="Clear search"><X size={17} /></button>}<button className={`filter-button ${mapCategories.size ? "active" : ""} ${showFilters ? "open" : ""}`} onClick={() => setShowFilters((current) => !current)} aria-label={mapCategories.size ? `Filter places, ${mapCategories.size} active` : "Filter places"} aria-expanded={showFilters} aria-pressed={mapCategories.size > 0}><ListFilter size={18} /></button><button className="search-collapse" onClick={applyMapSearch} aria-label="Apply and close search"><ChevronDown size={19} /></button></>}
      </div></div>
      {mapMode === "explored" && visited.size === 0 && <div className="first-adventure"><strong>Your next adventure starts here.</strong><span>Find a place, then mark it visited to begin your map.</span><button onClick={() => setMapMode("discover")}><Compass size={17} />Find your first place</button></div>}
      {searchExpanded && mapSearchDraft.trim() && !showFilters && <div className="search-results" aria-live="polite">{mapSearchMatches.length ? <><p>{mapSearchMatches.length} {mapSearchMatches.length === 1 ? "place" : "places"} found</p>{mapSearchMatches.map((place) => <button key={place.id} className={`category-${place.category}`} onClick={() => { setMapSearch(mapSearchDraft); choosePlace(place.id); setSearchExpanded(false); }}><span><strong>{place.name}</strong><small><i />{categoryLabels[place.category]} · {place.region}</small></span><ArrowUpRight size={17} /></button>)}</> : <p className="empty-search">No places match “{mapSearchDraft.trim()}”.</p>}</div>}
      {showNearby && <NearbyDialog status={locationStatus} nearby={nearby} onClose={() => setShowNearby(false)} choosePlace={choosePlace} />}
    </>}
    {view !== "map" && <section key={`${view}-${viewRevision}`} className={`feature-panel feature-${view}`}>{view === "collection" && <CollectionView groups={groups} places={places} visited={visited} search={collectionSearch} setSearch={setCollectionSearch} selectedCategories={collectionCategories} authorities={collectionAuthorities} visitFilter={collectionVisitFilter} setVisitFilter={setCollectionVisitFilter} toggleCategory={(value) => toggleSet(setCollectionCategories, value)} resetFilters={resetCollectionFilters} choosePlace={choosePlace} />}{view === "groups" && <GroupsView places={places} groups={groupsState.groups} selectedGroupId={groupsState.selectedGroupId} loading={groupsState.loading} error={groupsState.error} busy={groupsState.busy} onRetry={groupsState.retry} onSelect={groupsState.selectGroup} onClear={() => groupsState.selectGroup(null)} onCreate={groupsState.create} onRename={groupsState.rename} onDelete={groupsState.remove} onAddPlace={groupsState.addPlace} onRemovePlace={groupsState.removePlace} onViewMap={() => setView("map")} onStartMapAdd={() => { setGroupMapAdding(true); setSelectedId(null); setView("map"); }} onOpenPlace={choosePlace} />}{view === "badges" && <BadgesView badges={badgeList} earned={earnedBadges} />}{view === "account" && <AccountView apiBaseUrl={apiBaseUrl} account={account} authenticated={authenticated && !recoveryActive} sessionAuthenticated={authenticated} loading={loading} busy={transitionBusy} guestProgressAvailable={guestProgressAvailable} onAuth={completeAuth} onGoogleAuth={authenticateWithGoogle} onExitRecovery={() => setRecoveryActive(false)} onRequestVerification={requestEmailVerification} onConfirmVerification={confirmEmailVerification} onImport={importGuest} onLogout={signOut} onReset={async () => { await resetProgress(); setCelebrationBadges([]); }} badges={badgeList} places={places.filter((place) => visited.has(place.id))} visitTimestamps={visitTimestamps} choosePlace={choosePlace} />}</section>}
    {showFilters && view === "map" && <div className="filter-tray category-chips"><div className="filter-tray-heading"><strong>Filter places</strong><button onClick={() => setShowFilters(false)} aria-label="Close filters"><X size={19} /></button></div>{categories.map((category) => <button key={category} className={`category-${category} ${mapCategories.has(category) ? "selected active" : ""}`} onClick={() => toggleSet(setMapCategories, category)}>{categoryLabels[category]}</button>)}{mapCategories.size > 0 && <button className="clear-filter" onClick={resetMapFilters}>Clear filters</button>}</div>}
    {loadError && <p className="connection-note">{loadError}</p>}{syncMessage && <p className="sync-note">{syncMessage}{syncMessage.includes("waiting") && <button onClick={() => void retrySync()}>Retry</button>}</p>}{storageUnavailable && <p className="storage-note">Private storage is blocked; guest progress lasts for this tab.</p>}
    {selected && <article className="place-sheet"><button className="sheet-close" onClick={() => setSelectedId(null)} aria-label="Close place details"><X size={18} /></button><button className={`place-category category-${selected.category}`} onClick={() => openCollection(selected.category)}>{categoryLabels[selected.category]}<ArrowUpRight size={13} /></button><h2>{selected.name}</h2><div className="place-sheet-media"><PlaceImage place={selected} variant="card" /><div className="sheet-actions"><button aria-label={visited.has(selected.id) ? "Undo visited place" : "Mark as visited"} title={visited.has(selected.id) ? "Undo visited place" : "Mark as visited"} disabled={transitionBusy} className={`visit-button ${visited.has(selected.id) ? "is-visited" : ""}`} onClick={() => toggleSelected(selected)}>{visited.has(selected.id) ? <><RotateCcw size={19} /><span>Visited · undo</span></> : <><Check size={20} /><span>Mark as visited</span></>}</button>{authenticated && <GroupActions place={selected} groups={groupsState.groups} busy={groupsState.busy} onCreate={async (name, placeIds) => { const created = await groupsState.create(name, placeIds); groupsState.selectGroup(null); return created; }} onAddPlace={groupsState.addPlace} onRemovePlace={groupsState.removePlace} />}</div></div><p className="place-region"><MapPin size={15} />{selected.region}</p><button className="place-collection-link" onClick={() => openCollection(undefined, authorityForPlace(selected))}>{authorityForPlace(selected)}<ArrowUpRight size={13} /></button><PlaceProvenance place={selected} boundaryState={boundaryLoadState} /><p className="place-description">{selected.description}</p></article>}
    <nav className={`thumb-nav ${authenticated ? "authenticated" : "guest"}`} aria-label="Mobile navigation"><Nav active={view === "map"} click={() => navigate("map")} icon={<MapIcon size={20} />} label="Map" />{authenticated && <Nav active={view === "collection"} click={() => navigate("collection")} icon={<Trees size={20} />} label="Places" />}{authenticated && <Nav active={view === "groups"} click={() => navigate("groups")} icon={<MapPin size={20} />} label="Groups" />}{authenticated && <Nav active={view === "badges"} click={() => navigate("badges")} icon={<Award size={20} />} label="Badges" />}<Nav active={view === "account"} click={() => navigate("account")} icon={<UserRound size={20} />} label="Account" /></nav>
    {celebrationBadges[0] && <BadgeCelebration key={celebrationBadges[0].id} badge={celebrationBadges[0]} onClaim={() => setCelebrationBadges((current) => current.slice(1))} />}
  </section></main>;
}

function Nav({ active, click, icon, label, ariaName }: { active: boolean; click: () => void; icon: React.ReactNode; label: string; ariaName?: string }) { return <button className={active ? "active" : ""} onClick={click} aria-label={ariaName ?? label} aria-current={active ? "page" : undefined}>{icon}<span>{label}</span></button>; }
function PlaceProvenance({ place, boundaryState }: { place: Place; boundaryState: BoundaryLoadState }) { const published = boundaryState.status === "ready" && boundaryState.placeIds.has(place.id); return <>{boundaryState.status === "ready" && !published && <p className="boundary-note"><LandPlot size={15} />No sourced boundary is available.</p>}{boundaryState.status === "failed" && <p className="boundary-note"><LandPlot size={15} />Boundary display unavailable.</p>}<a className={`boundary-note source-note ${published ? "available" : ""}`} href={place.sourceUrl} target="_blank" rel="noreferrer"><LandPlot size={15} />{published ? "Published boundary · source" : "Place source"}<ArrowUpRight size={13} /></a></>; }
function PlaceListRow({ place, visited, onSelect, detail }: { place: Place; visited: boolean; onSelect: () => void; detail?: string }) { return <button className={`place-row category-${place.category}`} onClick={onSelect}><PlaceImage place={place} variant="thumbnail" /><span className={`specimen-number ${visited ? "caught" : ""}`}>{visited ? <Check size={16} /> : <MapPin size={15} />}</span><span className="place-row-copy"><strong>{place.name}</strong><small><i />{categoryLabels[place.category]} · {place.region}{detail && <> · <em>{detail}</em></>}</small></span>{!detail && <ChevronDown size={17} />}</button>; }
function NearbyDialog({ status, nearby, onClose, choosePlace }: { status: "idle" | "locating" | "ready" | "denied" | "unavailable"; nearby: ReturnType<typeof nearestUnseenParks>; onClose: () => void; choosePlace: (id: string) => void }) { const ref = useDialogFocus(onClose); const ready = status === "ready"; const title = ready ? "Unvisited locations in your area" : "Near you"; const message = status === "locating" ? "Finding your location…" : status === "denied" ? "Location is blocked. Allow it in browser settings, then try again." : status === "unavailable" ? "Your location is unavailable right now. Search the map instead." : nearby.length === 0 ? "No unvisited parks are nearby." : "Closest places you have not visited yet."; return <section ref={ref} className="nearby-modal" role="dialog" aria-modal="true" aria-labelledby="nearby-title"><button className="modal-close" onClick={onClose} aria-label="Close nearby places"><X size={20} /></button><div><h2 id="nearby-title">{title}</h2><p>{message}</p></div>{ready && <div className="nearby-list">{nearby.map(({ place, distanceKm }) => <PlaceListRow key={place.id} place={place} visited={false} detail={formatDistance(distanceKm)} onSelect={() => choosePlace(place.id)} />)}</div>}</section>; }
function JuicyProgress({ value, total, label }: { value: number; total: number; label: string }) { return <div className="juicy-progress"><div><strong>{label}</strong><span>{value} / {total}</span></div><div className="juicy-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}><span style={{ width: `${total ? value / total * 100 : 0}%` }}><i /></span></div></div>; }
function CategoryProgress({ places, visited }: { places: Place[]; visited: Set<string> }) { const counts = categories.map((category) => { const categoryPlaces = places.filter((place) => place.category === category); return { category, total: categoryPlaces.length, visited: categoryPlaces.filter((place) => visited.has(place.id)).length }; }); return <section className="collection-progress" aria-label="Collection progress"><header><strong>{visited.size} of {places.length} collected</strong><span>{places.length ? Math.round(visited.size / places.length * 100) : 0}%</span></header><div className="collection-progress-track" role="progressbar" aria-label={`${visited.size} of ${places.length} places collected`} aria-valuemin={0} aria-valuemax={places.length} aria-valuenow={visited.size}><div>{counts.map(({ category, visited: categoryVisited }) => <span key={category} className={`category-${category}`} style={{ width: `${places.length ? categoryVisited / places.length * 100 : 0}%` }} />)}</div></div><ul>{counts.map(({ category, total, visited: categoryVisited }) => <li key={category} className={`category-${category}`}><i /><span>{categoryLabels[category]}</span><b>{categoryVisited}/{total}</b></li>)}</ul></section>; }

function collectionTitle(authority: string) {
  if (authority === "Parks Canada") return "National Parks";
  if (authority === "BC Parks") return "Provincial Parks";
  if (authority === "Major islands") return "Major Islands";
  const abbreviation = authority.match(/\(([^)]+)\)/)?.[1];
  return abbreviation ? `Regional Parks - ${abbreviation}` : authority;
}

function CollectionView({ groups, places, visited, search, setSearch, selectedCategories, authorities, visitFilter, setVisitFilter, toggleCategory, resetFilters, choosePlace }: { groups: ReturnType<typeof groupByAuthority>; places: Place[]; visited: Set<string>; search: string; setSearch: (v: string) => void; selectedCategories: Set<PlaceCategory>; authorities: Set<string>; visitFilter: VisitFilter; setVisitFilter: (v: VisitFilter) => void; toggleCategory: (v: PlaceCategory) => void; resetFilters: () => void; choosePlace: (id: string) => void }) {
  const [searchOpen, setSearchOpen] = useState(Boolean(search)); return <div className={`collection-view ${searchOpen ? "search-open" : ""}`}><div className="collection-scroll"><div className="panel-heading collection-heading"><div><h2>Places</h2><p>A field index for every corner of the island.</p></div><span className="place-total"><strong>{places.length}</strong> tracked</span></div><CategoryProgress places={places} visited={visited} /><div className="filter-block"><span>Show</span><div className="segmented">{(["all", "unseen", "visited"] as VisitFilter[]).map((value) => <button key={value} className={visitFilter === value ? "active" : ""} onClick={() => setVisitFilter(value)}>{value}</button>)}</div></div><div className="chip-row category-chips">{categories.map((category) => <button key={category} className={`category-${category} ${selectedCategories.has(category) ? "active" : ""}`} onClick={() => toggleCategory(category)}>{categoryLabels[category]}</button>)}</div>{groups.length === 0 ? <div className="empty-state"><Compass size={30} /><strong>No places match.</strong><button onClick={resetFilters}>Clear filters</button></div> : <div className="authority-list">{groups.map((group) => <details key={group.authority} open={Boolean(search) || authorities.has(group.authority)}><summary><span>{collectionTitle(group.authority)}</span><b>{group.places.filter((place) => visited.has(place.id)).length}/{group.places.length}</b><ChevronDown size={17} /></summary><div>{group.places.map((place) => <PlaceListRow key={place.id} place={place} visited={visited.has(place.id)} onSelect={() => choosePlace(place.id)} />)}</div></details>)}</div>}</div><div className="collection-search-dock"><button className="collection-search-toggle" onClick={() => setSearchOpen(true)} aria-label={searchOpen ? "Collection search is open" : "Search collection"}><Search size={20} /></button>{searchOpen && <><input autoFocus aria-label="Search collection" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && !search) setSearchOpen(false); }} placeholder="Find a park or region" />{search && <button className="collection-search-clear" onClick={() => setSearch("")} aria-label="Clear collection search"><X size={17} /></button>}<button className="collection-search-close" onClick={() => setSearchOpen(false)} aria-label="Close collection search"><ChevronDown size={19} /></button></>}</div></div>;
}

function GroupActions({ place, groups, busy, onCreate, onAddPlace, onRemovePlace }: { place: Place; groups: import("@/lib/groups").Group[]; busy: boolean; onCreate: (name: string, placeIds: string[]) => Promise<import("@/lib/groups").Group | null>; onAddPlace: (groupId: string, placeId: string) => Promise<void>; onRemovePlace: (groupId: string, placeId: string) => Promise<void> }) {
  const wishlist = groups.find((group) => group.isWishlist);
  const membership = new Set(groups.filter((group) => group.places.some((member) => member.id === place.id)).map((group) => group.id));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function toggleWishlist() {
    if (!wishlist) { setError("Wishlist is still loading."); return; }
    setError(""); setNotice("");
    try { if (membership.has(wishlist.id)) await onRemovePlace(wishlist.id, place.id); else await onAddPlace(wishlist.id, place.id); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update Wishlist."); }
  }
  return <><section className="group-actions" aria-label={`Save ${place.name} to groups`}><button className={`wishlist-button ${wishlist && membership.has(wishlist.id) ? "saved" : ""}`} onClick={() => void toggleWishlist()} disabled={busy || !wishlist} aria-label={wishlist && membership.has(wishlist.id) ? "Remove this place from Wishlist" : "Add this place to Wishlist"} aria-pressed={Boolean(wishlist && membership.has(wishlist.id))}><Heart size={20} fill={wishlist && membership.has(wishlist.id) ? "currentColor" : "none"} /><span>{wishlist && membership.has(wishlist.id) ? "Wishlisted" : "Wishlist"}</span></button><button className="group-quick-action" onClick={() => { setPickerOpen(true); setError(""); setNotice(""); }} disabled={busy} aria-label="Add this place to a group"><ListPlus size={20} /><span>Add to group</span></button>{notice && <p className="groups-inline-success" role="status">{notice}</p>}{error && <p className="groups-inline-error" role="alert">{error}</p>}</section>{pickerOpen && <GroupPickerModal place={place} groups={groups} membership={membership} busy={busy} error={error} onError={setError} onClose={() => setPickerOpen(false)} onCreate={async (name, placeIds) => { const created = await onCreate(name, placeIds); if (created) setNotice(`Created ${created.name}.`); return created; }} onAddPlace={async (groupId, placeId) => { await onAddPlace(groupId, placeId); const group = groups.find((item) => item.id === groupId); setNotice(`Added to ${group?.name ?? "group"}.`); }} />}</>;
}

function GroupPickerModal({ place, groups, membership, busy, error, onError, onClose, onCreate, onAddPlace }: { place: Place; groups: import("@/lib/groups").Group[]; membership: Set<string>; busy: boolean; error: string; onError: (value: string) => void; onClose: () => void; onCreate: (name: string, placeIds: string[]) => Promise<import("@/lib/groups").Group | null>; onAddPlace: (groupId: string, placeId: string) => Promise<void> }) {
  const ref = useDialogFocus(onClose);
  const [name, setName] = useState("");
  const available = groups.filter((group) => !group.isWishlist && !membership.has(group.id));
  async function add(groupId: string) { onError(""); try { await onAddPlace(groupId, place.id); onClose(); } catch (caught) { onError(caught instanceof Error ? caught.message : "Could not add this place."); } }
  async function create(event: React.FormEvent) { event.preventDefault(); if (!name.trim()) { onError("Name your group first."); return; } onError(""); try { await onCreate(name.trim(), [place.id]); onClose(); } catch (caught) { onError(caught instanceof Error ? caught.message : "Could not create this group."); } }
  const modal = <div ref={ref as React.RefObject<HTMLDivElement>} className="group-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="group-picker-title" onClick={onClose}><section className="group-picker-modal" onClick={(event) => event.stopPropagation()}><header><div><p>Add this place</p><h2 id="group-picker-title">{place.name}</h2></div><button onClick={onClose} aria-label="Close group picker"><X size={21} /></button></header><div className="group-picker-options">{available.length ? <><p className="group-picker-label">Your groups</p>{available.map((group) => <button key={group.id} className="group-picker-option" onClick={() => void add(group.id)} disabled={busy}><span><strong>{group.name}</strong><small>{group.places.length} {group.places.length === 1 ? "place" : "places"}</small></span><Plus size={18} /></button>)}</> : <p className="group-picker-empty">Create a group to start a new collection.</p>}<form className="group-picker-create" onSubmit={(event) => void create(event)}><label htmlFor="group-picker-new-name">Create a new group</label><div><input id="group-picker-new-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Coastal weekends" maxLength={80} /><button type="submit" aria-label="Create group" disabled={busy}><Plus size={18} /></button></div></form>{error && <p className="groups-inline-error" role="alert">{error}</p>}</div></section></div>;
  return typeof document === "undefined" ? null : createPortal(modal, document.body);
}

type GroupsViewProps = {
  places: Place[];
  groups: import("@/lib/groups").Group[];
  selectedGroupId: string | null;
  loading: boolean;
  error: string;
  busy: boolean;
  onRetry: () => Promise<void>;
  onSelect: (id: string | null) => void;
  onClear: () => void;
  onCreate: (name: string, placeIds: string[]) => Promise<import("@/lib/groups").Group | null>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAddPlace: (groupId: string, placeId: string) => Promise<void>;
  onRemovePlace: (groupId: string, placeId: string) => Promise<void>;
  onViewMap: () => void;
  onStartMapAdd: () => void;
  onOpenPlace: (id: string) => void;
};

function GroupsView({ places, groups, selectedGroupId, loading, error, busy, onRetry, onSelect, onClear, onCreate, onRename, onDelete, onAddPlace, onRemovePlace, onViewMap, onStartMapAdd, onOpenPlace }: GroupsViewProps) {
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [actionError, setActionError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<import("@/lib/groups").Group | null>(null);
  const selected = groups.find((group) => group.id === selectedGroupId) ?? null;

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setActionError("Name your group before saving it."); return; }
    setActionError("");
    try { await onCreate(name.trim(), []); setName(""); setShowCreate(false); }
    catch { /* the shared groups error remains visible */ }
  }
  async function saveRename(event: React.FormEvent, id: string) {
    event.preventDefault();
    if (!editingName.trim()) { setActionError("A group needs a name."); return; }
    setActionError("");
    try { await onRename(id, editingName.trim()); setEditingId(null); }
    catch { /* the shared groups error remains visible */ }
  }
  const wishlist = groups.find((group) => group.isWishlist);
  const ordinaryGroups = groups.filter((group) => !group.isWishlist);
  if (selected) return <div className="groups-view groups-detail-screen"><button className="groups-back" onClick={onClear}><ArrowLeft size={18} />All groups</button><GroupDetail group={selected} places={places} busy={busy} editingId={editingId} editingName={editingName} actionError={actionError} setEditingId={setEditingId} setEditingName={setEditingName} onRename={saveRename} onDelete={() => setDeleteTarget(selected)} onAddPlace={onAddPlace} onRemovePlace={onRemovePlace} onViewMap={onViewMap} onStartMapAdd={onStartMapAdd} onOpenPlace={onOpenPlace} />{deleteTarget && <DeleteGroupConfirmation group={deleteTarget} busy={busy} onCancel={() => setDeleteTarget(null)} onConfirm={async () => { await onDelete(deleteTarget.id); setDeleteTarget(null); }} />}</div>;
  return <div className="groups-view"><div className="panel-heading groups-heading"><div><h2>Groups</h2><p>Keep related places together.</p></div><button className="primary-action groups-create-toggle" onClick={() => { setShowCreate((current) => !current); setActionError(""); }} aria-expanded={showCreate}><Plus size={18} />New group</button></div>
    {error && <div className="groups-alert" role="alert"><span>{error}</span><button onClick={() => void onRetry()} disabled={loading}>Try again</button></div>}
    {showCreate && <form className="group-create group-create-name-only" onSubmit={(event) => void submitCreate(event)}><h3>Create a group</h3><label>Group name<input aria-label="Group name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Favorite swimming spots" maxLength={80} autoFocus /></label>{actionError && <p className="groups-inline-error" role="alert">{actionError}</p>}<div className="group-form-actions"><button type="button" className="secondary-action" onClick={() => setShowCreate(false)}>Cancel</button><button className="primary-action" disabled={busy}>{busy ? "Saving…" : "Save group"}</button></div></form>}
    {loading && <div className="groups-state" role="status"><span className="state-pulse" />Loading your groups…</div>}
    {!loading && !error && !ordinaryGroups.length && !wishlist && !showCreate && <div className="groups-empty"><MapPin size={34} /><h3>No groups yet</h3><p>Create a group to keep related places together and show them on the map.</p><button className="primary-action" onClick={() => setShowCreate(true)}><Plus size={18} />Create your first group</button></div>}
    {!loading && groups.length > 0 && <div className="group-index" aria-label="Your groups">{wishlist && <button className="wishlist-group-card" onClick={() => onSelect(wishlist.id)}><span className="wishlist-group-icon"><Heart size={27} fill="currentColor" /></span><span><strong>Wishlist</strong><small>{wishlist.places.length} {wishlist.places.length === 1 ? "place" : "places"} · saved for later</small></span><ArrowUpRight size={20} /></button>}<div className="group-list-heading"><h3>Your groups</h3><b>{ordinaryGroups.length}</b></div><div className="group-list">{ordinaryGroups.map((group) => <button className="group-item" key={group.id} onClick={() => onSelect(group.id)}><span className="group-item-mark"><MapPin size={18} /></span><span><strong>{group.name}</strong><small>{group.places.length} {group.places.length === 1 ? "place" : "places"}</small></span><ArrowUpRight size={18} /></button>)}</div></div>}
  </div>;
}

function GroupDetail({ group, places, busy, editingId, editingName, actionError, setEditingId, setEditingName, onRename, onDelete, onAddPlace, onRemovePlace, onViewMap, onStartMapAdd, onOpenPlace }: { group: import("@/lib/groups").Group; places: Place[]; busy: boolean; editingId: string | null; editingName: string; actionError: string; setEditingId: (value: string | null) => void; setEditingName: (value: string) => void; onRename: (event: React.FormEvent, id: string) => Promise<void>; onDelete: () => void; onAddPlace: (groupId: string, placeId: string) => Promise<void>; onRemovePlace: (groupId: string, placeId: string) => Promise<void>; onViewMap: () => void; onStartMapAdd: () => void; onOpenPlace: (id: string) => void }) {
  const [addSearch, setAddSearch] = useState("");
  const members = new Set(group.places.map((place) => place.id));
  const available = places.filter((place) => !members.has(place.id));
  const matches = addSearch.trim() ? available.filter((place) => `${place.name} ${place.region}`.toLocaleLowerCase().includes(addSearch.trim().toLocaleLowerCase())) : [];
  return <article className="group-detail"><header>{editingId === group.id ? <form className="group-rename" onSubmit={(event) => void onRename(event, group.id)}><label className="sr-only" htmlFor="group-rename-input">Group name</label><input id="group-rename-input" value={editingName} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditingId(null); }} maxLength={80} aria-describedby={actionError ? "group-rename-error" : undefined} aria-invalid={Boolean(actionError)} autoFocus /><button aria-label="Save group name" disabled={busy}><Check size={17} /></button>{actionError && <p id="group-rename-error" className="groups-inline-error" role="alert">{actionError}</p>}</form> : <><div><button className="group-name-button" onClick={() => { if (!group.isWishlist) { setEditingId(group.id); setEditingName(group.name); } }} disabled={group.isWishlist} aria-label={group.isWishlist ? undefined : `Rename ${group.name}`}><h3>{group.isWishlist ? "Wishlist" : group.name}</h3></button><p>{group.places.length} {group.places.length === 1 ? "place" : "places"}</p></div>{!group.isWishlist && <button className="group-delete-button" onClick={onDelete} aria-label={`Delete ${group.name}`}><Trash2 size={17} /></button>}</>}</header><button className="primary-action group-map-action" onClick={onViewMap} disabled={!group.places.length}><MapIcon size={17} />View on map</button><div className="group-members" aria-label={`${group.isWishlist ? "Wishlist" : group.name} places`}>{group.places.length ? group.places.map((place) => <article className="group-member-card" key={place.id}><PlaceImage place={place} variant="card" /><div><button className="group-member-title" onClick={() => onOpenPlace(place.id)}>{place.name}</button><small>{categoryLabels[place.category]} · {place.region}</small></div><button onClick={() => void onRemovePlace(group.id, place.id)} aria-label={`Remove ${place.name} from ${group.isWishlist ? "Wishlist" : group.name}`} disabled={busy}><X size={16} /></button></article>) : <p className="group-no-places">This group is empty. Add a place below.</p>}</div>{available.length > 0 && <section className="group-add" aria-label="Add places"><div className="group-add-controls"><label><span className="sr-only">Search places to add</span><Search size={17} /><input value={addSearch} onChange={(event) => setAddSearch(event.target.value)} placeholder="Search places to add" /></label><button className="secondary-action group-map-pick" onClick={onStartMapAdd}><MapIcon size={17} />Pick from map</button></div>{matches.length > 0 && <div className="group-add-menu">{matches.map((place) => <button key={place.id} onClick={() => { void onAddPlace(group.id, place.id); setAddSearch(""); }} disabled={busy}><span>{place.name}</span><small>{place.region}</small></button>)}</div>}{addSearch.trim() && !matches.length && <p className="group-no-places">No available places match that search.</p>}</section>}</article>;
}

function DeleteGroupConfirmation({ group, busy, onCancel, onConfirm }: { group: import("@/lib/groups").Group; busy: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const ref = useDialogFocus(onCancel);
  return <div ref={ref as React.RefObject<HTMLDivElement>} className="reset-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-group-title" onClick={onCancel}><section className="reset-dialog" onClick={(event) => event.stopPropagation()}><Trash2 size={28} /><h2 id="delete-group-title">Delete {group.name}?</h2><p>The places will stay in your Parkdex.</p><div><button className="secondary-action" onClick={onCancel}>Cancel</button><button className="reset-action" disabled={busy} onClick={() => void onConfirm()}>{busy ? "Deleting…" : "Delete group"}</button></div></section></div>;
}

function BadgeCard({ badge, onSelect }: { badge: Achievement; onSelect: (badge: Achievement) => void }) { const image = imageMap[badge.species]; return <button className={`achievement ${badge.earned ? "earned" : "locked"}`} onClick={() => onSelect(badge)}><div className={`badge-photo ${badge.species}`}>{image ? <Image src={image.src} alt="" width={90} height={90} /> : <Award size={28} />}</div><div><h3>{badge.name}</h3><p>{badge.description}</p><div className="badge-progress"><span style={{ width: `${badge.current / badge.target * 100}%` }} /></div><strong>{badge.earned ? `Earned · ${formatDate(badge.earnedAt)}` : `${badge.current} / ${badge.target}`}</strong></div></button>; }
function BadgesView({ badges, earned }: { badges: Achievement[]; earned: number }) { const [selectedBadge, setSelectedBadge] = useState<Achievement | null>(null), collected = badges.filter((badge) => badge.earned), uncollected = badges.filter((badge) => !badge.earned); return <><div className="panel-heading badge-heading"><div><h2>Your badges</h2><p>A living field guide of what you have discovered.</p></div></div><JuicyProgress value={earned} total={badges.length} label="Badges earned" /><section className="badge-group collected"><header><h3>Collected</h3><b>{collected.length}</b></header>{collected.length ? <div className="badge-grid">{collected.map((badge) => <BadgeCard key={badge.id} badge={badge} onSelect={setSelectedBadge} />)}</div> : <p className="badge-group-empty">Your first badge is waiting out on the map.</p>}</section><section className="badge-group uncollected"><header><h3>Still out there</h3><b>{uncollected.length}</b></header><div className="badge-grid">{uncollected.map((badge) => <BadgeCard key={badge.id} badge={badge} onSelect={setSelectedBadge} />)}</div></section>{selectedBadge && <BadgeDetail badge={selectedBadge} onClose={() => setSelectedBadge(null)} />}</>; }
function BadgeDetail({ badge, onClose }: { badge: Achievement; onClose: () => void }) { const ref = useDialogFocus(onClose), image = imageMap[badge.species]; return <div ref={ref as React.RefObject<HTMLDivElement>} className="badge-detail-backdrop" role="dialog" aria-modal="true" aria-labelledby="badge-detail-title" onClick={onClose}><article className="badge-detail" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={onClose} aria-label="Close badge details"><X size={22} /></button><div className="badge-detail-stage">{image ? <div className="badge-detail-image"><Image src={image.src} alt={image.alt} width={190} height={190} priority /></div> : <div className="badge-detail-image"><Award size={80} /></div>}</div><div className="badge-detail-copy"><p>{badge.earned ? `Earned ${formatDate(badge.earnedAt)}` : `${badge.current} of ${badge.target} complete`}</p><h2 id="badge-detail-title">{badge.name}</h2><p>{badge.description}</p>{image && <p className="badge-credit">Photo: <a href={image.sourceUrl} target="_blank" rel="noreferrer">{image.creator}</a> · <a href={image.licenseUrl} target="_blank" rel="noreferrer">{image.license}</a></p>}</div></article></div>; }

type AccountViewProps = {
  apiBaseUrl: string; account: Account | null; authenticated: boolean; sessionAuthenticated: boolean; loading: boolean; busy: boolean; guestProgressAvailable: boolean;
  onAuth: (mode: "login" | "register", email: string, password: string) => Promise<void>;
  onGoogleAuth: (code: string, state: string, codeVerifier: string) => Promise<void>;
  onExitRecovery: () => void;
  onRequestVerification: () => Promise<void>; onConfirmVerification: (token: string) => Promise<void>;
  onImport: () => Promise<void>; onLogout: () => Promise<void>; onReset: () => Promise<void>;
  badges: Achievement[]; places: Place[]; visitTimestamps: Record<string, string>; choosePlace: (id: string) => void;
};

function cleanAuthParams(names: string[]) {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  names.forEach((name) => { url.searchParams.delete(name); fragment.delete(name); });
  const hash = fragment.toString();
  window.history.replaceState({}, "", `${url.pathname}${url.search}${hash ? `#${hash}` : ""}`);
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
  return <div className="password-reset-flow"><div className="password-reset-icon"><MailCheck size={28} /></div><h2>Reset your password</h2><p>We’ll send a secure, single-use link to your email. The link expires after one hour.</p><form className="auth-form" onSubmit={onSubmit}><label>Email<input type="email" autoComplete="email" required readOnly={emailLocked} value={email} onChange={(event) => onEmailChange(event.target.value)} />{emailLocked && <small>We’ll send the link to your account email.</small>}</label>{error && <p className="auth-error" role="alert">{error}</p>}<button disabled={formBusy || !emailEnabled}>{formBusy ? "Sending…" : error ? "Try again" : emailEnabled ? "Send reset link" : "Email unavailable"}</button></form><button className="auth-link" onClick={onBack}>{emailLocked ? "Back to account" : "Back to log in"}</button><ReleaseFooter /></div>;
}

function PasswordResetSentCard({ onBack, onTryAnother, backLabel, tryAgainLabel }: { onBack: () => void; onTryAnother: () => void; backLabel: string; tryAgainLabel: string }) {
  return <div className="password-reset-flow"><div className="password-reset-icon sent"><MailCheck size={28} /></div><h2>Check your inbox</h2><p>If that email is connected to a Parkdex account, reset instructions are on their way. The link expires after one hour and can be used once.</p><button className="primary-action" onClick={onTryAnother}>{tryAgainLabel}</button><button className="auth-link" onClick={onBack}>{backLabel}</button><ReleaseFooter /></div>;
}

function PasswordResetExpiredCard({ onRequest, onBack }: { onRequest: () => void; onBack: () => void }) {
  return <div className="password-reset-flow"><div className="password-reset-icon expired"><X size={28} /></div><h2>That reset link is no longer valid</h2><p>For your security, reset links expire after one hour and work only once. Request a fresh link to continue.</p><button className="primary-action" onClick={onRequest}>Request a new link</button><button className="auth-link" onClick={onBack}>Back to log in</button><ReleaseFooter /></div>;
}

function AccountView({ apiBaseUrl, account, authenticated, sessionAuthenticated, loading, busy, guestProgressAvailable, onAuth, onGoogleAuth, onExitRecovery, onRequestVerification, onConfirmVerification, onImport, onLogout, onReset, badges, places, visitTimestamps, choosePlace }: AccountViewProps) {
  const [resetToken] = useState(() => typeof window === "undefined" ? "" : emailToken("resetToken"));
  const [mode, setMode] = useState<"login" | "register" | "forgot" | "sent" | "reset" | "expired">(resetToken ? "reset" : "register"), [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState(""), [formBusy, setFormBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null), [passwordResetOpen, setPasswordResetOpen] = useState(false);
  const [expanded, setExpanded] = useState<"badges" | "places" | null>(null), [confirmReset, setConfirmReset] = useState(false), [selectedBadge, setSelectedBadge] = useState<Achievement | null>(null);
  const callbackHandled = useRef(false), earned = badges.filter((badge) => badge.earned);

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
        window.sessionStorage.removeItem(GOOGLE_VERIFIER_KEY); cleanAuthParams(["error", "error_description", "state"]);
        throw new Error(oauthError === "access_denied" ? "Google sign-in was cancelled. You can try again." : "Google could not complete sign-in. Please try again.");
      }
      if (code && state) {
        const verifier = window.sessionStorage.getItem(GOOGLE_VERIFIER_KEY);
        if (!verifier) throw new Error("Google sign-in expired. Please try again.");
        window.sessionStorage.removeItem(GOOGLE_VERIFIER_KEY); cleanAuthParams(["code", "state"]);
        await onGoogleAuth(code, state, verifier);
        setNotice("Signed in with Google."); return;
      }
      if (verificationToken) { await onConfirmVerification(verificationToken); setNotice("Email verified. Your field journal is ready."); cleanAuthParams(["verificationToken"]); return; }
      throw new Error("The sign-in response was incomplete. Please try again.");
    }
    queueMicrotask(() => { setFormBusy(true); setError(""); void completeCallback().catch((caught) => setError(caught instanceof Error ? caught.message : "Could not complete this account link.")).finally(() => setFormBusy(false)); });
  }, [onConfirmVerification, onGoogleAuth]);

  function selectShelfItem(item: ShelfItem) { setExpanded(null); if (item.kind === "place") choosePlace(item.id); else setSelectedBadge(earned.find((badge) => badge.id === item.id) ?? null); }
  function openPasswordReset() { setPasswordResetOpen(true); setMode("forgot"); setEmail(account?.email ?? ""); setError(""); setNotice(""); }
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

  if (loading) return <div className="account-card"><p>Checking your field journal…</p></div>;
  if (authenticated && passwordResetOpen) {
    if (mode === "sent") return <PasswordResetSentCard onTryAnother={() => { setMode("forgot"); setEmail(account?.email ?? ""); setError(""); }} onBack={backToAccount} backLabel="Back to account" tryAgainLabel="Send another link" />;
    return <PasswordResetRequestCard email={email} emailLocked={Boolean(account?.email)} error={error} formBusy={formBusy} emailEnabled={Boolean(authConfig?.emailEnabled)} onEmailChange={setEmail} onSubmit={submit} onBack={backToAccount} />;
  }
  if (authenticated) return <><div className="panel-heading"><div><h2>Your account</h2><p>{account?.email ?? "Signed in · account details will refresh online"}</p></div><UserRound size={28} /></div>{notice && <p className="auth-notice" role="status">{notice}</p>}{error && <p className="auth-error" role="alert">{error}</p>}{account && !account.emailVerified && <section className="verification-card"><MailCheck size={22} /><div><strong>Verify your email</strong><p>Confirm that this email address belongs to you.</p></div><button disabled={formBusy || !authConfig?.emailEnabled} onClick={() => void resendVerification()}>{authConfig?.emailEnabled ? "Send verification" : "Email unavailable"}</button></section>}<AccountShelf title="Badges" count={earned.length} items={earned.slice(0, 4).map((badge) => ({ id: badge.id, name: badge.name, kind: "badge" as const, image: imageMap[badge.species]?.src, date: badge.earnedAt }))} onSeeAll={() => setExpanded("badges")} onSelect={selectShelfItem} /><AccountShelf title="Places" count={places.length} items={places.slice(0, 4).map((place) => ({ id: place.id, name: place.name, kind: "place" as const, image: getPlaceImage(place.id)?.thumbnail.src, date: visitTimestamps[place.id] }))} onSeeAll={() => setExpanded("places")} onSelect={selectShelfItem} />{guestProgressAvailable && <div className="import-card"><strong>Guest progress found on this device</strong><p>Add it to this account? This optional step keeps shared-device collections separate.</p><button disabled={busy} onClick={() => void onImport()}>{busy ? "Working…" : "Add guest progress"}</button></div>}<button disabled={busy} className="secondary-action" onClick={openPasswordReset}><MailCheck size={18} />Reset password by email</button><button disabled={busy} className="secondary-action" onClick={() => void onLogout()}><LogOut size={18} />{busy ? "Signing out…" : "Sign out"}</button><button disabled={busy} className="reset-action" onClick={() => setConfirmReset(true)}><Trash2 size={18} />Reset my progress</button><ReleaseFooter />{expanded && <CollectionModal title={expanded === "badges" ? "All badges" : "All places"} items={expanded === "badges" ? earned.map((badge) => ({ id: badge.id, name: badge.name, kind: "badge" as const, image: imageMap[badge.species]?.src, date: badge.earnedAt })) : places.map((place) => ({ id: place.id, name: place.name, kind: "place" as const, image: getPlaceImage(place.id)?.thumbnail.src, date: visitTimestamps[place.id] }))} onClose={() => setExpanded(null)} onSelect={selectShelfItem} />}{selectedBadge && <BadgeDetail badge={selectedBadge} onClose={() => setSelectedBadge(null)} />}{confirmReset && <ResetConfirmation busy={busy} onCancel={() => setConfirmReset(false)} onConfirm={async () => { await onReset(); setConfirmReset(false); }} />}</>;
  if (mode === "sent") return <PasswordResetSentCard onTryAnother={() => { setMode("forgot"); setEmail(""); setError(""); }} onBack={backToLogin} backLabel="Back to log in" tryAgainLabel="Try another email" />;
  if (mode === "expired") return <PasswordResetExpiredCard onRequest={() => { setMode("forgot"); setEmail(""); setError(""); }} onBack={backToLogin} />;
  if (mode === "forgot") return <PasswordResetRequestCard email={email} error={error} formBusy={formBusy} emailEnabled={Boolean(authConfig?.emailEnabled)} onEmailChange={setEmail} onSubmit={submit} onBack={backToLogin} />;
  return <><div className="panel-heading"><div><h2>{mode === "reset" ? "Choose a new password" : "Keep your field journal"}</h2><p>{mode === "reset" ? "Use a password you do not use elsewhere." : "Save visits and badges to your account."}</p></div><LogIn size={28} /></div>{notice && <p className="auth-notice" role="status">{notice}</p>}{mode !== "reset" && <div className="auth-switch"><button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create account</button><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Log in</button></div>}<form className="auth-form" onSubmit={submit}>{mode !== "reset" && <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>}<label>{mode === "reset" ? "New password" : "Password"}<input type="password" minLength={mode === "login" ? 1 : 12} autoComplete={mode === "login" ? "current-password" : "new-password"} required value={password} onChange={(event) => setPassword(event.target.value)} />{mode !== "login" && <small>At least 12 characters.</small>}</label>{mode === "reset" && <label>Confirm new password<input type="password" minLength={12} autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>}{error && <p role="alert">{error}</p>}<button disabled={formBusy}>{formBusy ? "Working…" : mode === "login" ? "Log in" : mode === "register" ? "Create account" : "Reset password"}</button></form>{mode === "login" && <button className="auth-link" onClick={() => { setMode("forgot"); setError(""); setNotice(""); }}>Forgot password?</button>}{mode === "reset" && <button className="auth-link" onClick={backToLogin}>Back to log in</button>}{mode !== "reset" && <><div className="auth-divider"><span>or</span></div><button className="google-auth" disabled={formBusy || !authConfig?.googleEnabled} onClick={() => void startGoogle()}>{authConfig?.googleEnabled ? "Continue with Google" : "Google sign-in unavailable"}</button></>}<ReleaseFooter /></>;
}
function ReleaseFooter() { const [showCredits, setShowCredits] = useState(false); return <><footer className="release-footer"><span>Parkdex {RELEASE_METADATA.version} · {RELEASE_METADATA.commitSha.slice(0, 7)} · <time dateTime={RELEASE_METADATA.commitDate}>{formatDate(RELEASE_METADATA.commitDate)}</time></span><button onClick={() => setShowCredits(true)}>Credits</button></footer>{showCredits && <CreditsModal onClose={() => setShowCredits(false)} />}</>; }
function CreditsModal({ onClose }: { onClose: () => void }) { const ref = useDialogFocus(onClose); return <div ref={ref as React.RefObject<HTMLDivElement>} className="credits-backdrop" role="dialog" aria-modal="true" aria-labelledby="credits-title" onClick={onClose}><section className="credits-modal" onClick={(event) => event.stopPropagation()}><header><h2 id="credits-title">Credits</h2><button onClick={onClose} aria-label="Close credits"><X size={21} /></button></header><div className="credits-list"><a href="https://openfreemap.org/" target="_blank" rel="noreferrer">Map tiles · OpenFreeMap<ArrowUpRight size={15} /></a><a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">Map style · © OpenMapTiles<ArrowUpRight size={15} /></a><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Map data · © OpenStreetMap contributors<ArrowUpRight size={15} /></a><div><strong>Published park boundaries and place details · BC Parks, Parks Canada, and regional authorities</strong><p>The exact official source is linked on every place card.</p></div></div></section></div>; }
function ResetConfirmation({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) { const ref = useDialogFocus(onCancel); const [error, setError] = useState(""); return <div ref={ref as React.RefObject<HTMLDivElement>} className="reset-backdrop" role="dialog" aria-modal="true" aria-labelledby="reset-title" onClick={onCancel}><section className="reset-dialog" onClick={(event) => event.stopPropagation()}><div className="reset-icon"><Trash2 size={24} /></div><h2 id="reset-title">Reset all progress?</h2><p>This removes every visited place, completed trail, and earned badge from your account. This cannot be undone.</p>{error && <p className="reset-error" role="alert">{error}</p>}<div><button disabled={busy} onClick={onCancel}>Keep my progress</button><button disabled={busy} onClick={() => { setError(""); void onConfirm().catch((caught) => setError(caught instanceof Error ? caught.message : "Could not reset progress.")); }}>{busy ? "Resetting…" : "Reset everything"}</button></div></section></div>; }
function AccountShelf({ title, count, items, onSeeAll, onSelect }: { title: string; count: number; items: ShelfItem[]; onSeeAll: () => void; onSelect: (item: ShelfItem) => void }) { return <section className="account-shelf"><header><h3>{title}</h3><span>{count}</span></header>{items.length ? <div className="shelf-row">{items.map((item) => <button key={item.id} onClick={() => onSelect(item)} aria-label={`Open ${item.name}`}>{item.image ? <Image src={item.image} alt="" width={54} height={54} /> : <span><MapPin size={20} /></span>}<strong>{item.name}</strong><time dateTime={item.date}>{formatDate(item.date)}</time></button>)}</div> : <p className="shelf-empty">Your first {title.toLowerCase()} will appear here.</p>}<button onClick={onSeeAll} disabled={!count}>See all</button></section>; }
function CollectionModal({ title, items, onClose, onSelect }: { title: string; items: ShelfItem[]; onClose: () => void; onSelect: (item: ShelfItem) => void }) { const ref = useDialogFocus(onClose); return <div ref={ref as React.RefObject<HTMLDivElement>} className="collection-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="collection-modal-title" onClick={onClose}><section className="collection-modal" onClick={(event) => event.stopPropagation()}><header><h2 id="collection-modal-title">{title}</h2><button className="collection-modal-close" onClick={onClose} aria-label={`Close ${title}`}><X size={21} /></button></header><div>{items.map((item) => <button className="collection-modal-row" key={item.id} onClick={() => onSelect(item)} aria-label={`Open ${item.name}`}>{item.image ? <Image src={item.image} alt="" width={48} height={48} /> : <span><MapPin size={20} /></span>}<div><strong>{item.name}</strong><time dateTime={item.date}>{formatDate(item.date)}</time></div><ArrowUpRight size={17} /></button>)}</div></section></div>; }
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
function BadgeCelebration({ badge, onClaim }: { badge: Achievement; onClaim: () => void }) { const ref = useDialogFocus(), image = imageMap[badge.species]; return <div ref={ref as React.RefObject<HTMLDivElement>} className="celebration" role="dialog" aria-modal="true" aria-labelledby="celebration-title"><div className="confetti" aria-hidden="true">{confetti.map((piece, index) => <i key={`${piece.kind}-${index}`} data-confetti-kind={piece.kind} style={{ "--x": `${piece.x}%`, "--delay": `${piece.delay}s`, "--duration": `${piece.duration}s`, "--size": `${piece.size}px`, "--drift": `${piece.drift}px`, "--turn": `${piece.turn}deg` } as CSSProperties}><ConfettiIcon kind={piece.kind} /></i>)}</div><div className="celebration-copy"><p>New discovery!</p><div className="celebration-badge">{image ? <Image src={image.src} alt="" width={190} height={190} priority /> : <Award size={90} />}</div><h2 id="celebration-title">{badge.name}</h2><p>{badge.description}</p><button onClick={onClaim}><Check size={21} />Claim my badge</button></div></div>; }
