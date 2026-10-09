import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { Card, formatCount, fullDate, Icon, Notice, PageHeader, Spinner, Table, Tabs, timeAgo, useToast, type Column } from "../ui";
import { AccountDrawer } from "./AccountDrawer";
import type { AccountRow, DeletionRow, DeletionSetup } from "./types";

type ListResponse = { accounts: AccountRow[]; nextCursor: string | null; deletion: DeletionSetup };
const STATES = [{ id: "", label: "All" }, { id: "active", label: "Active" }, { id: "deleting", label: "Deleting" }];

export function providerLabel(providers: string[]): string {
  if (!providers.length) return "None";
  return providers.map((provider) => (provider === "google" ? "Google" : provider === "email" ? "Email" : provider)).join(", ");
}

/** The account's handle, or a short ID for accounts that never picked one. */
export function AccountName({ handle, id }: { handle: string | null; id: string }) {
  return handle ? <strong className="an-handle">@{handle}</strong> : <span className="muted an-mono" title={id}>No handle · {id.slice(0, 8)}</span>;
}

const COLUMNS: Column<AccountRow>[] = [
  { key: "handle", header: "Player", cell: (row) => <AccountName handle={row.handle} id={row.id} /> },
  { key: "created", header: "Created", cell: (row) => <span title={fullDate(row.createdAt)}>{timeAgo(row.createdAt)}</span>, width: "110px" },
  { key: "active", header: "Last active", cell: (row) => (row.lastActiveAt ? <span title={fullDate(row.lastActiveAt)}>{timeAgo(row.lastActiveAt)}</span> : <span className="muted">Never</span>), width: "110px" },
  { key: "provider", header: "Sign-in", cell: (row) => providerLabel(row.providers), width: "100px" },
  { key: "visits", header: "Visits", cell: (row) => formatCount(row.visits), align: "right", width: "80px" },
  { key: "held", header: "Held", cell: (row) => formatCount(row.parksHeld), align: "right", width: "70px" },
  { key: "score", header: "Score", cell: (row) => formatCount(row.score), align: "right", width: "80px" },
  { key: "founded", header: "Founded", cell: (row) => (row.foundedParks === null ? <span className="muted" title="Not in this database yet">n/a</span> : formatCount(row.foundedParks)), align: "right", width: "84px" },
  { key: "state", header: "State", cell: (row) => <span className={`an-pill an-pill--${row.deletionState}`}>{row.deletionState === "deleting" ? "Deleting" : "Active"}</span>, width: "96px" },
];

