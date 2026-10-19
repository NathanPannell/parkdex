import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { api, errorText } from "../api";
import { Card, EmptyState, formatCount, fullDate, Icon, Notice, Spinner, useToast } from "../ui";
import { TimeChart } from "./charts";
import { EVENT_TYPES, type EventRow, type EventsPage, type Histogram } from "./types";

const RANGES = [
  { id: "1h", label: "1h", ms: 3_600_000 },
  { id: "24h", label: "24h", ms: 86_400_000 },
  { id: "7d", label: "7d", ms: 7 * 86_400_000 },
  { id: "30d", label: "30d", ms: 30 * 86_400_000 },
  { id: "90d", label: "90d", ms: 90 * 86_400_000 },
] as const;

const GROUPS: Record<string, string> = {
  flag_planted: "game",
  flag_taken: "game",
  flag_held: "game",
  visit_already_today: "game",
  flag_fell: "game",
  leaderboard_viewed: "game",
  takeover_message_seen: "game",
  handle_set: "game",
  crew_joined: "game",
  crew_code_shown: "game",
  visit_logged_protected: "game",
  park_founded: "founding",
  founder_photo_checked: "founding",
  park_viewed: "app",
  directions_opened: "app",
  park_claimed: "app",
  db_read: "db",
  db_write: "db",
};

export function EventTypeTag({ type }: { type: string }) {
  return <span className={`an-event-tag an-event-tag--${GROUPS[type] ?? "app"}`}>{type}</span>;
}

type Filters = {
  range: string;
  /** datetime-local values, used when range is "custom". */
  from: string;
  to: string;
  types: string[];
  account: string;
  park: string;
  route: string;
  result: "" | "ok" | "failed";
  db: boolean;
};

const DEFAULTS: Filters = { range: "7d", from: "", to: "", types: [], account: "", park: "", route: "", result: "", db: false };

function fromUrl(): Filters {
  const params = new URLSearchParams(window.location.search);
  const range = params.get("range") ?? DEFAULTS.range;
  return {
    range: range === "custom" || RANGES.some((item) => item.id === range) ? range : DEFAULTS.range,
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    types: (params.get("type") ?? "").split(",").filter((type) => (EVENT_TYPES as readonly string[]).includes(type)),
    account: params.get("account") ?? "",
    park: params.get("park") ?? "",
    route: params.get("route") ?? "",
    result: params.get("result") === "ok" || params.get("result") === "failed" ? (params.get("result") as Filters["result"]) : "",
    db: params.get("db") === "1",
  };
}

/** The filter as the explorer's own URL, so a view can be bookmarked or linked from an account. */
function pageQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.range !== DEFAULTS.range) params.set("range", filters.range);
  if (filters.range === "custom") {
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
  }
  if (filters.types.length) params.set("type", filters.types.join(","));
  if (filters.account.trim()) params.set("account", filters.account.trim());
  if (filters.park.trim()) params.set("park", filters.park.trim());
  if (filters.route) params.set("route", filters.route);
  if (filters.result) params.set("result", filters.result);
  if (filters.db) params.set("db", "1");
  return params.toString();
}

/** The filter as the API wants it, with relative ranges turned into fixed times now. */
function apiQuery(filters: Filters, now: number): URLSearchParams {
  const params = new URLSearchParams();
  const range = RANGES.find((item) => item.id === filters.range);
  if (range) params.set("from", new Date(now - range.ms).toISOString());
  else {
    if (filters.from) params.set("from", new Date(filters.from).toISOString());
    if (filters.to) params.set("to", new Date(filters.to).toISOString());
  }
  if (filters.types.length) params.set("type", filters.types.join(","));
  if (filters.account.trim()) params.set("account", filters.account.trim());
  if (filters.park.trim()) params.set("park", filters.park.trim());
  if (filters.route) params.set("route", filters.route);
  if (filters.result) params.set("result", filters.result);
  if (filters.db) params.set("db", "1");
  return params;
}

