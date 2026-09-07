"use client";

import { ArrowUpRight, Check, Compass, Info, LandPlot, Layers3, ListFilter, Map as MapIcon, MapPin, RotateCcw, Search, Trees, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ParkMap } from "@/components/park-map";
import type { BoundaryLoadState } from "@/lib/boundaries";
import { categoryLabels, createCollectionKey, filterPlaces, type Place, type PlaceCategory } from "@/lib/places";
import { VisitOutbox, type PendingVisit } from "@/lib/visit-outbox";

const STORAGE = { key: "every-park:collection-key:v1", places: "every-park:places:v1", visited: "every-park:visited:v1", pending: "every-park:pending:v1" };
const categories = Object.keys(categoryLabels) as PlaceCategory[];
type ApiPayload = { places: Place[]; visitedIds: string[]; coverageNote: string };

function readJson<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
}

function storeJson(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function countCategory(places: Place[], visited: Set<string>, category: PlaceCategory) {
  const group = places.filter((place) => place.category === category);
  return `${group.filter((place) => visited.has(place.id)).length}/${group.length}`;
}

export function EveryParkApp({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const [collectionKey, setCollectionKey] = useState("");
  const [coverageNote, setCoverageNote] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeCategories, setActiveCategories] = useState<Set<PlaceCategory>>(new Set());
  const [view, setView] = useState<"map" | "collection">("map");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [boundaryLoadState, setBoundaryLoadState] = useState<BoundaryLoadState>({ status: "loading", placeIds: new Set() });
  const outboxRef = useRef(new VisitOutbox());
  const visitedRef = useRef(visited);

  useEffect(() => { visitedRef.current = visited; }, [visited]);

  const filtered = useMemo(() => filterPlaces(places, search, activeCategories), [places, search, activeCategories]);
  const selected = places.find((place) => place.id === selectedId) ?? null;
  const progress = places.length ? Math.round((visited.size / places.length) * 100) : 0;

  const syncVisit = useCallback(async (id: string, nextVisited: boolean, key: string) => {
    if (!apiBaseUrl) throw new Error("Sync is unavailable in this build");
    const response = await fetch(`${apiBaseUrl}/api/visits/${encodeURIComponent(id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json", "X-Collection-Key": key }, body: JSON.stringify({ visited: nextVisited }),
    });
    if (!response.ok) throw new Error("Could not sync this checkoff");
  }, [apiBaseUrl]);

  const persistOutbox = useCallback(() => {
    if (!storeJson(STORAGE.pending, outboxRef.current.snapshot())) setStorageUnavailable(true);
  }, []);

  const drainOne = useCallback(async (id: string, key: string) => {
    try {
      await outboxRef.current.drain(id, (placeId, isVisited) => syncVisit(placeId, isVisited, key));
      persistOutbox();
      if (!outboxRef.current.hasPending()) setSyncMessage("");
    } catch {
      persistOutbox();
      setSyncMessage("Your latest checkoff is waiting to sync.");
    }
  }, [persistOutbox, syncVisit]);

  const retrySync = useCallback(async () => {
    if (!collectionKey) return;
    setSyncMessage("Syncing your latest checkoffs…");
    try {
      await outboxRef.current.drainAll((id, isVisited) => syncVisit(id, isVisited, collectionKey));
      persistOutbox();
      setSyncMessage("");
    } catch {
      persistOutbox();
      setSyncMessage("Your latest checkoff is waiting to sync.");
    }
  }, [collectionKey, persistOutbox, syncVisit]);

  useEffect(() => {
    const start = window.setTimeout(() => {
    const cachedPlaces = readJson<Place[]>(STORAGE.places, []);
    const cachedVisited = new Set(readJson<string[]>(STORAGE.visited, []));
    if (cachedPlaces.length) setPlaces(cachedPlaces);
    setVisited(cachedVisited);
    outboxRef.current.hydrate(readJson<Record<string, PendingVisit | boolean>>(STORAGE.pending, {}));
    let key: string | null = null;
    try { key = localStorage.getItem(STORAGE.key); } catch { setStorageUnavailable(true); }
    if (!key) {
      key = createCollectionKey();
      try { localStorage.setItem(STORAGE.key, key); } catch { setStorageUnavailable(true); }
    }
    setCollectionKey(key);

    const load = async () => {
      const requestStartedAt = outboxRef.current.checkpoint();
      if (!apiBaseUrl) {
        setLoadError(cachedPlaces.length ? "Showing your saved field guide offline." : "The field guide API is not configured.");
        setLoading(false); return;
      }
      try {
        const response = await fetch(`${apiBaseUrl}/api/places`, { cache: "no-store", headers: { "X-Collection-Key": key } });
        if (!response.ok) throw new Error("Could not load the field guide");
        const payload = await response.json() as ApiPayload;
        // Rebase the server snapshot onto the latest local intent after the
        // request completes, including taps made while it was in flight.
        const reconciled = outboxRef.current.applyTo(payload.visitedIds, requestStartedAt);
        setPlaces(payload.places); setVisited(reconciled); setCoverageNote(payload.coverageNote);
        visitedRef.current = reconciled;
        if (!storeJson(STORAGE.places, payload.places) || !storeJson(STORAGE.visited, [...reconciled])) setStorageUnavailable(true);
        setLoadError("");
        try {
          await outboxRef.current.drainAll((id, isVisited) => syncVisit(id, isVisited, key));
          persistOutbox();
        } catch {
          persistOutbox();
          setSyncMessage("Your latest checkoff is waiting to sync.");
        }
      } catch (error) {
        setLoadError(cachedPlaces.length ? "Showing your saved field guide offline." : error instanceof Error ? error.message : "Could not load the field guide");
      } finally { setLoading(false); }
    };
    void load();
    }, 0);
    return () => window.clearTimeout(start);
  }, [apiBaseUrl, persistOutbox, syncVisit]);

  useEffect(() => {
    const resume = () => { void retrySync(); };
    window.addEventListener("online", resume);
    return () => window.removeEventListener("online", resume);
  }, [retrySync]);

  const toggleVisit = useCallback(async (place: Place) => {
    if (!collectionKey) return;
    const nextVisited = !visitedRef.current.has(place.id);
    const next = new Set(visitedRef.current);
    if (nextVisited) next.add(place.id); else next.delete(place.id);
    visitedRef.current = next; setVisited(next);
    if (!storeJson(STORAGE.visited, [...next])) setStorageUnavailable(true);
    outboxRef.current.setDesired(place.id, nextVisited); persistOutbox(); setSyncMessage("");
    await drainOne(place.id, collectionKey);
  }, [collectionKey, drainOne, persistOutbox]);

  function toggleCategory(category: PlaceCategory) {
    setActiveCategories((current) => { const next = new Set(current); if (next.has(category)) next.delete(category); else next.add(category); return next; });
  }
  const choosePlace = useCallback((id: string) => { setSelectedId(id); setView("map"); }, []);

  return <main className="app-shell">
    <section className="map-stage" aria-label="Park explorer">
      <ParkMap places={filtered} visited={visited} selectedId={selectedId} onSelect={choosePlace} onBoundaryLoadState={setBoundaryLoadState} />
      <header className="expedition-header">
        <div className="brand-mark" aria-hidden="true"><Trees size={22} strokeWidth={2.6} /></div>
        <div className="brand-copy"><h1>Every Park</h1><p>Vancouver Island field guide</p></div>
        <div className="progress-badge" aria-label={`${visited.size} of ${places.length} places visited`}><strong>{visited.size}</strong><span>/{places.length || "—"}</span></div>
        <div className="progress-track" aria-hidden="true"><span style={{ transform: `scaleX(${progress / 100})` }} /></div>
      </header>

      <div className="search-dock">
        <Search size={18} aria-hidden="true" /><label className="sr-only" htmlFor="place-search">Search the field guide</label>
        <input id="place-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a park or region" />
        {search && <button className="icon-button" onClick={() => setSearch("")} aria-label="Clear search"><X size={17} /></button>}
        <button className={`filter-button ${showFilters || activeCategories.size ? "active" : ""}`} onClick={() => setShowFilters((current) => !current)} aria-expanded={showFilters}>
          <ListFilter size={17} /><span>Filter</span>{activeCategories.size > 0 && <b>{activeCategories.size}</b>}
        </button>
      </div>

      {showFilters && <div className="filter-tray">
        {categories.map((category) => <button key={category} className={activeCategories.has(category) ? "selected" : ""} onClick={() => toggleCategory(category)} aria-pressed={activeCategories.has(category)}><span>{categoryLabels[category]}</span><small>{countCategory(places, visited, category)}</small></button>)}
        {activeCategories.size > 0 && <button className="clear-filter" onClick={() => setActiveCategories(new Set())}>Clear</button>}
      </div>}
      {loadError && <p className="connection-note" role="status">{loadError}</p>}
      {syncMessage && <p className="sync-note" role="status">{syncMessage}<button onClick={() => void retrySync()}>Retry</button></p>}
      {storageUnavailable && <p className="storage-note" role="status">Private storage is blocked; progress lasts for this tab.</p>}

      <section className={`collection-drawer ${view === "collection" ? "open" : ""}`} aria-label="Place collection">
        <div className="drawer-handle" aria-hidden="true" />
        <div className="drawer-heading"><div><h2>Your field guide</h2><p>{filtered.length} places in view</p></div>
          {coverageNote && <details><summary aria-label="About dataset coverage"><Info size={18} /></summary><div className="coverage-popover"><p>{coverageNote}</p><nav aria-label="Official dataset sources"><a href="https://parks.canada.ca/pn-np/recherche-parcs-parks-search" target="_blank" rel="noreferrer">Parks Canada</a><a href="https://catalogue.data.gov.bc.ca/dataset/parks-ecological-reserves-and-protected-areas" target="_blank" rel="noreferrer">DataBC</a><a href="https://rdn.bc.ca/spatial-data-files" target="_blank" rel="noreferrer">Regional sources</a><a href="https://apps.gov.bc.ca/pub/bcgnws/web/" target="_blank" rel="noreferrer">BC Names</a></nav></div></details>}
        </div>
        {loading && places.length === 0 ? <div className="loading-list" aria-label="Loading places"><i /><i /><i /></div>
          : filtered.length === 0 ? <div className="empty-state"><Compass size={30} /><strong>No places match this trail.</strong><span>Clear a filter or try another name.</span><button onClick={() => { setSearch(""); setActiveCategories(new Set()); }}>Show every place</button></div>
          : <div className="place-list">{filtered.map((place, index) => <button className="place-row" key={place.id} onClick={() => choosePlace(place.id)}>
              <span className={`specimen-number ${visited.has(place.id) ? "caught" : ""}`}>{visited.has(place.id) ? <Check size={16} /> : String(index + 1).padStart(2, "0")}</span>
              <span className="place-row-copy"><strong>{place.name}</strong><small>{categoryLabels[place.category]} · {place.region}</small></span><MapPin size={18} aria-hidden="true" />
            </button>)}</div>}
      </section>

      {selected && <article className="place-sheet" aria-live="polite">
        <button className="sheet-close" onClick={() => setSelectedId(null)} aria-label="Close place details"><X size={18} /></button>
        <div className="place-category"><Layers3 size={15} />{categoryLabels[selected.category]}</div>
        <h2>{selected.name}</h2><p className="place-region"><MapPin size={15} />{selected.region}</p>
        {boundaryLoadState.status === "ready" && boundaryLoadState.placeIds.has(selected.id) && <p className="boundary-note available"><LandPlot size={15} />Published boundary shown · not for navigation</p>}
        {boundaryLoadState.status === "ready" && !boundaryLoadState.placeIds.has(selected.id) && <p className="boundary-note"><LandPlot size={15} />No sourced boundary is available for this place.</p>}
        {boundaryLoadState.status === "failed" && <p className="boundary-note"><LandPlot size={15} />Boundary layer unavailable. The place marker still works.</p>}
        <p className="place-description">{selected.description}</p>
        <div className="sheet-actions"><button className={`visit-button ${visited.has(selected.id) ? "is-visited" : ""}`} onClick={() => void toggleVisit(selected)} aria-pressed={visited.has(selected.id)}>
          <span className="burst" aria-hidden="true"><i /><i /><i /><i /></span>{visited.has(selected.id) ? <><span className="collection-stamp" aria-hidden="true">Collected!</span><RotateCcw size={19} />Visited · undo</> : <><Check size={20} />Mark as visited</>}
        </button><a className="source-link" href={selected.sourceUrl} target="_blank" rel="noreferrer">{selected.sourceName}<ArrowUpRight size={16} /></a></div>
      </article>}

      <nav className="thumb-nav" aria-label="Primary views">
        <button className={view === "map" ? "active" : ""} onClick={() => setView("map")}><MapIcon size={21} /><span>Map</span></button>
        <button className={view === "collection" ? "active" : ""} onClick={() => setView("collection")}><Trees size={21} /><span>Collection</span><b>{visited.size}</b></button>
      </nav>
    </section>
  </main>;
}
