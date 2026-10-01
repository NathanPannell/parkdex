import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type Proposal, type ProposalStatus } from "../api";
import { ParkMap } from "../components/ParkMap";
import { navigate } from "../router";
import { Drawer, fullDate, Icon, Kip, Spinner, timeAgo, useToast } from "../ui";
import { ParksTabs } from "./ParksTabs";

const COLUMNS: { status: ProposalStatus; label: string; hint: string }[] = [
  { status: "new", label: "New", hint: "Just suggested" },
  { status: "reviewing", label: "Reviewing", hint: "Being checked" },
  { status: "accepted", label: "Accepted", hint: "Becoming a park" },
  { status: "declined", label: "Declined", hint: "Not adding" },
];

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

function selectedFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("id");
}

function writeSelected(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("id", id);
  else url.searchParams.delete("id");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
}

export function ProposalsPage() {
  const toast = useToast();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(selectedFromUrl);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const proposalsRef = useRef(proposals);
  proposalsRef.current = proposals;

  // On touch screens a long press picks a card up, so a normal swipe still scrolls the board.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<{ proposals: Proposal[] }>("/api/proposals?status=all", { signal: controller.signal })
      .then((listing) => setProposals(listing.proposals))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load proposals.")); });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => writeSelected(selectedId), [selectedId]);

  const place = useCallback((proposal: Proposal) => {
    setProposals((current) => current?.map((item) => item.id === proposal.id ? proposal : item) ?? null);
  }, []);

  const move = useCallback(async (proposal: Proposal, status: ProposalStatus, undoable = true) => {
    const previous = proposal.status;
    if (previous === status) return;
    place({ ...proposal, status });
    setSaving((current) => new Set(current).add(proposal.id));
    try {
      const { proposal: saved } = await api<{ proposal: Proposal }>(`/api/proposals/${proposal.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      place(saved);
      const label = COLUMNS.find((column) => column.status === status)?.label ?? status;
      toast.show(`Moved to ${label}`, undoable ? { action: { label: "Undo", run: () => void move(saved, previous, false) } } : undefined);
    } catch (reason) {
      place(proposal);
      toast.show(errorText(reason, "Could not move that proposal."), { tone: "error" });
    } finally {
      setSaving((current) => {
        const next = new Set(current);
        next.delete(proposal.id);
        return next;
      });
    }
  }, [place, toast]);

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const proposal = proposalsRef.current?.find((item) => item.id === String(event.active.id));
    const target = event.over?.id as ProposalStatus | undefined;
    if (proposal && target && target !== proposal.status) void move(proposal, target);
  }

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (proposal: Proposal) => !text || `${proposal.name} ${proposal.note}`.toLowerCase().includes(text);
  }, [query]);

  const active = activeId ? proposals?.find((item) => item.id === activeId) : undefined;
  const selected = selectedId ? proposals?.find((item) => item.id === selectedId) : undefined;
  const fresh = proposals?.filter((item) => item.status === "new").length ?? 0;

  return (
    <section className="page page--board" aria-labelledby="proposals-title">
      <ParksTabs current="/proposals" />
      <header className="page-head">
        <div>
          <p className="eyebrow">From the map</p>
          <h1 id="proposals-title">Park proposals</h1>
          <p className="page-lede">{proposals ? (fresh ? `${fresh} new ${fresh === 1 ? "proposal" : "proposals"} to look at.` : "No new proposals.") : "Loading proposals..."} Drag cards between columns, or open one to see it on the map.</p>
        </div>
        <div className="toolbar">
          <label className="search">
            <Icon name="search" size={17} />
            <input type="search" placeholder="Search names and notes" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search proposals" />
          </label>
          <button type="button" className="icon-button" onClick={() => setRevision((value) => value + 1)} aria-label="Refresh proposals" title="Refresh"><Icon name="refresh" /></button>
        </div>
      </header>

      {error && <div className="notice notice--error" role="alert"><Icon name="alert" /> {error} <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Try again</button></div>}

      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={(event) => setActiveId(String(event.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
        <div className="board">
          {COLUMNS.map((column) => (
            <ProposalColumn
              key={column.status}
              {...column}
              loading={!proposals && !error}
              items={(proposals ?? []).filter((item) => item.status === column.status).filter(matches)}
              filtered={Boolean(query.trim())}
              activeId={activeId}
              saving={saving}
              onOpen={setSelectedId}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }}>
          {active ? <ProposalCard proposal={active} lifted /> : null}
        </DragOverlay>
      </DndContext>

      <ProposalDrawer proposal={selected ?? null} open={Boolean(selectedId)} onClose={() => setSelectedId(null)} onMove={(proposal, status) => void move(proposal, status)} />
    </section>
  );
}

function ProposalColumn({ status, label, hint, loading, items, filtered, activeId, saving, onOpen }: {
  status: ProposalStatus; label: string; hint: string; loading: boolean; items: Proposal[]; filtered: boolean;
  activeId: string | null; saving: Set<string>; onOpen(id: string): void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div ref={setNodeRef} className={`column column--${status}${isOver ? " is-over" : ""}`} aria-label={`${label} column`}>
      <div className="column__head">
        <span className="column__dot" aria-hidden="true" />
        <div>
          <h2>{label}</h2>
          <p>{hint}</p>
        </div>
        <span className="column__count">{loading ? "..." : items.length}</span>
      </div>
      <div className="column__body">
        {loading && [0, 1].map((key) => <div key={key} className="card card--skeleton" aria-hidden="true" />)}
        {!loading && items.length === 0 && (
          <div className="column__empty">
            {filtered ? <Icon name="search" size={22} /> : <Kip pose={status === "new" ? "map" : "sleep"} size={64} />}
            <p>{filtered ? "No matches here." : status === "new" ? "Nothing new." : "Drop a card here."}</p>
          </div>
        )}
        {items.map((proposal) => <DraggableProposal key={proposal.id} proposal={proposal} hidden={activeId === proposal.id} saving={saving.has(proposal.id)} onOpen={onOpen} />)}
      </div>
    </div>
  );
}

function DraggableProposal({ proposal, hidden, saving, onOpen }: { proposal: Proposal; hidden: boolean; saving: boolean; onOpen(id: string): void }) {
  // The DragOverlay follows the pointer, so the original card stays put as a placeholder.
  const { attributes, listeners, setNodeRef } = useDraggable({ id: proposal.id });
  return (
    <div ref={setNodeRef} className={`card-slot${hidden ? " is-placeholder" : ""}`}>
      <button type="button" className="card-hit" {...listeners} {...attributes} aria-roledescription="proposal card" aria-label={`Open ${proposal.name}`} onClick={() => onOpen(proposal.id)}>
        <ProposalCard proposal={proposal} saving={saving} />
      </button>
    </div>
  );
}

function ProposalCard({ proposal, saving, lifted }: { proposal: Proposal; saving?: boolean; lifted?: boolean }) {
  return (
    <article className={`card card--proposal${lifted ? " is-lifted" : ""}${saving ? " is-saving" : ""}`}>
      <div className="card__top">
        <strong className="card__title">{proposal.name}</strong>
        <time dateTime={proposal.createdAt}>{timeAgo(proposal.createdAt)}</time>
      </div>
      {proposal.note && <p className="card__message">{proposal.note}</p>}
      <div className="card__meta">
        <span className="meta-pill"><Icon name="pin" size={13} /> {proposal.outline ? "Pin and outline" : "Pin only"}</span>
        <span className="card__icons">{saving && <Spinner small />}</span>
      </div>
    </article>
  );
}

function ProposalDrawer({ proposal, open, onClose, onMove }: { proposal: Proposal | null; open: boolean; onClose(): void; onMove(proposal: Proposal, status: ProposalStatus): void }) {
  return (
    <Drawer open={open} onClose={onClose} label="Park proposal">
      <div className="drawer__head">
        <div>
          <p className="eyebrow">Park proposal</p>
          <h2>{proposal?.name ?? "Loading..."}</h2>
          {proposal && <p className="muted drawer__received">Reported {fullDate(proposal.createdAt)}</p>}
        </div>
        <div className="drawer__actions">
          {proposal && (
            <button type="button" className="button button--primary button--small" onClick={() => navigate(`/proposals/import?proposal=${proposal.id}`)}>
              <Icon name="plus" size={15} /> Create draft
            </button>
          )}
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
      </div>
      {!proposal && <div className="drawer__state"><Spinner /> Opening proposal...</div>}
      {proposal && (
        <div className="drawer__body">
          <div className="segmented" role="radiogroup" aria-label="Status">
            {COLUMNS.map((column) => (
              <button key={column.status} type="button" role="radio" aria-checked={proposal.status === column.status}
                className={`segmented__item segmented__item--${column.status}${proposal.status === column.status ? " is-on" : ""}`}
                onClick={() => onMove(proposal, column.status)}>
                {column.label}
              </button>
            ))}
          </div>
          <div className="map-frame">
            <ParkMap pin={proposal.point} sketch={proposal.outline} fitKey={proposal.id} pinZoom={15} />
          </div>
          <figure className="quote">
            <figcaption>The player wrote</figcaption>
            <blockquote dir="auto">{proposal.note || "No note added."}</blockquote>
          </figure>
          <p className="muted map-legend"><span className="legend-pin" /> Their pin {proposal.outline && <><span className="legend-sketch" /> The area they drew</>}</p>
        </div>
      )}
    </Drawer>
  );
}
