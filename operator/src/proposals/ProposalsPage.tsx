import { useCallback, useEffect, useMemo, useState } from "react";
import { BoundarySketch } from "../components/BoundarySketch";
import { api, errorText, type LngLat, type Proposal, type ProposalStatus } from "../api";
import { Icon, Kip, Spinner, timeAgo, useToast } from "../ui";
import { ParksTabs } from "./ParksTabs";

const STATUSES: { status: ProposalStatus; label: string }[] = [
  { status: "new", label: "New" },
  { status: "reviewing", label: "Reviewing" },
  { status: "accepted", label: "Accepted" },
  { status: "declined", label: "Declined" },
];

function mapLink([lng, lat]: LngLat): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function downloadGeoJson(proposal: Proposal) {
  const ring = proposal.outline ? [...proposal.outline, proposal.outline[0]] : null;
  const collection = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: proposal.name, role: "pin" }, geometry: { type: "Point", coordinates: proposal.point } },
      ...(ring ? [{ type: "Feature", properties: { name: proposal.name, role: "outline" }, geometry: { type: "Polygon", coordinates: [ring] } }] : []),
    ],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(collection, null, 2)], { type: "application/geo+json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${proposal.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "park"}.geojson`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ProposalsPage() {
  const toast = useToast();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<ProposalStatus | "all">("new");
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<{ proposals: Proposal[] }>("/api/proposals?status=all", { signal: controller.signal })
      .then((listing) => setProposals(listing.proposals))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load proposals.")); });
    return () => controller.abort();
  }, [revision]);

  const counts = useMemo(() => Object.fromEntries(STATUSES.map(({ status }) => [status, proposals?.filter((item) => item.status === status).length ?? 0])) as Record<ProposalStatus, number>, [proposals]);
  const visible = proposals?.filter((item) => filter === "all" || item.status === filter) ?? [];

  const setStatus = useCallback(async (proposal: Proposal, status: ProposalStatus, undoable = true) => {
    if (proposal.status === status) return;
    const previous = proposal.status;
    setSaving(proposal.id);
    setProposals((current) => current?.map((item) => item.id === proposal.id ? { ...item, status } : item) ?? null);
    try {
      const { proposal: saved } = await api<{ proposal: Proposal }>(`/api/proposals/${proposal.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setProposals((current) => current?.map((item) => item.id === saved.id ? saved : item) ?? null);
      const label = STATUSES.find((item) => item.status === status)?.label ?? status;
      toast.show(`${proposal.name} marked ${label.toLowerCase()}`, undoable ? { action: { label: "Undo", run: () => void setStatus(saved, previous, false) } } : undefined);
    } catch (reason) {
      setProposals((current) => current?.map((item) => item.id === proposal.id ? proposal : item) ?? null);
      toast.show(errorText(reason, "Could not update that proposal."), { tone: "error" });
    } finally {
      setSaving(null);
    }
  }, [toast]);

  return (
    <section className="page" aria-labelledby="proposals-title">
      <ParksTabs current="/proposals" />
      <header className="page-head">
        <div>
          <p className="eyebrow">From the map</p>
          <h1 id="proposals-title">Park proposals</h1>
          <p className="page-lede">Parks players suggested, with a pin and sometimes a rough outline.</p>
        </div>
        <div className="toolbar">
          <div className="tabs" role="tablist" aria-label="Filter by status">
            {[{ status: "all" as const, label: "All" }, ...STATUSES].map((item) => (
              <button key={item.status} type="button" role="tab" aria-selected={filter === item.status} className={`tab${filter === item.status ? " is-on" : ""}`} onClick={() => setFilter(item.status)}>
                {item.label}
                <span className="tab__count">{item.status === "all" ? proposals?.length ?? 0 : counts[item.status]}</span>
              </button>
            ))}
          </div>
          <button type="button" className="icon-button" onClick={() => setRevision((value) => value + 1)} aria-label="Refresh proposals" title="Refresh">
            <Icon name="refresh" />
          </button>
        </div>
      </header>

      {error && <div className="notice notice--error" role="alert"><Icon name="alert" /> {error} <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Try again</button></div>}
      {!proposals && !error && <div className="grid">{[0, 1, 2].map((key) => <div key={key} className="proposal proposal--skeleton" aria-hidden="true" />)}</div>}
      {proposals && visible.length === 0 && (
        <div className="empty">
          <Kip pose="map" size={96} />
          <h2>No {filter === "all" ? "" : `${filter} `}proposals</h2>
          <p className="muted">New suggestions from the map will land here.</p>
        </div>
      )}
      <div className="grid">
        {visible.map((proposal) => (
          <article key={proposal.id} className={`proposal proposal--${proposal.status}`}>
            <div className="proposal__map"><BoundarySketch polygons={proposal.outline ? [[[...proposal.outline, proposal.outline[0]]]] : []} pin={proposal.point} /></div>
            <div className="proposal__body">
              <div className="proposal__title">
                <h2>{proposal.name}</h2>
                <label className={`status-select status-select--${proposal.status}`}>
                  <span className="sr-only">Status of {proposal.name}</span>
                  <select value={proposal.status} disabled={saving === proposal.id} onChange={(event) => void setStatus(proposal, event.target.value as ProposalStatus)}>
                    {STATUSES.map((item) => <option key={item.status} value={item.status}>{item.label}</option>)}
                  </select>
                  {saving === proposal.id ? <Spinner small /> : <Icon name="chevron" size={14} className="status-select__chevron" />}
                </label>
              </div>
              {proposal.note ? <p className="proposal__note">{proposal.note}</p> : <p className="proposal__note muted">No note added.</p>}
              <p className="muted proposal__meta">
                {timeAgo(proposal.createdAt)}
                {proposal.context.platform && ` · ${proposal.context.platform}`}
                {proposal.context.version && ` ${proposal.context.version}`}
                {proposal.context.build && ` (build ${proposal.context.build})`}
                {proposal.outline ? ` · outline, ${proposal.outline.length} points` : " · pin only"}
              </p>
              <div className="proposal__actions">
                <a className="button button--ghost button--small" href={mapLink(proposal.point)} target="_blank" rel="noreferrer"><Icon name="external" size={15} /> Open in Maps</a>
                <button type="button" className="button button--ghost button--small" onClick={() => downloadGeoJson(proposal)}><Icon name="download" size={15} /> GeoJSON</button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
