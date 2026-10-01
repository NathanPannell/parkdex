import { useEffect, useMemo, useState } from "react";
import { api, errorText, type Draft, type LegacyPark, type LegacySummary } from "../api";
import { BoundarySketch } from "../components/BoundarySketch";
import { navigate } from "../router";
import { Drawer, Icon, Kip, Spinner, useToast } from "../ui";
import { ParksTabs } from "./ParksTabs";

const STATUS_LABEL: Record<LegacySummary["status"], string> = { available: "Available", draft: "Draft", "in-parkdex": "In Parkdex" };
const PAGE = 80;

export function ImportPage() {
  const [parks, setParks] = useState<LegacySummary[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [hideTaken, setHideTaken] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<{ parks: LegacySummary[] }>("/api/legacy/parks", { signal: controller.signal })
      .then((result) => setParks(result.parks))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load the legacy map.")); });
    return () => controller.abort();
  }, [revision]);

  const categories = useMemo(() => [...new Set(parks?.map((park) => park.category) ?? [])].sort(), [parks]);
  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (parks ?? []).filter((park) =>
      (category === "all" || park.category === category) &&
      (!hideTaken || park.status === "available") &&
      (!text || `${park.name} ${park.region} ${park.source} ${park.id}`.toLowerCase().includes(text)));
  }, [parks, query, category, hideTaken]);

  useEffect(() => setLimit(PAGE), [query, category, hideTaken]);

  return (
    <section className="page" aria-labelledby="import-title">
      <ParksTabs current="/proposals/import" />
      <header className="page-head">
        <div>
          <p className="eyebrow">map.parkdex.app</p>
          <h1 id="import-title">Import a park</h1>
          <p className="page-lede">Pick a park from the legacy map. Its boundary and record become a draft with no badge or description. Drafts stay off phones until you publish them.</p>
        </div>
        <div className="toolbar">
          <label className="search">
            <Icon name="search" size={17} />
            <input type="search" placeholder="Search name, region or source" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search legacy parks" />
          </label>
          <select className="select" value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Category">
            <option value="all">All categories</option>
            {categories.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
          </select>
          <label className="toggle">
            <input type="checkbox" checked={hideTaken} onChange={(event) => setHideTaken(event.target.checked)} />
            <span>Only parks not yet imported</span>
          </label>
        </div>
      </header>

      {error && <div className="notice notice--error" role="alert"><Icon name="alert" /> {error} <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Try again</button></div>}
      {!parks && !error && <div className="legacy-list">{[0, 1, 2, 3, 4].map((key) => <div key={key} className="legacy-row legacy-row--skeleton" aria-hidden="true" />)}</div>}
      {parks && (
        <>
          <p className="muted result-count">{matches.length.toLocaleString()} of {parks.length.toLocaleString()} legacy parks</p>
          {matches.length === 0 && (
            <div className="empty"><Kip pose="think" size={90} /><h2>No matching parks</h2><p className="muted">Try another name, or include parks that are already imported.</p></div>
          )}
          <div className="legacy-list">
            {matches.slice(0, limit).map((park) => (
              <button key={park.id} type="button" className="legacy-row" onClick={() => setSelected(park.id)}>
                <span className={`cat-dot cat-dot--${park.category}`} aria-hidden="true" />
                <span className="legacy-row__main">
                  <strong>{park.name}</strong>
                  <span className="muted">{park.region || "No region"} · {park.source}</span>
                </span>
                <span className="meta-pill">{park.category}</span>
                <span className={`status-chip status-chip--${park.status}`}>{STATUS_LABEL[park.status]}</span>
                <Icon name="chevron" size={16} className="legacy-row__chevron" />
              </button>
            ))}
          </div>
          {matches.length > limit && (
            <button type="button" className="button button--ghost button--wide load-more" onClick={() => setLimit((value) => value + PAGE)}>
              Show more ({(matches.length - limit).toLocaleString()} left)
            </button>
          )}
        </>
      )}

      <LegacyPreview id={selected} status={parks?.find((park) => park.id === selected)?.status ?? null} onClose={() => setSelected(null)} />
    </section>
  );
}

function LegacyPreview({ id, status, onClose }: { id: string | null; status: LegacySummary["status"] | null; onClose(): void }) {
  const toast = useToast();
  const [park, setPark] = useState<LegacyPark | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setPark(null);
    setState("loading");
    api<{ park: LegacyPark }>(`/api/legacy/parks/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((result) => { setPark(result.park); setState("ready"); })
      .catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [id]);

  async function createDraft() {
    if (!park) return;
    setBusy(true);
    try {
      const { draft } = await api<{ draft: Draft }>("/api/drafts", { method: "POST", body: JSON.stringify({ legacyId: park.id }) });
      toast.show(`Draft created for ${draft.name}`);
      navigate(`/proposals/drafts/${encodeURIComponent(draft.id)}`);
    } catch (reason) {
      toast.show(errorText(reason, "Could not create the draft."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const recordRows = park ? Object.entries(park.record).filter(([, value]) => value !== null && value !== "") : [];
  return (
    <Drawer open={Boolean(id)} onClose={onClose} label="Legacy park">
      <div className="drawer__head">
        <div>
          <p className="eyebrow">Legacy park</p>
          <h2>{park?.name ?? "Loading..."}</h2>
          {park && <p className="muted">{park.id}</p>}
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </div>
      {state === "loading" && <div className="drawer__state"><Spinner /> Loading the boundary...</div>}
      {state === "error" && <div className="drawer__state" role="alert">This park could not be loaded from the legacy map.</div>}
      {park && (
        <>
          <div className="drawer__body">
            <div className="preview-map"><BoundarySketch polygons={park.geometry.coordinates} pin={[park.lng, park.lat]} width={420} height={260} /></div>
            <p className="muted geometry-stats">
              {park.geometryStats.polygons} {park.geometryStats.polygons === 1 ? "polygon" : "polygons"} · {park.geometryStats.holes} {park.geometryStats.holes === 1 ? "hole" : "holes"} · {park.geometryStats.positions.toLocaleString()} points
            </p>
            <section className="panel">
              <h3>Legacy record</h3>
              <dl className="facts facts--wide">
                {recordRows.map(([key, value]) => (
                  <div key={key}><dt>{key}</dt><dd>{typeof value === "string" && /^https?:\/\//.test(value) ? <a href={value} target="_blank" rel="noreferrer">{value}</a> : typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>
                ))}
              </dl>
            </section>
            {!["national", "provincial", "regional", "municipal", "community"].includes(park.category) && (
              <div className="notice"><Icon name="alert" size={18} /> The app has no "{park.category}" category yet. You will pick one in the draft before publishing.</div>
            )}
          </div>
          <div className="drawer__foot">
            <span className="spacer" />
            {status === "available" ? (
              <button type="button" className="button button--primary" onClick={() => void createDraft()} disabled={busy}>
                {busy ? <><Spinner small /> Creating</> : <><Icon name="plus" size={16} /> Create draft</>}
              </button>
            ) : status === "draft" ? (
              <button type="button" className="button button--primary" onClick={() => navigate(`/proposals/drafts/${encodeURIComponent(park.id)}`)}>Open draft</button>
            ) : (
              <span className="muted">Already in Parkdex</span>
            )}
          </div>
        </>
      )}
    </Drawer>
  );
}