const VICTORIA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" });
const TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** Every bucket between from and to, including empty ones, so gaps show as gaps. */
function fillBuckets(histogram: Histogram): { x: number[]; events: number[]; db: number[] } {
  const key = (time: number) => (histogram.bucket === "hour" ? String(Math.floor(time / 3_600_000)) : VICTORIA_DAY.format(new Date(time)));
  const counts = new Map(histogram.buckets.map((bucket) => [key(Date.parse(bucket.at)), bucket]));
  const x: number[] = [];
  const events: number[] = [];
  const db: number[] = [];
  const seen = new Set<string>();
  const end = Date.parse(histogram.to);
  for (let time = Math.floor(Date.parse(histogram.from) / 3_600_000) * 3_600_000; time <= end; time += 3_600_000) {
    const id = key(time);
    if (seen.has(id)) continue;
    seen.add(id);
    const bucket = counts.get(id);
    x.push(histogram.bucket === "hour" ? time / 1000 + 1800 : new Date(`${id}T12:00:00`).getTime() / 1000);
    events.push(bucket ? bucket.count - bucket.db : 0);
    db.push(bucket?.db ?? 0);
  }
  return { x, events, db };
}

function TypePicker({ value, onChange }: { value: string[]; onChange(next: string[]): void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);
  const label = value.length === 0 ? "All types" : value.length === 1 ? value[0] : `${value.length} types`;
  return (
    <details className="an-type-picker" ref={menu}>
      <summary className="select">
        <Icon name="layers" size={15} /> {label}
      </summary>
      <div className="an-type-picker__menu" role="group" aria-label="Event types">
        <button type="button" className="text-button an-small" onClick={() => onChange([])}>
          Clear (all types)
        </button>
        {EVENT_TYPES.map((type) => (
          <label key={type} className="toggle">
            <input
              type="checkbox"
              checked={value.includes(type)}
              onChange={(event) => onChange(event.target.checked ? [...value, type] : value.filter((item) => item !== type))}
            />
            <EventTypeTag type={type} />
          </label>
        ))}
      </div>
    </details>
  );
}

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "";
}

