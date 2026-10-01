import { useEffect, useMemo, useState } from "react";
import { api, errorText, type Draft, type LegacyPark, type LegacySummary, type Position, type Proposal } from "../api";
import { ParkMap } from "../components/ParkMap";
import { navigate } from "../router";
import { Icon, Spinner, useToast } from "../ui";
import { ParksTabs } from "./ParksTabs";

const STATUS_LABEL: Record<LegacySummary["status"], string> = { available: "Available", draft: "Draft", "in-parkdex": "In Parkdex" };

function distanceKm([lng1, lat1]: Position, [lng2, lat2]: Position): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function proposalFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("proposal");
}

/**
 * Pick a legacy park on a map to start a draft. Opened from a proposal, the map centres on the
 * player's pin and sketch and lists the nearest legacy parks first; with no match, the draft
 * starts from the proposal itself.
 */
export function ImportPage() {
  const toast = useToast();
  const proposalId = proposalFromUrl();
  const [parks, setParks] = useState<LegacySummary[] | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<LegacyPark | null>(null);
  const [loadingPark, setLoadingPark] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fly, setFly] = useState<{ position: Position; zoom?: number; key: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<{ parks: LegacySummary[] }>("/api/legacy/parks", { signal: controller.signal })
      .then((result) => setParks(result.parks))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load the legacy map.")); });
    if (proposalId) {
      api<{ proposals: Proposal[] }>("/api/proposals?status=all", { signal: controller.signal })
        .then((result) => setProposal(result.proposals.find((item) => item.id === proposalId) ?? null))
        .catch(() => undefined);
    }
    return () => controller.abort();
  }, [proposalId]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    const controller = new AbortController();
    setLoadingPark(true);
    api<{ park: LegacyPark }>(`/api/legacy/parks/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then(({ park }) => setSelected(park))
      .catch((reason: unknown) => { if (!controller.signal.aborted) toast.show(errorText(reason, "Could not load that park."), { tone: "error" }); })
      .finally(() => { if (!controller.signal.aborted) setLoadingPark(false); });
    return () => controller.abort();
  }, [selectedId, toast]);

  const list = useMemo(() => {
    const text = query.trim().toLowerCase();
    const filtered = (parks ?? []).filter((park) => !text || `${park.name} ${park.region} ${park.source}`.toLowerCase().includes(text));
    if (!proposal) return filtered.slice(0, 60).map((park) => ({ park, km: null as number | null }));
    return filtered
      .map((park) => ({ park, km: distanceKm(proposal.point, [park.lng, park.lat]) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, 40);
  }, [parks, query, proposal]);

  function pick(park: LegacySummary) {
    setSelectedId(park.id);
    setFly({ position: [park.lng, park.lat], zoom: 13, key: park.id });
  }

  async function createDraft(body: { legacyId?: string; proposalId?: string }) {
    setBusy(true);
    try {
      const { draft } = await api<{ draft: Draft }>("/api/drafts", { method: "POST", body: JSON.stringify(body) });
      toast.show(`Draft created for ${draft.name}`);
      navigate(`/proposals/drafts/${encodeURIComponent(draft.id)}`);
    } catch (reason) {
      toast.show(errorText(reason, "Could not create the draft."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const selectedSummary = parks?.find((park) => park.id === selectedId);

  return (
    <section className="page page--wide" aria-labelledby="import-title">
      <ParksTabs current="/proposals/import" />
      <header className="page-head">
        <div>
          <p className="eyebrow">{proposal ? "Create a draft" : "map.parkdex.app"}</p>
          <h1 id="import-title">{proposal ? `Match "${proposal.name}"` : "Import a park"}</h1>
          <p className="page-lede">{proposal
            ? "The orange pin and dashed area are what the player sent. Pick a legacy park nearby to start from its boundary and record, or start from the proposal itself."
            : "Pick a park from the legacy map. Its boundary and record become a draft. Drafts stay off phones until you publish them."}</p>
        </div>
        {proposal && (
          <div className="toolbar">
            <button type="button" className="button button--ghost" disabled={busy} onClick={() => void createDraft({ proposalId: proposal.id })}>
              <Icon name="edit" size={16} /> No match, start from the proposal
            </button>
          </div>
        )}
      </header>

      {error && <div className="notice notice--error" role="alert"><Icon name="alert" /> {error}</div>}

      <div className="picker">
        <aside className="picker__list">
          <label className="search">
            <Icon name="search" size={17} />
            <input type="search" placeholder="Search legacy parks" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search legacy parks" />
          </label>
          <p className="muted result-count">{parks ? (proposal ? "Nearest legacy parks" : `${list.length < 60 ? list.length : "First 60"} of ${parks.length.toLocaleString()} legacy parks`) : "Loading the legacy map..."}</p>
          <div className="picker__rows">
            {!parks && !error && [0, 1, 2, 3].map((key) => <div key={key} className="legacy-row legacy-row--skeleton" aria-hidden="true" />)}
            {list.map(({ park, km }) => (
              <button key={park.id} type="button" className={`picker-row${park.id === selectedId ? " is-on" : ""}`} onClick={() => pick(park)}>
                <span className={`cat-dot cat-dot--${park.category}`} aria-hidden="true" />
                <span className="picker-row__main">
                  <strong>{park.name}</strong>
                  <span className="muted">{km !== null ? `${km < 1 ? km.toFixed(2) : km.toFixed(1)} km away · ` : ""}{park.category}</span>
                </span>
                {park.status !== "available" && <span className={`status-chip status-chip--${park.status}`}>{STATUS_LABEL[park.status]}</span>}
              </button>
            ))}
          </div>
        </aside>

        <div className="picker__map">
          <ParkMap
            pin={proposal?.point ?? null}
            sketch={proposal?.outline ?? null}
            boundary={selected?.geometry ?? null}
            points={parks?.map((park) => ({ id: park.id, name: park.name, lng: park.lng, lat: park.lat, status: park.status })) ?? []}
            selectedPointId={selectedId}
            onPointClick={(id) => { const park = parks?.find((item) => item.id === id); if (park) pick(park); }}
            fitKey={proposal?.id ?? "all"}
            pinZoom={13}
            flyTarget={fly}
          />
          {selectedId && (
            <div className="picker__card">
              {loadingPark || !selected ? <div className="drawer__state"><Spinner small /> Loading boundary...</div> : (
                <>
                  <div>
                    <strong>{selected.name}</strong>
                    <p className="muted">{[selected.category, selected.region, `${selected.geometryStats.polygons} ${selected.geometryStats.polygons === 1 ? "area" : "areas"}`].filter(Boolean).join(" · ")}</p>
                    {typeof selected.record.description === "string" && <p className="picker__desc">{selected.record.description}</p>}
                  </div>
                  <div className="picker__actions">
                    <button type="button" className="icon-button icon-button--small" aria-label="Clear selection" onClick={() => setSelectedId(null)}><Icon name="close" size={15} /></button>
                    {selectedSummary?.status === "available" ? (
                      <button type="button" className="button button--primary button--small" disabled={busy} onClick={() => void createDraft({ legacyId: selected.id, ...(proposal ? { proposalId: proposal.id } : {}) })}>
                        {busy ? <><Spinner small /> Creating</> : <><Icon name="plus" size={15} /> Use this park</>}
                      </button>
                    ) : selectedSummary?.status === "draft" ? (
                      <button type="button" className="button button--ghost button--small" onClick={() => navigate(`/proposals/drafts/${encodeURIComponent(selected.id)}`)}>Open its draft</button>
                    ) : <span className="muted">Already in Parkdex</span>}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="map-key">
            {proposal && <span><span className="legend-pin" /> Player's pin</span>}
            {proposal?.outline && <span><span className="legend-sketch" /> Player's area</span>}
            <span><span className="legend-dot legend-dot--available" /> Legacy park</span>
            <span><span className="legend-dot legend-dot--draft" /> Draft</span>
            <span><span className="legend-dot legend-dot--in-parkdex" /> In Parkdex</span>
          </div>
        </div>
      </div>
    </section>
  );
}
