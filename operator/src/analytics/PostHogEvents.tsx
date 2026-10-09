import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api, ApiError, errorText } from "../api";
import { Card, EmptyState, formatCount, Icon, Notice, Spinner } from "../ui";
import { TimeChart } from "./charts";
import type { PostHogStatus, QueryResult } from "./types";

const TEMPLATES = [
  { id: "events_per_day", label: "Events per day", hint: "All app events and distinct people per day." },
  { id: "top_events", label: "Top events", hint: "The 100 most frequent event names." },
  { id: "taps", label: "Taps", hint: "Autocaptured taps by screen and button text." },
  { id: "screens", label: "Screens", hint: "Screen and page views by screen." },
  { id: "person_events", label: "One person", hint: "Recent events for one account ID or installation ID." },
  { id: "recent_events", label: "Recent events", hint: "The newest raw events, 100 at a time." },
] as const;
type TemplateId = typeof TEMPLATES[number]["id"];

const DAYS = [1, 7, 30, 90];
const SHOWN_ROWS = 1000;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function cell(value: unknown) {
  if (value === null || value === undefined || value === "") return <span className="muted">—</span>;
  if (typeof value === "number") return formatCount(value);
  if (typeof value === "string" && STAMP.test(value)) return <span title={value}>{TIME.format(new Date(value))}</span>;
  if (typeof value === "object") return <code className="an-small">{JSON.stringify(value)}</code>;
  return String(value);
}

