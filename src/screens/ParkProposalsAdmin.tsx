import { useCallback, useState } from "react";
import { Kip } from "../components/Kip";
import { OperatorNav } from "../components/OperatorNav";
import { OperatorGate, operatorRequest as request, useOperatorSession } from "../components/OperatorSession";
import "../feedback-review.css";
import "../build-config.css";

type LngLat = [number, number];
type Status = "new" | "reviewing" | "accepted" | "declined";

type Proposal = {
  id: string;
  name: string;
  note: string;
  point: LngLat;
  outline: LngLat[] | null;
  context: Record<string, string>;
  status: Status;
  createdAt: string;
  updatedAt: string;
};

type Listing = { proposals: Proposal[]; statuses: Status[] };

const STATUS_LABELS: Record<Status, string> = {
  new: "New",
  reviewing: "Reviewing",
  accepted: "Accepted",
  declined: "Declined",
};

function mapLink([lng, lat]: LngLat): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/** A small north-up sketch of the outline with the pin, scaled to fit. */
function OutlinePreview({ point, outline }: Pick<Proposal, "point" | "outline">) {
  if (!outline) return null;
  const all = [...outline, point];
  const midLat = (Math.min(...all.map((p) => p[1])) + Math.max(...all.map((p) => p[1]))) / 2;
  // Longitude degrees shrink toward the poles; scale them so the shape isn't stretched.
  const xs = all.map((p) => p[0] * Math.cos((midLat * Math.PI) / 180));
  const ys = all.map((p) => -p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  const project = (index: number) => [8 + ((xs[index] - minX) / span) * 104, 8 + ((ys[index] - minY) / span) * 104];
  const path = outline.map((_, index) => project(index).map((v) => v.toFixed(1)).join(" ")).join("L");
  const [pinX, pinY] = project(all.length - 1);
  return (
    <svg className="pp-outline" viewBox="0 0 120 120" role="img" aria-label="Outline sketch">
      <path d={`M${path}Z`} />
      <circle cx={pinX} cy={pinY} r={4} />
    </svg>
  );
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

/** Private operator page listing parks players have proposed from the map. */
export function ParkProposalsAdmin() {
  const [filter, setFilter] = useState<Status | "all">("new");
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setListing(await request<Listing>(`/api/operator/park-proposals?status=${filter}`));
  }, [filter]);
  const session = useOperatorSession(load);
  const { notice, setNotice } = session;

  async function setStatus(proposal: Proposal, status: Status) {
    setBusy(true);
    setNotice(null);
    try {
      await request(`/api/operator/park-proposals/${proposal.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await session.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update this proposal.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    await session.signOut();
    setListing(null);
    setBusy(false);
  }

  const statuses = listing?.statuses ?? (Object.keys(STATUS_LABELS) as Status[]);
  return (
    <OperatorGate auth={session.auth} notice={notice} signIn={session.signIn} copy="Park proposals are parks players suggested from the map, with a pin and sometimes a rough outline.">
      <main className="fr-review bc-page" aria-label="Park proposals">
        <header className="bc-header">
          <Kip pose="avatar" size={43} />
          <div className="bc-title">
            <p className="fr-brand-name">parkdex · {window.location.host}</p>
            <h1>Park proposals</h1>
          </div>
          <div className="bc-actions">
            <OperatorNav />
            <button className="fr-button fr-button--quiet" type="button" onClick={() => void signOut()} disabled={busy}>Sign out</button>
          </div>
        </header>
        <div className="pp-filters" role="group" aria-label="Filter by status">
          {(["all", ...statuses] as const).map((value) => (
            <button
              key={value}
              className={`fr-button ${filter === value ? "fr-button--primary" : "fr-button--paper"}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === "all" ? "All" : STATUS_LABELS[value]}
            </button>
          ))}
        </div>
        {notice && <p className="fr-auth-notice" role="status">{notice}</p>}

        <ul className="bc-list">
          {listing?.proposals.map((proposal) => (
            <li key={proposal.id} className="bc-row pp-row">
              <OutlinePreview point={proposal.point} outline={proposal.outline} />
              <div className="pp-body">
                <strong>{proposal.name}</strong>
                <span className={`bc-label pp-status pp-status--${proposal.status}`}>{STATUS_LABELS[proposal.status]}</span>
                {proposal.note && <p>{proposal.note}</p>}
                <p className="bc-notes">
                  {new Date(proposal.createdAt).toLocaleString()}
                  {proposal.context.version && ` · app ${proposal.context.version}`}
                  {proposal.context.build && ` (build ${proposal.context.build})`}
                  {proposal.context.platform && ` · ${proposal.context.platform}`}
                  {proposal.outline ? ` · outline with ${proposal.outline.length} points` : " · pin only"}
                </p>
                <div className="bc-actions pp-actions">
                  <a className="fr-button fr-button--paper" href={mapLink(proposal.point)} target="_blank" rel="noreferrer">Open in Maps</a>
                  <button className="fr-button fr-button--paper" onClick={() => downloadGeoJson(proposal)}>GeoJSON</button>
                  <select className="pp-select" aria-label={`Status of ${proposal.name}`} value={proposal.status} disabled={busy} onChange={(event) => void setStatus(proposal, event.target.value as Status)}>
                    {statuses.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                  </select>
                </div>
              </div>
            </li>
          ))}
          {listing && listing.proposals.length === 0 && (
            <li className="bc-row bc-row--empty">No {filter === "all" ? "" : `${STATUS_LABELS[filter].toLowerCase()} `}proposals yet.</li>
          )}
        </ul>
      </main>
    </OperatorGate>
  );
}
