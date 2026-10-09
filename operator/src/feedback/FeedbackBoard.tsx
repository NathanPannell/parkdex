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
  type DragStartEvent,
} from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../api";
import type { ClearDoneResult, FeedbackPage, FeedbackReport, ReportKind, ReportStatus } from "./types";
import { Icon, Kip, PageHeader, Spinner, timeAgo, useConfirm, useToast, type IconName } from "../ui";
import { FeedbackDrawer } from "./FeedbackDrawer";
import { appBuildLabel, ARCHIVE_RETENTION_DAYS } from "./format";

export const COLUMNS: { status: ReportStatus; label: string; hint: string }[] = [
  { status: "new", label: "New", hint: "Fresh from players" },
  { status: "reviewing", label: "Reviewing", hint: "Being looked at" },
  { status: "planned", label: "Planned", hint: "On the roadmap" },
  // Done is the stored "closed" status, so the app and older dashboards need no change.
  { status: "closed", label: "Done", hint: "Fixed, answered or won't fix" },
];

export const KINDS: Record<ReportKind, { label: string; icon: IconName }> = {
  bug: { label: "Bug", icon: "bug" },
  idea: { label: "Idea", icon: "bulb" },
  general: { label: "Note", icon: "chat" },
};

type Column = { reports: FeedbackReport[]; nextCursor: string | null; state: "loading" | "ready" | "error"; error?: string; loadingMore?: boolean };
type Board = Record<ReportStatus, Column>;

const emptyBoard = (): Board => ({
  new: { reports: [], nextCursor: null, state: "loading" },
  reviewing: { reports: [], nextCursor: null, state: "loading" },
  planned: { reports: [], nextCursor: null, state: "loading" },
  closed: { reports: [], nextCursor: null, state: "loading" },
});

const byNewest = (a: FeedbackReport, b: FeedbackReport) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

// Use the column under the pointer, falling back to overlap when the pointer is between columns.
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

function deliveryTrouble(report: FeedbackReport): boolean {
  return report.emails.some((email) => email.status === "failed" || email.status === "ambiguous" || email.requiresConfirmation);
}