function ResultTable({ result, caption }: { result: QueryResult; caption: string }) {
  if (!result.rows.length) return <p className="muted an-result-empty">No rows. PostHog had no matching events for this query.</p>;
  const numeric = result.columns.map((_, index) => result.rows.every((row) => row[index] === null || typeof row[index] === "number"));
  return (
    <>
      <div className="table-wrap an-table-wrap--scroll">
        <table className="table an-table--dense">
          <caption className="sr-only">{caption}</caption>
          <thead><tr>{result.columns.map((column, index) => <th key={column + index} scope="col" style={{ textAlign: numeric[index] ? "right" : "left" }}>{column}</th>)}</tr></thead>
          <tbody>
            {result.rows.slice(0, SHOWN_ROWS).map((row, rowIndex) => (
              <tr key={rowIndex}>{row.map((value, index) => <td key={index} className="an-small" style={{ textAlign: numeric[index] ? "right" : "left" }}>{cell(value)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted an-small">{formatCount(result.rows.length)} {result.rows.length === 1 ? "row" : "rows"}{result.rows.length > SHOWN_ROWS ? `, first ${formatCount(SHOWN_ROWS)} shown` : ""}{result.hasMore ? ". More rows exist; narrow the query." : "."}</p>
    </>
  );
}

/** Seconds left on PostHog's back-off, counting down so the operator knows when to retry. */
function useCountdown(): [number, (seconds: number) => void] {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until, now]);
  return [Math.max(0, Math.ceil((until - now) / 1000)), (seconds) => { setNow(Date.now()); setUntil(Date.now() + seconds * 1000); }];
}

function retrySeconds(reason: unknown): number | null {
  if (!(reason instanceof ApiError) || reason.status !== 429) return null;
  const match = /(\d+) second/.exec(reason.message);
  return match ? Number(match[1]) : 60;
}

function SetupCard({ status }: { status: PostHogStatus }) {
  return (
    <Card title="Connect PostHog" subtitle="App taps and screen views live in PostHog. The dashboard reads them with a personal API key that never reaches the browser.">
      <div className="an-setup">
        <ol className="an-setup__steps">
          <li>In PostHog, open <strong>Settings, Personal API keys</strong> and create a key with the <strong>Query Read</strong> scope, limited to the Parkdex project.</li>
          <li>Copy the project's numeric ID from <strong>Settings, Project</strong>.</li>
          <li>In Vercel, open the <strong>parkdex-operator</strong> project and add these to the <strong>Preview</strong> environment only:
            <ul className="an-setup__vars">
              <li><code>POSTHOG_PERSONAL_API_KEY</code> (sensitive){status.missing.includes("POSTHOG_PERSONAL_API_KEY") && <span className="an-pill an-pill--todo">missing</span>}</li>
              <li><code>POSTHOG_PROJECT_ID</code>{status.missing.includes("POSTHOG_PROJECT_ID") && <span className="an-pill an-pill--todo">missing</span>}</li>
              <li><code>POSTHOG_APP_HOST</code>, only if the project is not on <code>https://us.posthog.com</code></li>
            </ul>
          </li>
          <li>Redeploy the dashboard so the new settings load.</li>
        </ol>
        {status.problem && <Notice tone="error">{status.problem}</Notice>}
      </div>
    </Card>
  );
}

/** App events from PostHog: fixed queries plus a guarded HogQL box. */
export function PostHogEvents() {
  const initialPerson = new URLSearchParams(window.location.search).get("person") ?? "";
  const [status, setStatus] = useState<PostHogStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [template, setTemplate] = useState<TemplateId>(initialPerson ? "person_events" : "events_per_day");
  const [days, setDays] = useState(7);
  const [person, setPerson] = useState(initialPerson);
  const [eventName, setEventName] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [waitSeconds, startWait] = useCountdown();
  const [revision, setRevision] = useState(0);
  const [sql, setSql] = useState("SELECT event, count() AS events\nFROM events\nWHERE timestamp > now() - INTERVAL 7 DAY\nGROUP BY event\nORDER BY events DESC");
  const [limit, setLimit] = useState(500);
  const [sqlResult, setSqlResult] = useState<QueryResult | null>(null);
  const [sqlError, setSqlError] = useState("");
  const [sqlRunning, setSqlRunning] = useState(false);

  useEffect(() => {
    api<PostHogStatus>("/api/analytics/posthog/status").then(setStatus).catch((reason: unknown) => setStatusError(errorText(reason, "Could not check the PostHog setup.")));
  }, []);

  const needsPerson = template === "person_events" && !person.trim();

  useEffect(() => {
    if (!status?.configured || needsPerson) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRunning(true);
      setError("");
      api<{ result: QueryResult }>("/api/analytics/posthog/query", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ template, days, distinctId: template === "person_events" ? person.trim() : undefined, event: template === "recent_events" && eventName.trim() ? eventName.trim() : undefined }),
      })
        .then((response) => setResult(response.result))
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setResult(null);
          const wait = retrySeconds(reason);
          if (wait) startWait(wait);
          setError(errorText(reason, "PostHog could not run that query."));
        })
        .finally(() => { if (!controller.signal.aborted) setRunning(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [status?.configured, template, days, person, eventName, needsPerson, revision]);

  async function older() {
    if (!result?.nextCursor) return;
    setRunning(true);
    try {
      const response = await api<{ result: QueryResult }>("/api/analytics/posthog/query", {
        method: "POST",
        body: JSON.stringify({ template, days, before: result.nextCursor, distinctId: template === "person_events" ? person.trim() : undefined, event: template === "recent_events" && eventName.trim() ? eventName.trim() : undefined }),
      });
      setResult({ ...response.result, rows: [...result.rows, ...response.result.rows] });
    } catch (reason) {
      const wait = retrySeconds(reason);
      if (wait) startWait(wait);
      setError(errorText(reason, "Could not load older events."));
    } finally {
      setRunning(false);
    }
  }

  async function runSql() {
    if (sqlRunning || waitSeconds) return;
    setSqlRunning(true);
    setSqlError("");
    try {
      setSqlResult((await api<{ result: QueryResult }>("/api/analytics/posthog/sql", { method: "POST", body: JSON.stringify({ query: sql, limit }) })).result);
    } catch (reason) {
      setSqlResult(null);
      const wait = retrySeconds(reason);
      if (wait) startWait(wait);
      setSqlError(errorText(reason, "PostHog could not run that query."));
    } finally {
      setSqlRunning(false);
    }
  }

  const onSqlKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void runSql();
    }
  };

  const chart = useMemo(() => {
    if (template !== "events_per_day" || !result || result.columns[0] !== "day") return null;
    const x = result.rows.map((row) => new Date(`${String(row[0]).slice(0, 10)}T12:00:00`).getTime() / 1000);
    return { x, series: [{ label: "Events", values: result.rows.map((row) => Number(row[1]) || 0), color: "--grape" }, { label: "People", values: result.rows.map((row) => Number(row[2]) || 0), color: "--moss" }] };
  }, [template, result]);
  const peopleChart = useMemo(() => chart && { x: chart.x, series: [chart.series[1]] }, [chart]);
  const eventsChart = useMemo(() => chart && { x: chart.x, series: [chart.series[0]] }, [chart]);

  if (statusError) return <Notice tone="error">{statusError}</Notice>;
  if (!status) return <div className="table-wrap"><div className="table__state"><Spinner small /> Checking the PostHog setup...</div></div>;
  if (!status.configured) return <SetupCard status={status} />;

  const current = TEMPLATES.find((item) => item.id === template)!;
  return (
    <div className="an-posthog">
      <p className="muted an-posthog__source"><Icon name="database" size={15} /> App events from <strong>{status.host}</strong> where <code>environment = '{status.environment}'</code>, following the database toggle.</p>
      {waitSeconds > 0 && <Notice tone="error">PostHog's query budget is used up. Queries can run again in {waitSeconds} {waitSeconds === 1 ? "second" : "seconds"}.</Notice>}

      <div className="an-filters" role="group" aria-label="App event query">
        <div className="an-segmented" role="group" aria-label="Query">
          {TEMPLATES.map((item) => (
            <button key={item.id} type="button" className={template === item.id ? "is-on" : ""} aria-pressed={template === item.id} onClick={() => { setResult(null); setTemplate(item.id); }}>{item.label}</button>
          ))}
        </div>
        <select className="select" aria-label="Days" value={days} onChange={(event) => setDays(Number(event.target.value))}>
          {DAYS.map((value) => <option key={value} value={value}>Last {value === 1 ? "day" : `${value} days`}</option>)}
        </select>
        {template === "person_events" && (
          <label className="search an-search--compact an-search--wide"><Icon name="user" size={15} /><input type="search" placeholder="Account ID or installation ID" aria-label="Person" value={person} onChange={(event) => setPerson(event.target.value)} /></label>
        )}
        {template === "recent_events" && (
          <label className="search an-search--compact"><Icon name="activity" size={15} /><input type="search" placeholder="Only this event, e.g. $autocapture" aria-label="Event name" value={eventName} onChange={(event) => setEventName(event.target.value)} /></label>
        )}
        <span className="spacer" />
        <button type="button" className="icon-button" aria-label="Run again" title="Run again" disabled={running || waitSeconds > 0} onClick={() => setRevision((value) => value + 1)}><Icon name="refresh" size={17} /></button>
      </div>

      {error && !waitSeconds && <Notice tone="error">{error}</Notice>}

      <Card title={current.label} subtitle={current.hint} actions={running ? <Spinner small /> : undefined}>
        {needsPerson ? (
          <EmptyState compact title="Who should we look up?" pose="think">
            <p className="muted">Enter an account ID (signed-in players) or an installation ID (anyone). Open an account on the Accounts page to jump here with its ID filled in.</p>
          </EmptyState>
        ) : !result ? (
          <div className="an-chart an-chart--loading an-chart--short" aria-hidden="true" />
        ) : (
          <>
            {eventsChart && peopleChart && (
              <div className="an-chart-pair">
                <TimeChart label="App events per day" x={eventsChart.x} series={eventsChart.series} kind="bars" height={170} />
                <TimeChart label="People per day" x={peopleChart.x} series={peopleChart.series} kind="line" height={170} />
              </div>
            )}
            <ResultTable result={result} caption={current.label} />
            {result.nextCursor && (
              <div className="an-list-foot">
                <span />
                <button type="button" className="button button--small" onClick={older} disabled={running || waitSeconds > 0}>{running ? <Spinner small /> : <Icon name="download" size={15} />} Load older</button>
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Custom HogQL" subtitle="One SELECT, read-only. The dashboard wraps it in a LIMIT, and every run counts toward PostHog's 240 queries a minute." className="an-hogql">
        <textarea className="an-hogql__input" spellCheck={false} value={sql} onChange={(event) => setSql(event.target.value)} onKeyDown={onSqlKey} aria-label="HogQL query" rows={6} />
        <div className="an-hogql__bar">
          <label className="field an-field--inline"><span>Row limit</span><input type="number" min={1} max={10000} value={limit} onChange={(event) => setLimit(Number(event.target.value))} /></label>
          <span className="muted an-small">Ctrl+Enter runs it. No comments, no second statement, no placeholders.</span>
          <span className="spacer" />
          <button type="button" className="button button--small button--primary" onClick={runSql} disabled={sqlRunning || waitSeconds > 0}>{sqlRunning ? <Spinner small /> : <Icon name="chevron" size={15} />} Run query</button>
        </div>
        {sqlError && <Notice tone="error">{sqlError}</Notice>}
        {sqlResult && <ResultTable result={sqlResult} caption="Custom query result" />}
      </Card>
    </div>
  );
}
