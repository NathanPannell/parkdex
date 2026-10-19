import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../api";
import { navigate } from "../router";
import { useDashboard } from "../shell/DashboardContext";
import { EmptyState, formatCount, Icon, Notice, PageHeader } from "../ui";
import { ParksTabs } from "./ReviewPage";
import { ManagerMap, OSM_ZOOM, OUTLINE_ZOOM, type Layers, type OsmState, type View } from "./ManagerMap";
import type { Basemap } from "./ParkMap";
import { CATEGORIES, osmKey, SOURCE_LABELS, title, type OsmOutline, type ParkRow, type ParkSource, type ParkStats } from "./types";

/**
 * /parks: every park in the database the toggle chose, on a list and a map. The list filters
 * and sorts; the map shows the same parks plus optional layers. Open a park to edit or moderate
 * it, or pick an OpenStreetMap outline that is not in Parkdex to create it.
 */

type Filters = {
  q: string;
  category: string;
  region: string;
  status: "all" | "live" | "hidden";
  founder: "any" | "yes" | "no";
  source: "all" | ParkSource;
  sort: "name" | "visits";
};

type Saved = { filters: Filters; layers: Layers; basemap: Basemap; view: View | null };

const DEFAULTS: Saved = {
  filters: { q: "", category: "", region: "", status: "all", founder: "any", source: "all", sort: "name" },
  layers: { outlines: true, hidden: true, founded: true, osm: false, osmMissingOnly: false },
  basemap: "streets",
  view: null,
};

// Kept per tab, so coming back from a park keeps the view, filters and layers.
const STORAGE_KEY = "parkdex.operator.parks";
function loadSaved(): Saved {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Saved> | null;
    if (!saved) return DEFAULTS;
    return {
      filters: { ...DEFAULTS.filters, ...saved.filters },
      layers: { ...DEFAULTS.layers, ...saved.layers },
      basemap: saved.basemap ?? DEFAULTS.basemap,
      view: saved.view ?? null,
    };
  } catch {
    return DEFAULTS;
  }
}

type Dimension = "category" | "region" | "status" | "founder" | "source";

function matches(park: ParkRow, filters: Filters, skip?: Dimension): boolean {
  const text = filters.q.trim().toLowerCase();
  if (text && !`${park.name} ${park.short} ${park.id}`.toLowerCase().includes(text)) return false;
  if (skip !== "category" && filters.category && park.category !== filters.category) return false;
  if (skip !== "region" && filters.region && park.region !== filters.region) return false;
  if (skip !== "status" && filters.status !== "all" && (filters.status === "hidden") !== Boolean(park.hidden)) return false;
  if (skip !== "founder" && filters.founder !== "any" && (filters.founder === "yes") !== Boolean(park.founder)) return false;
  if (skip !== "source" && filters.source !== "all" && park.source !== filters.source) return false;
  return true;
}

function valueOf(park: ParkRow, dimension: Dimension): string {
  if (dimension === "status") return park.hidden ? "hidden" : "live";
  if (dimension === "founder") return park.founder ? "yes" : "no";
  return park[dimension];
}