export function FeedbackBoard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [clearing, setClearing] = useState(false);
  const [board, setBoard] = useState<Board>(emptyBoard);
  const boardRef = useRef(board);
  boardRef.current = board;
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<ReportKind>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(selectedFromUrl);
  const [saving, setSaving] = useState<Set<string>>(new Set());

  // Keyboard and screen reader users open a card and set its status from the panel instead of dragging.
  // On touch screens a long press picks a card up, so a normal swipe still scrolls the board.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  useEffect(() => {
    const controller = new AbortController();
    setBoard((current) => Object.fromEntries(COLUMNS.map(({ status }) => [status, { ...current[status], state: "loading" }])) as Board);
    for (const { status } of COLUMNS) {
      api<FeedbackPage>(`/api/feedback?status=${status}`, { signal: controller.signal })
        .then((page) => setBoard((current) => ({ ...current, [status]: { reports: page.reports, nextCursor: page.nextCursor, state: "ready" } })))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setBoard((current) => ({ ...current, [status]: { ...current[status], state: "error", error: errorText(error, "Could not load this column.") } }));
        });
    }
    return () => controller.abort();
  }, [revision]);

  useEffect(() => writeSelected(selectedId), [selectedId]);

  const findReport = useCallback((id: string): FeedbackReport | undefined => {
    for (const { status } of COLUMNS) {
      const found = boardRef.current[status].reports.find((report) => report.id === id);
      if (found) return found;
    }
    return undefined;
  }, []);

  const place = useCallback((report: FeedbackReport) => {
    setBoard((current) => {
      const next = { ...current };
      for (const { status } of COLUMNS) {
        const without = current[status].reports.filter((item) => item.id !== report.id);
        next[status] = { ...current[status], reports: status === report.status ? [...without, report].sort(byNewest) : without };
      }
      return next;
    });
  }, []);

  const moveReport = useCallback(async (report: FeedbackReport, to: ReportStatus, options: { undoable?: boolean } = {}) => {
    const from = report.status;
    if (from === to) return;
    place({ ...report, status: to });
    setSaving((current) => new Set(current).add(report.id));
    try {
      const saved = await api<{ report: FeedbackReport }>(`/api/feedback/${report.id}`, { method: "PATCH", body: JSON.stringify({ status: to }) });
      place(saved.report);
      const label = COLUMNS.find((column) => column.status === to)?.label ?? to;
      toast.show(`Moved to ${label}`, options.undoable === false ? undefined : { action: { label: "Undo", run: () => void moveReport(saved.report, from, { undoable: false }) } });
    } catch (error) {
      place(report);
      toast.show(errorText(error, "Could not move that report."), { tone: "error" });
    } finally {
      setSaving((current) => {
        const next = new Set(current);
        next.delete(report.id);
        return next;
      });
    }
  }, [place, toast]);

  const restore = useCallback(async (ids: string[]) => {
    try {
      const { restored } = await api<{ restored: string[] }>("/api/feedback/archive/restore", { method: "POST", body: JSON.stringify({ ids }) });
      toast.show(restored.length === 1 ? "Report is back in Done" : `${restored.length} reports are back in Done`);
      setRevision((value) => value + 1);
      return restored;
    } catch (error) {
      toast.show(errorText(error, "Could not restore those reports."), { tone: "error" });
      return [];
    }
  }, [toast]);

  // "Clear done" archives instead of deleting, so it is one click with Undo, plus a popup that
  // says where the reports go and when they are deleted for good.
  async function clearDone() {
    const done = boardRef.current.closed;
    const count = `${done.reports.length}${done.nextCursor ? "+" : ""}`;
    const ok = await confirm({
      title: `Archive ${count} done ${done.reports.length === 1 && !done.nextCursor ? "report" : "reports"}?`,
      body: <>
        <p>They leave the board and move to the Archive, where you can search and restore them.</p>
        <p>Archived reports, with their screenshots, are deleted for good {ARCHIVE_RETENTION_DAYS} days after archiving.</p>
      </>,
      confirmLabel: "Archive done",
      icon: "inbox",
    });
    if (!ok) return;
    setClearing(true);
    try {
      let result = await api<ClearDoneResult>("/api/feedback/clear-done", { method: "POST" });
      const ids = [...result.ids];
      // One click clears the column even when it holds more than the server archives per call.
      for (let round = 0; result.more && round < 20; round += 1) {
        result = await api<ClearDoneResult>("/api/feedback/clear-done", { method: "POST" });
        ids.push(...result.ids);
      }
      const gone = new Set(ids);
      setBoard((current) => ({ ...current, closed: { ...current.closed, reports: current.closed.reports.filter((report) => !gone.has(report.id)), nextCursor: null } }));
      if (selectedId && gone.has(selectedId)) setSelectedId(null);
      toast.show(ids.length === 0 ? "Nothing to archive" : `Archived ${ids.length} ${ids.length === 1 ? "report" : "reports"}`, ids.length ? { action: { label: "Undo", run: () => void restore(ids) } } : undefined);
    } catch (error) {
      toast.show(errorText(error, "Could not archive the done reports."), { tone: "error" });
      setRevision((value) => value + 1);
    } finally {
      setClearing(false);
    }
  }

  async function loadMore(status: ReportStatus) {
    const column = boardRef.current[status];
    if (!column.nextCursor || column.loadingMore) return;
    setBoard((current) => ({ ...current, [status]: { ...current[status], loadingMore: true } }));
    try {
      const page = await api<FeedbackPage>(`/api/feedback?status=${status}&cursor=${encodeURIComponent(column.nextCursor)}`);
      setBoard((current) => {
        const seen = new Set(current[status].reports.map((report) => report.id));
        return { ...current, [status]: { ...current[status], reports: [...current[status].reports, ...page.reports.filter((report) => !seen.has(report.id))], nextCursor: page.nextCursor, loadingMore: false } };
      });
    } catch (error) {
      setBoard((current) => ({ ...current, [status]: { ...current[status], loadingMore: false } }));
      toast.show(errorText(error, "Could not load more reports."), { tone: "error" });
    }
  }

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const report = findReport(String(event.active.id));
    const target = event.over?.id as ReportStatus | undefined;
    if (report && target && target !== report.status) void moveReport(report, target);
  }

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (report: FeedbackReport) =>
      (kinds.size === 0 || kinds.has(report.kind)) &&
      (!text || [report.message, report.context.parkName, report.context.screen, report.context.platform, report.email]
        .some((value) => typeof value === "string" && value.toLowerCase().includes(text)));
  }, [query, kinds]);

  const totalNew = board.new.reports.length;
  const activeReport = activeId ? findReport(activeId) : undefined;
  const selected = selectedId ? findReport(selectedId) : undefined;

  function toggleKind(kind: ReportKind) {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return (
    <section className="page page--board" aria-labelledby="feedback-title">
      <PageHeader
        id="feedback-title"
        eyebrow="Player feedback"
        title="Feedback board"
        lede={<>
          {board.new.state === "ready" ? (totalNew === 0 ? "Inbox zero. Nice work." : `${totalNew}${board.new.nextCursor ? "+" : ""} new ${totalNew === 1 ? "report needs" : "reports need"} a look.`) : "Loading reports..."}
          {" "}Drag cards between columns to set their status; Clear done moves finished reports to the Archive.
        </>}
        actions={<>
          <label className="search">
            <Icon name="search" size={17} />
            <input type="search" placeholder="Search messages, parks, devices" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search feedback" />
          </label>
          <div className="chip-row" role="group" aria-label="Filter by kind">
            {(Object.keys(KINDS) as ReportKind[]).map((kind) => (
              <button key={kind} type="button" className={`chip chip--${kind}${kinds.has(kind) ? " is-on" : ""}`} aria-pressed={kinds.has(kind)} onClick={() => toggleKind(kind)}>
                <Icon name={KINDS[kind].icon} size={15} /> {KINDS[kind].label}
              </button>
            ))}
          </div>
          <button type="button" className="icon-button" onClick={() => setRevision((value) => value + 1)} aria-label="Refresh board" title="Refresh">
            <Icon name="refresh" />
          </button>
        </>}
      />

      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
        <div className="board">
          {COLUMNS.map((column) => (
            <BoardColumn
              key={column.status}
              {...column}
              data={board[column.status]}
              visible={board[column.status].reports.filter(matches)}
              filtered={Boolean(query.trim()) || kinds.size > 0}
              saving={saving}
              activeId={activeId}
              onOpen={setSelectedId}
              onRetry={() => setRevision((value) => value + 1)}
              onMore={() => void loadMore(column.status)}
              onClear={column.status === "closed" ? () => void clearDone() : undefined}
              clearing={clearing}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }}>
          {activeReport ? <CardBody report={activeReport} lifted /> : null}
        </DragOverlay>
      </DndContext>

      <FeedbackDrawer
        reportId={selectedId}
        summary={selected}
        onClose={() => setSelectedId(null)}
        onMove={(report, status) => void moveReport(report, status)}
        onUpdated={(report) => { if (!report.archivedAt) place(report); }}
        onRestore={(report) => restore([report.id])}
      />
    </section>
  );
}

function BoardColumn({ status, label, hint, data, visible, filtered, saving, activeId, onOpen, onRetry, onMore, onClear, clearing }: {
  status: ReportStatus;
  label: string;
  hint: string;
  data: Column;
  visible: FeedbackReport[];
  filtered: boolean;
  saving: Set<string>;
  activeId: string | null;
  onOpen(id: string): void;
  onRetry(): void;
  onMore(): void;
  /** Only the Done column can be cleared into the archive. */
  onClear?(): void;
  clearing?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const count = `${data.reports.length}${data.nextCursor ? "+" : ""}`;
  return (
    <div ref={setNodeRef} className={`column column--${status}${isOver ? " is-over" : ""}`} aria-label={`${label} column`}>
      <div className="column__head">
        <span className="column__dot" aria-hidden="true" />
        <div>
          <h2>{label}</h2>
          <p>{hint}</p>
        </div>
        <span className="column__count">{data.state === "loading" && !data.reports.length ? "..." : count}</span>
      </div>
      {onClear && data.reports.length > 0 && (
        <div className="column__tools">
          <button type="button" className="button button--ghost button--small button--wide" onClick={onClear} disabled={clearing} title="Move every done report to the Archive">
            {clearing ? <><Spinner small /> Archiving</> : <><Icon name="inbox" size={15} /> Clear done</>}
          </button>
        </div>
      )}
      <div className="column__body">
        {data.state === "loading" && !data.reports.length && [0, 1, 2].map((key) => <div key={key} className="card card--skeleton" aria-hidden="true" />)}
        {data.state === "error" && (
          <div className="column__empty column__empty--error" role="alert">
            <Icon name="alert" size={22} />
            <p>{data.error}</p>
            <button type="button" className="text-button" onClick={onRetry}>Try again</button>
          </div>
        )}
        {data.state === "ready" && visible.length === 0 && (
          <div className="column__empty">
            {filtered ? <Icon name="search" size={22} /> : <Kip pose={status === "new" ? "celebrate" : "sleep"} size={64} />}
            <p>{filtered ? "No matches here." : status === "new" ? "All caught up." : status === "closed" ? "Drop finished reports here." : "Drop a card here."}</p>
          </div>
        )}
        {visible.map((report) => (
          <DraggableCard key={report.id} report={report} saving={saving.has(report.id)} hidden={activeId === report.id} onOpen={onOpen} />
        ))}
        {data.nextCursor && (
          <button type="button" className="button button--ghost button--wide" onClick={onMore} disabled={data.loadingMore}>
            {data.loadingMore ? <><Spinner small /> Loading</> : "Load older reports"}
          </button>
        )}
      </div>
    </div>
  );
}

function DraggableCard({ report, saving, hidden, onOpen }: { report: FeedbackReport; saving: boolean; hidden: boolean; onOpen(id: string): void }) {
  // The DragOverlay follows the pointer, so the original card stays put as a placeholder.
  const { attributes, listeners, setNodeRef } = useDraggable({ id: report.id });
  return (
    <div ref={setNodeRef} className={`card-slot${hidden ? " is-placeholder" : ""}`}>
      <button
        type="button"
        className="card-hit"
        {...listeners}
        {...attributes}
        aria-roledescription="report card"
        aria-label={`Open ${KINDS[report.kind].label.toLowerCase()}: ${report.message.slice(0, 80)}`}
        onClick={() => onOpen(report.id)}
      >
        <CardBody report={report} saving={saving} />
      </button>
    </div>
  );
}

function CardBody({ report, saving, lifted }: { report: FeedbackReport; saving?: boolean; lifted?: boolean }) {
  const kind = KINDS[report.kind] ?? KINDS.general;
  const build = appBuildLabel(report.context);
  return (
    <article className={`card card--${report.kind}${lifted ? " is-lifted" : ""}${saving ? " is-saving" : ""}`}>
      <div className="card__top">
        <span className={`kind kind--${report.kind}`}><Icon name={kind.icon} size={14} /> {kind.label}</span>
        <time dateTime={report.createdAt}>{timeAgo(report.createdAt)}</time>
      </div>
      <p className="card__message">{report.message || "No message supplied."}</p>
      <div className="card__meta">
        {report.context.parkName && <span className="meta-pill"><Icon name="pin" size={13} /> {report.context.parkName}</span>}
        {report.context.platform && <span className="meta-pill"><Icon name="phone" size={13} /> {report.context.platform}</span>}
        {build && <span className="meta-pill meta-pill--build" title="App version and build">{build}</span>}
        <span className="card__icons">
          {report.hasScreenshot && <span title="Screenshot attached"><Icon name="image" size={15} /></span>}
          {report.contact && report.email && <span title="Asked for a reply"><Icon name="mail" size={15} /></span>}
          {deliveryTrouble(report) && <span className="card__warn" title="An email needs attention"><Icon name="alert" size={15} /></span>}
          {saving && <Spinner small />}
        </span>
      </div>
    </article>
  );
}