/** Every account in the database on screen. Emails stay out of the list; the panel masks them. */
export function AccountsPage() {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [state, setState] = useState("");
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [setup, setSetup] = useState<DeletionSetup | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [deletions, setDeletions] = useState<DeletionRow[]>([]);
  const [resuming, setResuming] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const searchBox = useRef<HTMLInputElement>(null);

  const params = useCallback((cursor: string | null) => {
    const value = new URLSearchParams();
    if (query) value.set("q", query);
    if (state) value.set("state", state);
    if (cursor) value.set("cursor", cursor);
    return value.toString();
  }, [query, state]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setRows(null);
    setError("");
    api<ListResponse>(`/api/analytics/accounts?${params(null)}`, { signal: controller.signal })
      .then((result) => { setRows(result.accounts); setNextCursor(result.nextCursor); setSetup(result.deletion); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) { setRows([]); setError(errorText(reason, "Could not load accounts.")); } });
    api<{ deletions: DeletionRow[] }>("/api/analytics/deletions", { signal: controller.signal })
      .then((result) => setDeletions(result.deletions))
      .catch(() => undefined);
    return () => controller.abort();
  }, [params, revision]);

  // "/" jumps to the search box, as in most dashboards.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      searchBox.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const result = await api<ListResponse>(`/api/analytics/accounts?${params(nextCursor)}`);
      setRows((current) => [...(current ?? []), ...result.accounts]);
      setNextCursor(result.nextCursor);
    } catch (reason) {
      toast.show(errorText(reason, "Could not load more accounts."), { tone: "error" });
    } finally {
      setLoadingMore(false);
    }
  }

  async function resume(row: DeletionRow) {
    setResuming(row.receiptId);
    try {
      const result = await api<{ status: "pending" | "complete" }>(`/api/analytics/deletions/${row.receiptId}/resume`, { method: "POST" });
      toast.show(result.status === "complete" ? "Deletion finished. The account and its photos are gone." : "Still waiting on the photo service. Try again later.", { tone: result.status === "complete" ? "info" : "error" });
      setRevision((value) => value + 1);
    } catch (reason) {
      toast.show(errorText(reason, "Could not resume the deletion."), { tone: "error" });
    } finally {
      setResuming(null);
    }
  }

  const deletionColumns: Column<DeletionRow>[] = [
    { key: "who", header: "Account", cell: (row) => <AccountName handle={row.handle} id={row.accountId} /> },
    { key: "started", header: "Started", cell: (row) => <span title={fullDate(row.createdAt)}>{timeAgo(row.createdAt)}</span>, width: "110px" },
    { key: "photos", header: "Photos left", cell: (row) => formatCount(row.photoObjects), align: "right", width: "110px" },
    { key: "attempts", header: "Attempts", cell: (row) => formatCount(row.attempts), align: "right", width: "96px" },
    { key: "error", header: "Last problem", cell: (row) => row.lastError ?? (row.accountState === "gone" ? "Account removed, receipt still open" : <span className="muted">None yet</span>) },
    {
      key: "resume", header: <span className="sr-only">Resume</span>, width: "120px", align: "right",
      cell: (row) => (
        <button type="button" className="button button--small" disabled={!setup?.available || resuming === row.receiptId} onClick={(event) => { event.stopPropagation(); void resume(row); }}
          title={setup?.available ? "Run the photo and data cleanup again" : "Account deletion is not set up on this deployment"}>
          {resuming === row.receiptId ? <Spinner small /> : <Icon name="refresh" size={15} />} Resume
        </button>
      ),
    },
  ];

  return (
    <section className="page analytics" aria-labelledby="accounts-title">
      <PageHeader
        id="accounts-title"
        eyebrow="Analytics"
        title="Accounts"
        lede="Every Parkdex account in this database. Search by handle, account ID or full email address. Emails are never listed."
      />

      {setup && !setup.available && (
        <Notice>
          Deleting accounts is off on this deployment. Add {setup.missing.map((name, index) => <span key={name}>{index ? " and " : ""}<code>{name}</code></span>)} to the dashboard's Preview environment so private photos are deleted with the account.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="an-filters an-filters--accounts" role="search" aria-label="Find accounts">
        <label className="search">
          <Icon name="search" size={17} />
          <input ref={searchBox} type="search" placeholder="Handle, account ID or email" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search accounts" />
          <kbd className="an-kbd" aria-hidden="true">/</kbd>
        </label>
        <Tabs label="Account state" value={state} onChange={setState} items={STATES} />
        <span className="spacer" />
        <span className="muted an-small">{rows ? `${formatCount(rows.length)}${nextCursor ? "+" : ""} ${rows.length === 1 ? "account" : "accounts"}` : ""}</span>
      </div>

      {deletions.length > 0 && (
        <Card className="an-deletions" padded={false} title={`Deletions in progress (${deletions.length})`} subtitle="These accounts are signed out and hidden from the game. Their private photos are still waiting on the photo service.">
          <Table caption="Deletions in progress" columns={deletionColumns} rows={deletions} rowKey={(row) => row.receiptId} onRowClick={(row) => row.accountState !== "gone" && setSelected(row.accountId)} />
        </Card>
      )}

      <Table
        caption="Accounts"
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.id}
        onRowClick={(row) => setSelected(row.id)}
        empty={query ? <>No account matches <strong>{query}</strong>. Search needs a handle fragment, a full account ID or a full email.</> : "No accounts in this database yet."}
      />
      <div className="an-list-foot">
        <span className="muted">{rows ? `${formatCount(rows.length)} ${rows.length === 1 ? "account" : "accounts"} shown, newest first` : ""}</span>
        {nextCursor && <button type="button" className="button button--small" onClick={loadMore} disabled={loadingMore}>{loadingMore ? <Spinner small /> : <Icon name="download" size={15} />} Load 50 more</button>}
      </div>

      <AccountDrawer accountId={selected} setup={setup} onClose={() => setSelected(null)} onChanged={() => setRevision((value) => value + 1)} />
    </section>
  );
}