/** How many parks each option would show, given every other filter: the counts beside each choice. */
function facet(rows: ParkRow[], filters: Filters, dimension: Dimension): Map<string, number> {
  const counts = new Map<string, number>();
  let all = 0;
  for (const park of rows) {
    if (!matches(park, filters, dimension)) continue;
    all += 1;
    const value = valueOf(park, dimension);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  counts.set("", all);
  return counts;
}

function area(m2: number): string {
  return m2 >= 1_000_000 ? `${(m2 / 1_000_000).toFixed(1)} km²` : `${(m2 / 10_000).toFixed(1)} ha`;
}

/** Rows render in pages as the list scrolls, so thousands of parks stay quick. */
const PAGE = 120;

export function ParkManager() {
  const { environment } = useDashboard();
  const saved = useMemo(loadSaved, []);
  const [rows, setRows] = useState<ParkRow[] | null>(null);
  const [stats, setStats] = useState<ParkStats | null>(null);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState<Filters>(saved.filters);
  const [layers, setLayers] = useState<Layers>(saved.layers);
  const [basemap, setBasemap] = useState<Basemap>(saved.basemap);
  const [view, setView] = useState<View | null>(saved.view);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const [osm, setOsm] = useState<OsmState>({ status: "off", outlines: [], truncated: false });
  const [panel, setPanel] = useState<"parks" | "osm">("parks");
  const [picked, setPicked] = useState<OsmOutline | null>(null);
  const [flyTo, setFlyTo] = useState<{ center: [number, number]; zoom: number; key: string } | null>(null);
  const [fitKey, setFitKey] = useState(saved.view ? "initial" : "first");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<{ parks: ParkRow[] }>("/api/parks", { signal: controller.signal })
      .then((result) => setRows(result.parks))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorText(reason, "Could not load the parks."));
      });
    api<{ stats: ParkStats }>("/api/parks/stats", { signal: controller.signal })
      .then((result) => setStats(result.stats))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ filters, layers, basemap, view } satisfies Saved));
    } catch {
      // Private windows may refuse storage; the page works without it.
    }
  }, [filters, layers, basemap, view]);

  const regions = useMemo(() => [...new Set((rows ?? []).map((park) => park.region).filter(Boolean))].sort(), [rows]);
  const facets = useMemo(() => {
    const all = rows ?? [];
    return {
      category: facet(all, filters, "category"),
      region: facet(all, filters, "region"),
      status: facet(all, filters, "status"),
      founder: facet(all, filters, "founder"),
      source: facet(all, filters, "source"),
    };
  }, [rows, filters]);
  const filtered = useMemo(() => {
    const result = (rows ?? []).filter((park) => matches(park, filters));
    if (filters.sort === "visits") result.sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name));
    return result;
  }, [rows, filters]);
  const osmMissing = useMemo(() => osm.outlines.filter((outline) => !outline.inParkdex), [osm.outlines]);
  const listed = panel === "parks" ? filtered.length : osmMissing.length;

  useEffect(() => {
    setActive(0);
    setShown(PAGE);
    list.current?.scrollTo({ top: 0 });
  }, [filters, panel]);
  // Frame the results on first load, so the map starts on what the list shows.
  useEffect(() => {
    if (rows && fitKey === "first") setFitKey("loaded");
  }, [rows, fitKey]);

  useEffect(() => {
    const target = sentinel.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setShown((value) => value + PAGE);
      },
      { root: list.current, rootMargin: "200px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [rows, panel]);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((current) => ({ ...current, [key]: value }));
  const toggle = (key: keyof Layers) =>
    setLayers((current) => {
      const next = { ...current, [key]: !current[key] };
      if (key === "osmMissingOnly" && next.osmMissingOnly) next.osm = true;
      if (key === "osm" && !next.osm) next.osmMissingOnly = false;
      return next;
    });
  const open = (id: string) => navigate(`/parks/${encodeURIComponent(id)}`);
  const onOsm = useCallback((state: OsmState) => setOsm(state), []);
  const onView = useCallback((next: View) => setView(next), []);

  function showOsmMissing() {
    setLayers((current) => ({ ...current, osm: true, osmMissingOnly: true }));
    setPanel("osm");
    if ((view?.zoom ?? 0) < OSM_ZOOM) setFlyTo({ center: view?.center ?? [-123.37, 48.45], zoom: 12.5, key: `osm-${Date.now()}` });
  }

  function pickOsm(outline: OsmOutline) {
    setPicked(outline);
    const ring = outline.geometry.coordinates[0][0];
    const lngs = ring.map((position) => position[0]),
      lats = ring.map((position) => position[1]);
    const center: [number, number] = [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
    setFlyTo({ center, zoom: Math.max(view?.zoom ?? 13, 13), key: `pick-${osmKey(outline)}` });
  }

  // Keyboard: "/" searches, arrows move through the list, Enter opens, Escape clears.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        search.current?.focus();
        return;
      }
      if (typing && target !== search.current) return;
      if (document.querySelector(".dialog-layer, .drawer-layer")) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => Math.max(0, Math.min(listed - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
      } else if (event.key === "Enter" && listed) {
        event.preventDefault();
        if (panel === "parks") open(filtered[active].id);
        else pickOsm(osmMissing[active]);
      } else if (event.key === "Escape" && target === search.current && filters.q) {
        set("q", "");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    if (panel === "parks") setHoverId(filtered[active]?.id ?? null);
  }, [active]);

  const statTiles: Array<{ key: string; label: string; value: number | undefined; hint: string; onClick(): void; on: boolean }> = [
    {
      key: "live",
      label: "Live",
      value: stats?.live,
      hint: "In players' apps",
      onClick: () => {
        setPanel("parks");
        set("status", filters.status === "live" ? "all" : "live");
      },
      on: filters.status === "live",
    },
    {
      key: "hidden",
      label: "Hidden",
      value: stats?.hidden,
      hint: "Kept, not shown",
      onClick: () => {
        setPanel("parks");
        set("status", filters.status === "hidden" ? "all" : "hidden");
      },
      on: filters.status === "hidden",
    },
    {
      key: "founded",
      label: "Founded",
      value: stats?.founded,
      hint: "With founder and cover",
      onClick: () => {
        setPanel("parks");
        set("founder", filters.founder === "yes" ? "any" : "yes");
      },
      on: filters.founder === "yes",
    },
    {
      key: "osm",
      label: "OSM outlines",
      value: stats?.osmOutlines,
      hint: stats?.osmSourceDate
        ? `Extract of ${new Date(stats.osmSourceDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
        : "kip_osm.parks",
      onClick: () => toggle("osm"),
      on: layers.osm && !layers.osmMissingOnly,
    },
    {
      key: "missing",
      label: "OSM not in Parkdex",
      value: stats?.osmNotInParkdex,
      hint: "Estimate: no park pin in its box",
      onClick: showOsmMissing,
      on: layers.osmMissingOnly,
    },
  ];

  const option = (counts: Map<string, number>, value: string, label: string) => (
    <option key={value} value={value}>
      {label} ({formatCount(counts.get(value) ?? 0)})
    </option>
  );

  const zoomNote = (view?.zoom ?? 0) < OUTLINE_ZOOM && layers.outlines ? "Zoom in to see park outlines." : "";
  const osmNote =
    osm.status === "zoom"
      ? "Zoom in further to load OpenStreetMap outlines."
      : osm.status === "loading"
        ? "Loading OpenStreetMap outlines..."
        : osm.status === "error"
          ? (osm.message ?? "Could not load OpenStreetMap outlines.")
          : osm.status === "ready" && osm.truncated
            ? `Showing the ${osm.outlines.length} smallest outlines in view. Zoom in for the rest.`
            : "";

  return (
    <section className="page page--wide pm" aria-labelledby="parks-title">
      <PageHeader
        id="parks-title"
        eyebrow={environment ? `${title(environment)} catalogue` : "Catalogue"}
        title="Parks"
        lede="Open a park to edit or moderate it. Switch on OpenStreetMap to find parks that are missing."
        actions={<ParksTabs current="/parks" />}
      />

      {error && <Notice tone="error">{error}</Notice>}

      <div className="pm-stats" role="group" aria-label="Catalogue totals">
        {statTiles.map((tile) => (
          <button
            key={tile.key}
            type="button"
            className={`pm-stat pm-stat--${tile.key}${tile.on ? " is-on" : ""}`}
            aria-pressed={tile.on}
            onClick={tile.onClick}
          >
            <span className="pm-stat__label">{tile.label}</span>
            <strong className={`pm-stat__value${tile.value === undefined ? " is-loading" : ""}`}>
              {tile.value === undefined ? " " : formatCount(tile.value)}
            </strong>
            <span className="pm-stat__hint">{tile.hint}</span>
          </button>
        ))}
      </div>

      <div className="pm-body">
        <aside className="pm-side" aria-label="Park list">
          <div className="pm-tabs" role="tablist" aria-label="List">
            <button type="button" role="tab" aria-selected={panel === "parks"} className={panel === "parks" ? "is-on" : ""} onClick={() => setPanel("parks")}>
              Parks <span className="pm-count">{rows ? formatCount(filtered.length) : "..."}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === "osm"}
              className={panel === "osm" ? "is-on" : ""}
              onClick={() => {
                setPanel("osm");
                if (!layers.osm) toggle("osm");
              }}
            >
              OSM not in Parkdex <span className="pm-count">{osm.status === "ready" ? formatCount(osmMissing.length) : "in view"}</span>
            </button>
          </div>

          {panel === "parks" ? (
            <div className="pm-filters">
              <label className="search pm-search">
                <Icon name="search" size={16} />
                <input
                  ref={search}
                  type="search"
                  placeholder="Search name or id"
                  value={filters.q}
                  onChange={(event) => set("q", event.target.value)}
                  aria-label="Search parks by name or id"
                />
                <kbd>/</kbd>
              </label>
              <div className="pm-filter-grid">
                <select className="select" value={filters.category} onChange={(event) => set("category", event.target.value)} aria-label="Category">
                  {option(facets.category, "", "All categories")}
                  {CATEGORIES.map((value) => option(facets.category, value, title(value)))}
                </select>
                <select className="select" value={filters.region} onChange={(event) => set("region", event.target.value)} aria-label="Region">
                  {option(facets.region, "", "All regions")}
                  {regions.map((value) => option(facets.region, value, value))}
                </select>
                <select
                  className="select"
                  value={filters.status}
                  onChange={(event) => set("status", event.target.value as Filters["status"])}
                  aria-label="Visibility"
                >
                  <option value="all">Live and hidden ({formatCount(facets.status.get("") ?? 0)})</option>
                  {option(facets.status, "live", "Live")}
                  {option(facets.status, "hidden", "Hidden")}
                </select>
                <select
                  className="select"
                  value={filters.founder}
                  onChange={(event) => set("founder", event.target.value as Filters["founder"])}
                  aria-label="Founder and cover"
                >
                  <option value="any">Any founder ({formatCount(facets.founder.get("") ?? 0)})</option>
                  {option(facets.founder, "yes", "Has founder and cover")}
                  {option(facets.founder, "no", "No founder")}
                </select>
                <select
                  className="select"
                  value={filters.source}
                  onChange={(event) => set("source", event.target.value as Filters["source"])}
                  aria-label="Source"
                >
                  <option value="all">All sources ({formatCount(facets.source.get("") ?? 0)})</option>
                  {(Object.keys(SOURCE_LABELS) as ParkSource[]).map((value) => option(facets.source, value, SOURCE_LABELS[value]))}
                </select>
                <select className="select" value={filters.sort} onChange={(event) => set("sort", event.target.value as Filters["sort"])} aria-label="Sort">
                  <option value="name">Sort by name</option>
                  <option value="visits">Sort by visits</option>
                </select>
              </div>
              <div className="pm-resultline">
                <span>{rows ? `${formatCount(filtered.length)} of ${formatCount(rows.length)} parks` : "Loading parks..."}</span>
                {JSON.stringify(filters) !== JSON.stringify({ ...DEFAULTS.filters, sort: filters.sort }) && (
                  <button type="button" className="text-button" onClick={() => setFilters({ ...DEFAULTS.filters, sort: filters.sort })}>
                    Clear filters
                  </button>
                )}
                <button type="button" className="text-button" disabled={!filtered.length} onClick={() => setFitKey(`fit-${Date.now()}`)}>
                  Fit map
                </button>
              </div>
            </div>
          ) : (
            <div className="pm-filters">
              <p className="pm-osm-help">
                OpenStreetMap park outlines in the current map view that are not in this catalogue, by the same rule founding uses. Pick one to create it.
              </p>
              <div className="pm-resultline">
                <span>
                  {osmNote ||
                    (osm.status === "ready"
                      ? `${formatCount(osmMissing.length)} of ${formatCount(osm.outlines.length)} outlines in view`
                      : "Switch the layer on to load outlines.")}
                </span>
              </div>
            </div>
          )}

          <div className="pm-list" ref={list} role="listbox" aria-label={panel === "parks" ? "Parks" : "OpenStreetMap outlines not in Parkdex"}>
            {panel === "parks" && !rows && !error && [0, 1, 2, 3, 4, 5].map((key) => <div key={key} className="pm-row pm-row--skeleton" aria-hidden="true" />)}
            {panel === "parks" && rows && !filtered.length && (
              <EmptyState
                compact
                title="No parks match"
                pose="think"
                action={
                  <button type="button" className="button button--small" onClick={() => setFilters({ ...DEFAULTS.filters, sort: filters.sort })}>
                    Clear filters
                  </button>
                }
              >
                <p className="muted">Try another search or fewer filters.</p>
              </EmptyState>
            )}
            {panel === "parks" &&
              filtered.slice(0, shown).map((park, index) => (
                <button
                  key={park.id}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  className={`pm-row${index === active ? " is-active" : ""}${park.id === hoverId ? " is-hover" : ""}${park.hidden ? " is-hidden" : ""}`}
                  onClick={() => open(park.id)}
                  onMouseEnter={() => setHoverId(park.id)}
                  onMouseLeave={() => setHoverId(null)}
                >
                  <span className={`cat-dot cat-dot--${park.category}`} aria-hidden="true" />
                  <span className="pm-row__main">
                    <strong>{park.name}</strong>
                    <span>{[park.region || "No region", SOURCE_LABELS[park.source]].join(" · ")}</span>
                  </span>
                  <span className="pm-row__tags">
                    {park.hidden && (
                      <span className="pm-tag pm-tag--hidden" title={`Hidden: ${park.hidden.reason}`}>
                        Hidden
                      </span>
                    )}
                    {park.founder && (
                      <span className="pm-tag pm-tag--founder" title={`Founded by @${park.founder.handle ?? "deleted"}`}>
                        <Icon name="flag" size={12} />
                      </span>
                    )}
                  </span>
                  <span className="pm-row__visits" title={`${park.visits} visits`}>
                    {formatCount(park.visits)}
                  </span>
                </button>
              ))}
            {panel === "parks" && filtered.length > shown && (
              <div ref={sentinel} className="pm-more">
                Loading more...
              </div>
            )}

            {panel === "osm" && osm.status === "ready" && !osmMissing.length && (
              <EmptyState compact title="Everything here is in Parkdex" pose="celebrate">
                <p className="muted">Move the map to look somewhere else.</p>
              </EmptyState>
            )}
            {panel === "osm" && (osm.status === "zoom" || osm.status === "off") && (
              <EmptyState
                compact
                title="Zoom in to look for parks"
                pose="map"
                action={
                  <button type="button" className="button button--small" onClick={showOsmMissing}>
                    Zoom to the map centre
                  </button>
                }
              >
                <p className="muted">OpenStreetMap outlines load for the area in view, from zoom {OSM_ZOOM}.</p>
              </EmptyState>
            )}
            {panel === "osm" &&
              osmMissing.map((outline, index) => (
                <button
                  key={osmKey(outline)}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  className={`pm-row pm-row--osm${index === active ? " is-active" : ""}${picked && osmKey(picked) === osmKey(outline) ? " is-hover" : ""}`}
                  onClick={() => pickOsm(outline)}
                >
                  <span className="osm-swatch" aria-hidden="true" />
                  <span className="pm-row__main">
                    <strong>{outline.name ?? "Unnamed outline"}</strong>
                    <span>
                      {outline.kind} · {area(outline.areaM2)}
                    </span>
                  </span>
                  <span className="pm-row__visits">
                    {outline.type[0]}
                    {outline.id}
                  </span>
                </button>
              ))}
          </div>
          <p className="pm-keys muted">
            <kbd>/</kbd> search <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>Enter</kbd> open
          </p>
        </aside>

        <div className="pm-mapframe">
          <ManagerMap
            parks={filtered}
            hoverId={hoverId}
            layers={layers}
            basemap={basemap}
            initialView={saved.view}
            flyTo={flyTo}
            fitKey={fitKey}
            onOpen={open}
            onHover={setHoverId}
            onOsmPick={pickOsm}
            onOsm={onOsm}
            onView={onView}
          />
          <div className="pm-layers" role="group" aria-label="Map layers">
            {(
              [
                ["outlines", "Outlines"],
                ["hidden", "Hidden parks"],
                ["founded", "Founded"],
                ["osm", "OSM outlines"],
                ["osmMissingOnly", "Only not in Parkdex"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`chip-toggle pm-layer pm-layer--${key}${layers[key] ? " is-on" : ""}`}
                aria-pressed={layers[key]}
                onClick={() => toggle(key)}
              >
                <span className="pm-layer__swatch" aria-hidden="true" />
                {label}
              </button>
            ))}
            <button
              type="button"
              className="chip-toggle is-on"
              onClick={() => setBasemap(basemap === "satellite" ? "streets" : "satellite")}
              title="Switch the base map"
            >
              <Icon name="layers" size={14} /> {basemap === "satellite" ? "Satellite" : "Map"}
            </button>
          </div>
          {(zoomNote || (layers.osm && osmNote)) && (
            <div className="pm-mapnote" role="status">
              {[zoomNote, layers.osm ? osmNote : ""].filter(Boolean).join(" ")}
            </div>
          )}
          <div className="pm-legend" aria-hidden="true">
            {CATEGORIES.map((category) => (
              <span key={category}>
                <span className={`cat-dot cat-dot--${category}`} />
                {title(category)}
              </span>
            ))}
            <span>
              <span className="legend-ring" />
              Founded
            </span>
            <span>
              <span className="cat-dot cat-dot--hidden" />
              Hidden
            </span>
            {layers.osm && (
              <span>
                <span className="osm-swatch" />
                Not in Parkdex
              </span>
            )}
          </div>
          {picked && (
            <div className="pm-pick" role="dialog" aria-label={`OpenStreetMap outline ${picked.name ?? "without a name"}`}>
              <div className="pm-pick__head">
                <div>
                  <p className="eyebrow">
                    OpenStreetMap {picked.type} {picked.id}
                  </p>
                  <h2>{picked.name ?? "Unnamed outline"}</h2>
                  <p className="muted">
                    {picked.kind} · {area(picked.areaM2)}
                  </p>
                </div>
                <button type="button" className="icon-button icon-button--small" aria-label="Close" onClick={() => setPicked(null)}>
                  <Icon name="close" size={15} />
                </button>
              </div>
              {picked.inParkdex ? (
                <div className="pm-pick__body">
                  <p>
                    Already in Parkdex as <strong>{picked.inParkdex.name}</strong>.
                  </p>
                  <button type="button" className="button button--small" onClick={() => open(picked.inParkdex!.parkId)}>
                    Open {picked.inParkdex.name}
                  </button>
                </div>
              ) : (
                <div className="pm-pick__body">
                  <p>Not in Parkdex. Create it with this outline, a category guess and the region nearby; you review every field before it publishes.</p>
                  <button type="button" className="button button--primary button--small" onClick={() => navigate(`/parks/osm/${osmKey(picked)}`)}>
                    <Icon name="plus" size={15} /> Create from OSM
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