/** kip_analytics.events for the database on screen: filters, histogram, raw rows and CSV export. */
export function ServerEvents() {
  const toast = useToast();
  const [filters, setFilters] = useState<Filters>(fromUrl);
  const [typed, setTyped] = useState({ account: filters.account, park: filters.park });
  const [page, setPage] = useState<EventsPage | null>(null);
  const [histogram, setHistogram] = useState<Histogram | null>(null);
  const [routes, setRoutes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const [queryTime, setQueryTime] = useState(() => Date.now());

  const update = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  // Typing in the account and park boxes waits for a pause before querying.
  useEffect(() => {
    const timer = window.setTimeout(() => update({ account: typed.account, park: typed.park }), 350);
    return () => window.clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    api<{ routes: string[] }>("/api/analytics/events/routes")
      .then((result) => setRoutes(result.routes))
      .catch(() => undefined);
  }, []);

  const query = useMemo(() => apiQuery(filters, queryTime).toString(), [filters, queryTime]);

  useEffect(() => {
    const search = pageQuery(filters);
    const tab = new URLSearchParams(window.location.search).get("tab");
    const next = `${window.location.pathname}${search || tab ? `?${[tab ? `tab=${tab}` : "", search].filter(Boolean).join("&")}` : ""}`;
    window.history.replaceState(null, "", next);
  }, [filters]);

  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setHistogram(null);
    setError("");
    setOpen(null);
    api<EventsPage>(`/api/analytics/events?${query}`, { signal: controller.signal })
      .then(setPage)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorText(reason, "Could not load events."));
      });
    api<Histogram>(`/api/analytics/events/histogram?${query}`, { signal: controller.signal })
      .then(setHistogram)
      .catch(() => undefined);
    return () => controller.abort();
  }, [query, revision]);

  async function loadMore() {
    if (!page?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await api<EventsPage>(`/api/analytics/events?${query}&cursor=${encodeURIComponent(page.nextCursor)}`);
      setPage({ ...next, events: [...page.events, ...next.events] });
    } catch (reason) {
      toast.show(errorText(reason, "Could not load more events."), { tone: "error" });
    } finally {
      setLoadingMore(false);
    }
  }

  const chart = useMemo(() => {
    if (!histogram) return null;
    const filled = fillBuckets(histogram);
    return {
      x: filled.x,
      series: [
        { label: "Events", values: filled.events, color: "--sea" },
        ...(filters.db || filters.types.some((type) => type.startsWith("db_"))
          ? [{ label: "db_read / db_write", values: filled.db, color: "--ink-faint" }]
          : []),
      ],
      total: histogram.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    };
  }, [histogram, filters.db, filters.types]);

  const filtering = (patch: Partial<Filters>) => (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (patch.account !== undefined || patch.park !== undefined)
      setTyped((current) => ({ account: patch.account ?? current.account, park: patch.park ?? current.park }));
    update(patch);
  };

  const reset = () => {
    setTyped({ account: "", park: "" });
    setFilters(DEFAULTS);
  };

  return (
    <div className="an-server-events">
      <div className="an-filters" role="search" aria-label="Filter server events">
        <div className="an-segmented" role="group" aria-label="Time range">
          {RANGES.map((range) => (
            <button
              key={range.id}
              type="button"
              className={filters.range === range.id ? "is-on" : ""}
              aria-pressed={filters.range === range.id}
              onClick={() => {
                setQueryTime(Date.now());
                update({ range: range.id });
              }}
              title={`Last ${range.label}`}
            >
              {range.label}
            </button>
          ))}
          <button
            type="button"
            className={filters.range === "custom" ? "is-on" : ""}
            aria-pressed={filters.range === "custom"}
            onClick={() => update({ range: "custom" })}
          >
            Custom
          </button>
        </div>
        {filters.range === "custom" && (
          <>
            <label className="field an-field--inline">
              <span>From</span>
              <input type="datetime-local" value={filters.from} onChange={(event) => update({ from: event.target.value })} />
            </label>
            <label className="field an-field--inline">
              <span>To</span>
              <input type="datetime-local" value={filters.to} onChange={(event) => update({ to: event.target.value })} />
            </label>
          </>
        )}
        <TypePicker value={filters.types} onChange={(types) => update({ types })} />
        <label className="search an-search--compact">
          <Icon name="user" size={15} />
          <input
            type="search"
            placeholder="Handle or account ID"
            aria-label="Account handle or ID"
            value={typed.account}
            onChange={(event) => setTyped({ ...typed, account: event.target.value })}
          />
        </label>
        <label className="search an-search--compact">
          <Icon name="park" size={15} />
          <input
            type="search"
            placeholder="Park ID"
            aria-label="Park ID"
            value={typed.park}
            onChange={(event) => setTyped({ ...typed, park: event.target.value })}
          />
        </label>
        <select className="select" aria-label="Route" value={filters.route} onChange={(event) => update({ route: event.target.value })}>
          <option value="">All routes</option>
          {routes.map((route) => (
            <option key={route} value={route}>
              {route}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Result" value={filters.result} onChange={(event) => update({ result: event.target.value as Filters["result"] })}>
          <option value="">Any result</option>
          <option value="ok">ok</option>
          <option value="failed">Failed queries</option>
        </select>
        <label className="toggle" title="One row per database query. They outnumber every other event many times over.">
          <input type="checkbox" checked={filters.db} onChange={(event) => update({ db: event.target.checked })} /> Include db_read and db_write
        </label>
        <span className="spacer" />
        <button type="button" className="button button--small button--ghost" onClick={reset}>
          Reset
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh"
          title="Refresh"
          onClick={() => {
            setQueryTime(Date.now());
            setRevision((value) => value + 1);
          }}
        >
          <Icon name="refresh" size={17} />
        </button>
        <a className="button button--small" href={`/api/analytics/events/export?${query}`} download title="Up to 50,000 rows of the current filter">
          <Icon name="download" size={15} /> Export CSV
        </a>
      </div>

      {page && page.unavailable.length > 0 && (
        <Notice>Founder events (park_founded, founder_photo_checked) are not in this database yet ({page.unavailable.join(", ")}).</Notice>
      )}
      {page?.unknownHandle && (
        <Notice>
          No player has the handle <strong>@{page.unknownHandle}</strong> in this database, so nothing matches.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <Card
        padded
        className="an-histogram"
        title={chart ? `${formatCount(chart.total)} events` : "Events over time"}
        subtitle={histogram ? `Per ${histogram.bucket}, ${fullDate(histogram.from)} to ${fullDate(histogram.to)}` : "Loading..."}
      >
        {histogram?.dbOmitted && (
          <p className="muted an-small an-histogram__note">
            db_read and db_write are left out of the chart for ranges over 31 days; the rows below still include them.
          </p>
        )}
        {chart ? (
          <TimeChart label="Events over time" x={chart.x} series={chart.series} kind="stacked" height={170} bucket={histogram!.bucket} />
        ) : (
          <div className="an-chart an-chart--loading an-chart--short" aria-hidden="true" />
        )}
      </Card>

      {!page && !error && (
        <div className="table-wrap">
          <div className="table__state">
            <Spinner small /> Loading events...
          </div>
        </div>
      )}
      {page && page.events.length === 0 && (
        <EmptyState
          compact
          title="No events match"
          pose="sleep"
          action={
            <button type="button" className="button button--small" onClick={reset}>
              Reset filters
            </button>
          }
        >
          <p className="muted">Try a longer range{filters.db ? "" : ", or include db_read and db_write"}. Server events are kept for 90 days.</p>
        </EmptyState>
      )}
      {page && page.events.length > 0 && (
        <div className="table-wrap">
          <table className="table an-table--dense table--clickable an-table--fixed">
            <caption className="sr-only">Server events, newest first</caption>
            <thead>
              <tr>
                <th scope="col" style={{ width: 116 }}>
                  Received
                </th>
                <th scope="col" style={{ width: 196 }}>
                  Type
                </th>
                <th scope="col">Route</th>
                <th scope="col" style={{ width: 124 }}>
                  Account
                </th>
                <th scope="col" style={{ width: 168 }}>
                  Park
                </th>
                <th scope="col" style={{ width: 96, textAlign: "right" }}>
                  Result
                </th>
                <th scope="col" style={{ width: 86 }}>
                  App
                </th>
              </tr>
            </thead>
            <tbody>
              {page.events.map((event) => (
                <Fragment key={event.id}>
                  <tr
                    tabIndex={0}
                    aria-expanded={open === event.id}
                    onClick={() => setOpen(open === event.id ? null : event.id)}
                    onKeyDown={(key) => {
                      if (key.key === "Enter" || key.key === " ") {
                        key.preventDefault();
                        setOpen(open === event.id ? null : event.id);
                      }
                    }}
                  >
                    <td className="an-mono an-small" title={new Date(event.receivedAt).toLocaleString()}>
                      {TIME.format(new Date(event.receivedAt))}
                    </td>
                    <td>
                      <EventTypeTag type={event.type} />
                    </td>
                    <td className="an-mono an-small an-truncate" title={event.route ?? ""}>
                      {event.route ? (
                        <button type="button" className="an-cell-link" onClick={filtering({ route: event.route })} title="Only this route">
                          {event.route}
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="an-small">
                      {event.accountId ? (
                        <button
                          type="button"
                          className="an-cell-link"
                          onClick={filtering({ account: event.handle ?? event.accountId })}
                          title="Only this account"
                        >
                          {event.handle ? `@${event.handle}` : <span className="an-mono">{shortId(event.accountId)}</span>}
                        </button>
                      ) : (
                        <span className="muted">Signed out</span>
                      )}
                    </td>
                    <td className="an-mono an-small an-truncate">
                      {event.parkId ? (
                        <button type="button" className="an-cell-link" onClick={filtering({ park: event.parkId })} title="Only this park">
                          {event.parkId}
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="an-small" style={{ textAlign: "right" }}>
                      {event.result ? <span className={event.result === "ok" ? "an-result-ok" : "an-result-bad"}>{event.result}</span> : null}
                      {event.durationMs !== null && <span className="muted"> {event.durationMs} ms</span>}
                    </td>
                    <td className="an-mono an-small">{event.appVersion ?? ""}</td>
                  </tr>
                  {open === event.id && (
                    <tr className="an-event-detail">
                      <td colSpan={7}>
                        <EventDetail event={event} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && page.events.length > 0 && (
        <div className="an-list-foot">
          <span className="muted">{formatCount(page.events.length)} shown, newest first. Click a row for its properties.</span>
          {page.nextCursor && (
            <button type="button" className="button button--small" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? <Spinner small /> : <Icon name="download" size={15} />} Load 100 more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EventDetail({ event }: { event: EventRow }) {
  const fields: [string, string | null][] = [
    ["Event ID", event.id],
    ["Occurred", event.occurredAt ? fullDate(event.occurredAt) : null],
    ["Received", fullDate(event.receivedAt)],
    ["Account", event.accountId],
    ["Installation", event.installationId],
    ["App version", event.appVersion],
    ["Bundle", event.bundleId],
    ["Server", event.environment],
    ["Operation", event.operation],
    ["Tables", event.tables?.join(", ") ?? null],
  ];
  return (
    <div className="an-event-detail__body">
      <dl className="an-facts an-facts--compact">
        {fields
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="an-mono">{value}</dd>
            </div>
          ))}
      </dl>
      <div>
        <p className="eyebrow">Properties</p>
        <pre className="an-json">{event.properties ? JSON.stringify(event.properties, null, 2) : "None"}</pre>
      </div>
    </div>
  );
}
