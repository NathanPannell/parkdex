"use client";

import { ArrowUpRight, Award, Check, ChevronDown, Compass, Info, LandPlot, ListFilter, LocateFixed, LogIn, LogOut, Map as MapIcon, MapPin, RotateCcw, Search, Trees, UserRound, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useMemo, useState } from "react";
import { ParkMap } from "@/components/park-map";
import type { Account } from "@/lib/account";
import { achievements, TRAILS } from "@/lib/achievements";
import badgeImages from "@/lib/badge-images.json";
import type { BoundaryLoadState } from "@/lib/boundaries";
import { authorityForPlace, collectionFilter, groupByAuthority, type VisitFilter } from "@/lib/collection";
import { formatDistance, modeForSelection, nearestUnseenParks, type Coordinates } from "@/lib/discovery";
import { categoryLabels, type Place, type PlaceCategory } from "@/lib/places";
import { useFieldJournal } from "@/lib/use-field-journal";

const categories = Object.keys(categoryLabels) as PlaceCategory[];
type View = "map" | "collection" | "badges" | "account";
type BadgeImage = { src: string; alt: string; creator: string; license: string; licenseUrl: string; sourceUrl: string; species: string };
const imageMap = badgeImages as Record<string, BadgeImage>;

export function EveryParkApp({ apiBaseUrl }: { apiBaseUrl: string }) {
  const journal = useFieldJournal({ apiBaseUrl });
  const { places, visited, completedTrails, coverageNote, account, authenticated, loading, loadError, syncMessage, storageUnavailable, guestProgressAvailable, transitionBusy, toggleVisit, toggleTrail, retrySync, authenticate: completeAuth, logout: signOut, importGuest } = journal;
  const [selectedId, setSelectedId] = useState<string | null>(null); const [search, setSearch] = useState("");
  const [activeCategories, setActiveCategories] = useState<Set<PlaceCategory>>(new Set()); const [activeAuthorities, setActiveAuthorities] = useState<Set<string>>(new Set());
  const [visitFilter, setVisitFilter] = useState<VisitFilter>("all"); const [view, setView] = useState<View>("map"); const [mapMode, setMapMode] = useState<"explored" | "discover">("explored");
  const [location, setLocation] = useState<(Coordinates & { accuracyMeters?: number | null; heading?: number | null }) | null>(null); const [locationStatus, setLocationStatus] = useState<"idle" | "locating" | "ready" | "denied" | "unavailable">("idle");
  const [showFilters, setShowFilters] = useState(false);
  const [boundaryLoadState, setBoundaryLoadState] = useState<BoundaryLoadState>({ status: "loading", placeIds: new Set() });

  const authorities = useMemo(() => [...new Set(places.map(authorityForPlace))].sort(), [places]);
  const filtered = useMemo(() => collectionFilter(places, search, activeCategories, activeAuthorities, visitFilter, visited), [places, search, activeCategories, activeAuthorities, visitFilter, visited]);
  const groups = useMemo(() => groupByAuthority(filtered), [filtered]);
  const badgeList = useMemo(() => achievements({ places, visited, completedTrails }), [places, visited, completedTrails]);
  const earnedBadges = badgeList.filter((badge) => badge.earned).length;
  const selected = places.find((place) => place.id === selectedId) ?? null;
  const progress = places.length ? Math.round((visited.size / places.length) * 100) : 0;
  const nearby = useMemo(() => location ? nearestUnseenParks(places, visited, location) : [], [location, places, visited]);
  function requestLocation() {
    if (!navigator.geolocation) { setLocationStatus("unavailable"); return; }
    setLocationStatus("locating"); setMapMode("discover"); setView("map");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { setLocation({ latitude: coords.latitude, longitude: coords.longitude, accuracyMeters: coords.accuracy, heading: coords.heading }); setLocationStatus("ready"); },
      (error) => setLocationStatus(error.code === error.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  }
  function resetFilters() { setSearch(""); setActiveCategories(new Set()); setActiveAuthorities(new Set()); setVisitFilter("all"); }
  function toggleSet<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }
  const choosePlace = useCallback((id: string) => {
    setMapMode((current) => modeForSelection(current, visited, id));
    setSelectedId(id);
    setView("map");
  }, [visited]);
  return <main className="app-shell"><section className={`map-stage view-${view}`} aria-label="Park explorer">
    <ParkMap places={mapMode === "explored" ? places : filtered} visited={visited} selectedId={selectedId} onSelect={choosePlace} onBoundaryLoadState={setBoundaryLoadState} mode={mapMode} currentLocation={location} />
    <header className="expedition-header"><div className="brand-mark"><Trees size={22} /></div><div className="brand-copy"><h1>Every Park</h1><p>Vancouver Island field guide</p></div><div className="progress-badge" aria-label={`${visited.size} of ${places.length} places visited`}><strong>{visited.size}</strong><span>/{places.length || "—"}</span></div><div className="progress-track"><span style={{ transform: `scaleX(${progress / 100})` }} /></div></header>
    {view === "map" && <>
      <div className="map-mode-switch">
        <button className={mapMode === "explored" ? "active" : ""} onClick={() => setMapMode("explored")}><Trees size={16} />My map</button>
        <button className={mapMode === "discover" ? "active" : ""} onClick={() => setMapMode("discover")}><Compass size={16} />Find places</button>
        <button className="locate-button" onClick={requestLocation} aria-label="Show my current location"><LocateFixed size={17} className={locationStatus === "locating" ? "spin" : ""} /></button>
      </div>
      {mapMode === "explored" && visited.size === 0 && <div className="first-adventure"><strong>Your next adventure starts here.</strong><span>Find a place, then mark it visited to begin your map.</span><button onClick={() => setMapMode("discover")}><Compass size={17} />Find your first place</button></div>}
      {mapMode === "discover" && <div className="search-dock"><Search size={18} /><input aria-label="Search places" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a park or region" />{search && <button className="icon-button" onClick={() => setSearch("")} aria-label="Clear search"><X size={17} /></button>}<button className={`filter-button ${showFilters ? "active" : ""}`} onClick={() => setShowFilters((current) => !current)}><ListFilter size={17} /><span>Filter</span></button></div>}
      {mapMode === "discover" && locationStatus === "ready" && nearby.length > 0 && <section className="nearby-strip"><div><strong>Near you</strong><span>Straight-line distance</span></div>{nearby.map(({ place, distanceKm }) => <button key={place.id} onClick={() => choosePlace(place.id)}><span>{place.name}</span><b>{formatDistance(distanceKm)}</b></button>)}</section>}
      {locationStatus === "denied" && <p className="location-note">Location is blocked. Allow it in browser settings to see nearby parks.</p>}
      {locationStatus === "unavailable" && <p className="location-note">Your location is unavailable right now. Search the map instead.</p>}
    </>}
    {view !== "map" && <section className="feature-panel">{view === "collection" && <CollectionView groups={groups} places={places} visited={visited} search={search} setSearch={setSearch} selectedCategories={activeCategories} authorities={activeAuthorities} allAuthorities={authorities} visitFilter={visitFilter} setVisitFilter={setVisitFilter} toggleCategory={(value) => toggleSet(setActiveCategories, value)} toggleAuthority={(value) => toggleSet(setActiveAuthorities, value)} resetFilters={resetFilters} choosePlace={choosePlace} coverageNote={coverageNote} />}{view === "badges" && <BadgesView badges={badgeList} earned={earnedBadges} trails={completedTrails} toggleTrail={toggleTrail} disabled={transitionBusy} />}{view === "account" && <AccountView account={account} authenticated={authenticated} loading={loading} busy={transitionBusy} guestProgressAvailable={guestProgressAvailable} onAuth={completeAuth} onImport={importGuest} onLogout={signOut} visitedCount={visited.size} badgeCount={earnedBadges} />}</section>}
    {showFilters && view === "map" && <div className="filter-tray">{categories.map((category) => <button key={category} className={activeCategories.has(category) ? "selected" : ""} onClick={() => toggleSet(setActiveCategories, category)}>{categoryLabels[category]}</button>)}<button className="clear-filter" onClick={resetFilters}>Clear</button></div>}
    {loadError && <p className="connection-note">{loadError}</p>}{syncMessage && <p className="sync-note">{syncMessage}{syncMessage.includes("waiting") && <button onClick={() => void retrySync()}>Retry</button>}</p>}{storageUnavailable && <p className="storage-note">Private storage is blocked; guest progress lasts for this tab.</p>}
    {selected && <article className="place-sheet">
      <button className="sheet-close" onClick={() => setSelectedId(null)} aria-label="Close place details"><X size={18} /></button>
      <div className="place-category">{categoryLabels[selected.category]}</div>
      <h2>{selected.name}</h2>
      <p className="place-region"><MapPin size={15} />{selected.region} · {authorityForPlace(selected)}</p>
      {boundaryLoadState.status === "ready" && <p className={`boundary-note ${boundaryLoadState.placeIds.has(selected.id) ? "available" : ""}`}><LandPlot size={15} />{boundaryLoadState.placeIds.has(selected.id) ? "Published boundary · softened for display · not for navigation" : "No sourced boundary is available."}</p>}
      <p className="place-description">{selected.description}</p>
      <div className="sheet-actions">
        <button disabled={transitionBusy} className={`visit-button ${visited.has(selected.id) ? "is-visited" : ""}`} onClick={() => void toggleVisit(selected)}>{visited.has(selected.id) ? <><RotateCcw size={19} />Visited · undo</> : <><Check size={20} />Mark as visited</>}</button>
        <a className="source-link" href={selected.sourceUrl} target="_blank" rel="noreferrer">Source<ArrowUpRight size={16} /></a>
      </div>
    </article>}
    <nav className="thumb-nav"><Nav active={view === "map"} click={() => setView("map")} icon={<MapIcon size={20} />} label="Map" /><Nav active={view === "collection"} click={() => setView("collection")} icon={<Trees size={20} />} label="Places" count={visited.size} /><Nav active={view === "badges"} click={() => setView("badges")} icon={<Award size={20} />} label="Badges" count={earnedBadges} /><Nav active={view === "account"} click={() => setView("account")} icon={<UserRound size={20} />} label="Account" /></nav>
  </section></main>;
}

function Nav({ active, click, icon, label, count }: { active: boolean; click: () => void; icon: React.ReactNode; label: string; count?: number }) { return <button className={active ? "active" : ""} onClick={click}>{icon}<span>{label}</span>{count !== undefined && <b>{count}</b>}</button>; }

function CollectionView({ groups, places, visited, search, setSearch, selectedCategories, authorities, allAuthorities, visitFilter, setVisitFilter, toggleCategory, toggleAuthority, resetFilters, choosePlace, coverageNote }: { groups: ReturnType<typeof groupByAuthority>; places: Place[]; visited: Set<string>; search: string; setSearch: (v: string) => void; selectedCategories: Set<PlaceCategory>; authorities: Set<string>; allAuthorities: string[]; visitFilter: VisitFilter; setVisitFilter: (v: VisitFilter) => void; toggleCategory: (v: PlaceCategory) => void; toggleAuthority: (v: string) => void; resetFilters: () => void; choosePlace: (id: string) => void; coverageNote: string }) {
  const visibleCount = groups.reduce((count, group) => count + group.places.length, 0);
  return <>
    <div className="panel-heading">
      <div><h2>Your field guide</h2><p>{visibleCount} of {places.length} places</p></div>
      {coverageNote && <details><summary aria-label="About collection coverage"><Info size={18} /></summary><p>{coverageNote}</p></details>}
    </div>
    <div className="panel-search"><Search size={17} /><input aria-label="Search collection" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, region or authority" /></div>
    <div className="filter-block"><span>Show</span><div className="segmented">
      {(["all", "unseen", "visited"] as VisitFilter[]).map((value) => <button key={value} className={visitFilter === value ? "active" : ""} onClick={() => setVisitFilter(value)}>{value}</button>)}
    </div></div>
    <div className="chip-row">{categories.map((category) => <button key={category} className={selectedCategories.has(category) ? "active" : ""} onClick={() => toggleCategory(category)}>{categoryLabels[category]}</button>)}</div>
    <details className="authority-filter"><summary>Administrators <span>{authorities.size || "All"}</span></summary><div className="chip-row">
      {allAuthorities.map((authority) => <button key={authority} className={authorities.has(authority) ? "active" : ""} onClick={() => toggleAuthority(authority)}>{authority}</button>)}
    </div></details>
    {groups.length === 0 ? <div className="empty-state"><Compass size={30} /><strong>No places match.</strong><button onClick={resetFilters}>Clear filters</button></div> : <div className="authority-list">
      {groups.map((group) => <details key={group.authority} open={Boolean(search) || group.places.length <= 4}>
        <summary><span>{group.authority}</span><b>{group.places.filter((place) => visited.has(place.id)).length}/{group.places.length}</b><ChevronDown size={17} /></summary>
        <div>{group.places.map((place) => <button className="place-row" key={place.id} onClick={() => choosePlace(place.id)}>
          <span className={`specimen-number ${visited.has(place.id) ? "caught" : ""}`}>{visited.has(place.id) ? <Check size={16} /> : <MapPin size={15} />}</span>
          <span className="place-row-copy"><strong>{place.name}</strong><small>{categoryLabels[place.category]} · {place.region}</small></span>
        </button>)}</div>
      </details>)}
    </div>}
  </>;
}

function BadgesView({ badges, earned, trails, toggleTrail, disabled }: { badges: ReturnType<typeof achievements>; earned: number; trails: Set<string>; toggleTrail: (id: string) => Promise<void>; disabled: boolean }) {
  return <>
    <div className="panel-heading"><div><h2>Field medals</h2><p>{earned} of {badges.length} earned</p></div><Award size={28} /></div>
    <section className="trail-checks">
      <h3>Coastal trail log</h3>
      <p>Each trail is a separate completion. Finish both to earn the Banana Slug Medal.</p>
      {TRAILS.map((trail) => <div className="trail-row" key={trail.id}>
        <button disabled={disabled} className={trails.has(trail.id) ? "complete" : ""} onClick={() => void toggleTrail(trail.id)}>
          <span>{trails.has(trail.id) && <Check size={18} />}</span><strong>{trail.name}</strong><small>{trails.has(trail.id) ? "Completed · undo" : "Mark complete"}</small>
        </button>
        <a href={trail.id === "west_coast_trail" ? "https://www.parks.canada.ca/pn-np/bc/pacificrim/activ/sco-wct" : "https://bcparks.ca/juan-de-fuca-park/"} target="_blank" rel="noreferrer" aria-label={`${trail.name} official information`}><ArrowUpRight size={17} /></a>
      </div>)}
    </section>
    <div className="badge-grid">{badges.map((badge) => {
      const image = imageMap[badge.species];
      return <article key={badge.id} className={`achievement ${badge.earned ? "earned" : "locked"}`}>
        <div className={`badge-photo ${badge.species}`}>{image ? <Image src={image.src} alt={image.alt} width={90} height={90} /> : <Award size={28} />}</div>
        <div><h3>{badge.name}</h3><p>{badge.description}</p><div className="badge-progress"><span style={{ width: `${badge.current / badge.target * 100}%` }} /></div><strong>{badge.earned ? "Earned" : `${badge.current} / ${badge.target}`}</strong>
          {image && <details className="image-credit"><summary>Cropped photo credit</summary><p><a href={image.sourceUrl} target="_blank" rel="noreferrer">{image.creator}</a> · <a href={image.licenseUrl} target="_blank" rel="noreferrer">{image.license}</a></p></details>}
        </div>
      </article>;
    })}</div>
  </>;
}

function AccountView({ account, authenticated, loading, busy, guestProgressAvailable, onAuth, onImport, onLogout, visitedCount, badgeCount }: { account: Account | null; authenticated: boolean; loading: boolean; busy: boolean; guestProgressAvailable: boolean; onAuth: (m: "login" | "register", e: string, p: string) => Promise<void>; onImport: () => Promise<void>; onLogout: () => Promise<void>; visitedCount: number; badgeCount: number }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormBusy(true);
    setError("");
    try { await onAuth(mode, email, password); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not continue."); }
    finally { setFormBusy(false); }
  }
  if (loading) return <div className="account-card"><p>Checking your field journal…</p></div>;
  if (authenticated) return <>
    <div className="panel-heading"><div><h2>Your account</h2><p>{account?.email ?? "Signed in · account details will refresh online"}</p></div><UserRound size={28} /></div>
    <div className="account-stats"><div><strong>{visitedCount}</strong><span>Places visited</span></div><div><strong>{badgeCount}</strong><span>Badges earned</span></div></div>
    {guestProgressAvailable && <div className="import-card"><strong>Guest progress found on this device</strong><p>Add it to this account? This optional step keeps shared-device collections separate.</p><button disabled={busy} onClick={() => void onImport()}>{busy ? "Working…" : "Add guest progress"}</button></div>}
    <button disabled={busy} className="secondary-action" onClick={() => void onLogout()}><LogOut size={18} />{busy ? "Signing out…" : "Sign out"}</button>
  </>;
  return <>
    <div className="panel-heading"><div><h2>Keep your field journal</h2><p>Save visits, trail completions and badges to your account.</p></div><LogIn size={28} /></div>
    <div className="auth-switch"><button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create account</button><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Log in</button></div>
    <form className="auth-form" onSubmit={submit}>
      <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Password<input type="password" minLength={8} maxLength={128} autoComplete={mode === "register" ? "new-password" : "current-password"} required value={password} onChange={(event) => setPassword(event.target.value)} /><small>8–128 characters</small></label>
      {error && <p role="alert">{error}</p>}
      <button disabled={formBusy || busy}>{formBusy || busy ? "Saving…" : mode === "register" ? "Create account" : "Log in"}</button>
    </form>
  </>;
}
