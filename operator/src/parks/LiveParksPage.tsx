import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { navigate } from "../router";
import { Icon, Notice, PageHeader } from "../ui";
import { ParkMap } from "./ParkMap";
import type { LivePark } from "./types";

/** Every park players can see today. Pick one on the list or the map to edit it. */
export function LiveParksPage() {
  const [parks, setParks] = useState<LivePark[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState("");
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<{ parks: LivePark[] }>("/api/parks", { signal: controller.signal })
      .then((result) => setParks(result.parks))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load the live parks.")); });
    return () => controller.abort();
  }, []);

  const regions = useMemo(() => [...new Set((parks ?? []).map((park) => park.region).filter(Boolean))].sort(), [parks]);
  const list = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (parks ?? []).filter((park) => (!region || park.region === region) && (!text || `${park.name} ${park.short} ${park.id}`.toLowerCase().includes(text)));
  }, [parks, query, region]);

  const open = (id: string) => navigate(`/parks/${encodeURIComponent(id)}`);

  return (
    <section className="page page--wide" aria-labelledby="live-title">
      <PageHeader
        id="live-title"
        eyebrow="In players' apps"
        title="Parks"
        lede="Open a park to fix its name, description, rarity, pin or boundary. Saved changes reach phones on their next content sync."
      />

      <div className="parks-coming" role="note">
        <Icon name="clock" size={16} />
        <span><strong>Coming next:</strong> a map-first park manager with hide and delete, founders, cover photos and visit counts, OpenStreetMap layers and "Create from OSM".</span>
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="picker">
        <aside className="picker__list">
          <div className="picker__filters">
            <label className="search">
              <Icon name="search" size={17} />
              <input type="search" placeholder="Search live parks" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search live parks" />
            </label>
            <select value={region} onChange={(event) => setRegion(event.target.value)} aria-label="Filter by region">
              <option value="">All regions</option>
              {regions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <p className="muted result-count">{parks ? `${list.length} of ${parks.length} live parks` : "Loading live parks..."}</p>
          <div className="picker__rows">
            {!parks && !error && [0, 1, 2, 3].map((key) => <div key={key} className="picker-row picker-row--skeleton" aria-hidden="true" />)}
            {list.map((park) => (
              <button key={park.id} type="button" className={`picker-row${park.id === hoverId ? " is-on" : ""}`} onClick={() => open(park.id)}
                onMouseEnter={() => setHoverId(park.id)} onMouseLeave={() => setHoverId(null)}>
                <span className={`cat-dot cat-dot--${park.category}`} aria-hidden="true" />
                <span className="picker-row__main">
                  <strong>{park.name}</strong>
                  <span className="muted">{[park.region, park.category, park.biome].filter(Boolean).join(" · ")}</span>
                </span>
                <span className={`rarity rarity--${park.rarity}`}>{park.rarity}</span>
              </button>
            ))}
          </div>
        </aside>
        <div className="picker__map">
          <ParkMap
            points={list.map((park) => ({ id: park.id, name: park.name, lng: park.lng, lat: park.lat, status: "live" }))}
            selectedPointId={hoverId}
            onPointClick={open}
            basemap="streets"
            fitKey={parks ? "loaded" : "loading"}
          />
          <div className="map-key"><span><span className="legend-dot legend-dot--live" /> Live park. Click to edit.</span></div>
        </div>
      </div>
    </section>
  );
}
