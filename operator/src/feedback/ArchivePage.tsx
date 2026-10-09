import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { EmptyState, Icon, Notice, PageHeader, Spinner, Table, useToast, type Column } from "../ui";
import { KINDS } from "./FeedbackBoard";
import { FeedbackDrawer } from "./FeedbackDrawer";
import { appBuildLabel, ARCHIVE_RETENTION_DAYS, deletesOn, shortDate } from "./format";
import type { ArchivePage as Page, FeedbackReport } from "./types";

type State = { reports: FeedbackReport[] | null; nextCursor: string | null; total: number | null; error: string; loadingMore: boolean };

function daysLeft(archivedAt: string): number {
  return Math.max(0, Math.ceil((Date.parse(deletesOn(archivedAt)) - Date.now()) / 86_400_000));
}

/** /feedback/archive: done reports cleared from the board, searchable and restorable until retention deletes them. */
export function ArchivePage() {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<State>({ reports: null, nextCursor: null, total: null, error: "", loadingMore: false });
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("id"));
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const searchBox = useRef<HTMLInputElement>(null);

  // Wait for a pause in typing so each keystroke is not a query.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, reports: null, error: "" }));
    api<Page>(`/api/feedback/archive${search ? `?q=${encodeURIComponent(search)}` : ""}`, { signal: controller.signal })
      .then((page) => setState({ reports: page.reports, nextCursor: page.nextCursor, total: page.total, error: "", loadingMore: false }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, reports: [], error: errorText(error, "Could not load the archive.") }));
      });
    return () => controller.abort();
  }, [search, revision]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set("id", selectedId);
    else url.searchParams.delete("id");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, [selectedId]);

  // "/" jumps to the search box, as in most dense tools.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      searchBox.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function loadMore() {
    if (!state.nextCursor || state.loadingMore) return;
    setState((current) => ({ ...current, loadingMore: true }));
    try {
      const params = new URLSearchParams({ cursor: state.nextCursor });
      if (search) params.set("q", search);
      const page = await api<Page>(`/api/feedback/archive?${params}`);
      setState((current) => {
        const seen = new Set(current.reports?.map((report) => report.id));
        return { ...current, reports: [...(current.reports ?? []), ...page.reports.filter((report) => !seen.has(report.id))], nextCursor: page.nextCursor, loadingMore: false };
      });
    } catch (error) {
      setState((current) => ({ ...current, loadingMore: false }));
      toast.show(errorText(error, "Could not load more reports."), { tone: "error" });
    }
  }

  const restore = useCallback(async (report: FeedbackReport): Promise<string[]> => {
    setRestoring((current) => new Set(current).add(report.id));
    try {
      const { restored } = await api<{ restored: string[] }>("/api/feedback/archive/restore", { method: "POST", body: JSON.stringify({ ids: [report.id] }) });
      setState((current) => ({
        ...current,
        reports: current.reports?.filter((item) => !restored.includes(item.id)) ?? null,
        total: current.total === null ? null : Math.max(0, current.total - restored.length),
      }));
      toast.show(restored.length ? "Restored to Done on the board" : "That report was already restored");
      return restored;
    } catch (error) {
      toast.show(errorText(error, "Could not restore that report."), { tone: "error" });
      return [];
    } finally {
      setRestoring((current) => {
        const next = new Set(current);
        next.delete(report.id);
        return next;
      });
    }
  }, [toast]);

  const columns: Column<FeedbackReport>[] = [
    {
      key: "kind", header: "Kind", width: "92px",
      cell: (report) => { const kind = KINDS[report.kind] ?? KINDS.general; return <span className={`kind kind--${report.kind}`}><Icon name={kind.icon} size={13} /> {kind.label}</span>; },
    },
    {
      key: "report", header: "Report",
      cell: (report) => (
        <div className="archive-row__report">
          <span className="archive-row__message">{report.message || "No message supplied."}</span>
          {report.context.parkName && <span className="archive-row__park"><Icon name="pin" size={12} /> {report.context.parkName}</span>}
        </div>
      ),
    },
    { key: "app", header: "App", width: "170px", cell: (report) => <span className="archive-row__app">{appBuildLabel(report.context) ?? "—"}</span> },
    { key: "received", header: "Received", width: "100px", cell: (report) => <time dateTime={report.createdAt}>{shortDate(report.createdAt)}</time> },
    { key: "archived", header: "Archived", width: "100px", cell: (report) => report.archivedAt ? <time dateTime={report.archivedAt}>{shortDate(report.archivedAt)}</time> : "—" },
    {
      key: "deletes", header: "Deleted in", width: "100px",
      cell: (report) => {
        if (!report.archivedAt) return "—";
        const days = daysLeft(report.archivedAt);
        return <span className={`days-left${days <= 7 ? " days-left--soon" : ""}`} title={`Deleted for good on ${shortDate(deletesOn(report.archivedAt))}`}>{days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"}`}</span>;
      },
    },
    {
      key: "actions", header: <span className="sr-only">Actions</span>, width: "110px", align: "right",
      cell: (report) => (
        <button type="button" className="button button--ghost button--small" disabled={restoring.has(report.id)}
          onClick={(event) => { event.stopPropagation(); void restore(report); }}
          onKeyDown={(event) => event.stopPropagation()}
          aria-label={`Restore report: ${report.message.slice(0, 60)}`}>
          {restoring.has(report.id) ? <Spinner small /> : <Icon name="undo" size={14} />} Restore
        </button>
      ),
    },
  ];

  const loading = state.reports === null;
  const empty = !loading && state.reports!.length === 0 && !state.error;
  const selected = state.reports?.find((report) => report.id === selectedId);

  return (
    <section className="page" aria-labelledby="archive-title">
      <PageHeader
        id="archive-title"
        eyebrow="Player feedback"
        title="Archive"
        lede={<>Done reports cleared from the board. Open one to read it, or restore it to Done. Each report and its screenshot are deleted for good {ARCHIVE_RETENTION_DAYS} days after it was archived.</>}
        actions={<>
          <label className="search">
            <Icon name="search" size={17} />
            <input ref={searchBox} type="search" placeholder="Search messages, parks, builds" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} aria-label="Search the archive" />
            <kbd className="kbd" aria-hidden="true">/</kbd>
          </label>
          <button type="button" className="icon-button" onClick={() => setRevision((value) => value + 1)} aria-label="Refresh archive" title="Refresh"><Icon name="refresh" /></button>
        </>}
      />

      {state.error && <Notice tone="error" action={<button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Try again</button>}>{state.error}</Notice>}

      {empty && !search ? (
        <EmptyState title="Nothing archived yet" pose="sleep">
          <p className="muted">Use Clear done on the board's Done column. Cleared reports wait here for {ARCHIVE_RETENTION_DAYS} days in case you need them back.</p>
        </EmptyState>
      ) : (
        <>
          <p className="archive-count muted" aria-live="polite">
            {loading ? "Loading..." : state.total === null ? "" : search ? `${state.total} ${state.total === 1 ? "match" : "matches"} for "${search}"` : `${state.total} archived ${state.total === 1 ? "report" : "reports"}`}
          </p>
          <Table
            caption="Archived feedback reports"
            columns={columns}
            rows={state.reports}
            rowKey={(report) => report.id}
            onRowClick={(report) => setSelectedId(report.id)}
            empty={<>No archived reports match "{search}".</>}
          />
          {state.nextCursor && (
            <div className="archive-more">
              <button type="button" className="button button--ghost" onClick={() => void loadMore()} disabled={state.loadingMore}>
                {state.loadingMore ? <><Spinner small /> Loading</> : "Load older archives"}
              </button>
            </div>
          )}
        </>
      )}

      <FeedbackDrawer reportId={selectedId} summary={selected} onClose={() => setSelectedId(null)} onRestore={restore} />
    </section>
  );
}
