import { HttpError } from "../http.js";

/**
 * App events from PostHog through its query API. The personal API key stays on the server: the
 * browser only ever picks a fixed template and its parameters, or sends a SELECT that is checked
 * and wrapped in a forced LIMIT here.
 *
 * PostHog limits: up to 50,000 rows per query, 240 queries a minute and 3 at a time per
 * project. A 429 (api_queries_budget_exceeded) is passed on with its retry time, and this
 * instance stops calling PostHog until then.
 */

export interface PostHogEnv {
  /** Personal API key with the "Query Read" scope for the Parkdex project (sensitive). */
  POSTHOG_PERSONAL_API_KEY?: string;
  /** Numeric project ID from the PostHog project settings. */
  POSTHOG_PROJECT_ID?: string;
  /** App host for the query API, https://us.posthog.com unless the project is elsewhere. */
  POSTHOG_APP_HOST?: string;
}

export const DEFAULT_POSTHOG_HOST = "https://us.posthog.com";
export const MAX_ROWS = 50_000;
export const CUSTOM_DEFAULT_LIMIT = 500;
export const CUSTOM_MAX_LIMIT = 10_000;
const PAGE = 100;
const DAY_MS = 86_400_000;

export interface PostHogConfig {
  host: string;
  projectId: string;
  key: string;
}

export interface PostHogStatus {
  configured: boolean;
  host: string;
  /** Names of the settings still to add, in the order the setup steps mention them. */
  missing: string[];
  problem: string | null;
}

export function posthogStatus(env: PostHogEnv): PostHogStatus {
  const host = (env.POSTHOG_APP_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
  const missing: string[] = [];
  if (!env.POSTHOG_PERSONAL_API_KEY?.trim()) missing.push("POSTHOG_PERSONAL_API_KEY");
  if (!env.POSTHOG_PROJECT_ID?.trim()) missing.push("POSTHOG_PROJECT_ID");
  let problem: string | null = null;
  if (env.POSTHOG_PROJECT_ID?.trim() && !/^\d{1,12}$/.test(env.POSTHOG_PROJECT_ID.trim())) problem = "POSTHOG_PROJECT_ID must be the numeric project ID.";
  try {
    const url = new URL(host);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) problem = "POSTHOG_APP_HOST must be an https origin such as https://us.posthog.com.";
  } catch {
    problem = "POSTHOG_APP_HOST must be an https origin such as https://us.posthog.com.";
  }
  return { configured: missing.length === 0 && !problem, host, missing, problem };
}

export function posthogConfig(env: PostHogEnv): PostHogConfig | null {
  const status = posthogStatus(env);
  if (!status.configured) return null;
  return { host: status.host, projectId: env.POSTHOG_PROJECT_ID!.trim(), key: env.POSTHOG_PERSONAL_API_KEY!.trim() };
}

export interface HogQL {
  query: string;
  values?: Record<string, string | number>;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** True when the row cap cut the result short. */
  hasMore: boolean;
  /** For the paged templates: pass back as `before` to get the next page. */
  nextCursor: string | null;
}

export const TEMPLATES = ["events_per_day", "top_events", "taps", "screens", "person_events", "recent_events"] as const;
export type TemplateName = typeof TEMPLATES[number];

export interface TemplateParams {
  days: number;
  /** For person_events: the account ID or installation ID PostHog knows the person by. */
  distinctId?: string;
  /** For recent_events: only this event name. */
  event?: string;
  /** For the paged templates: the timestamp of the last row of the previous page. */
  before?: string;
}

const DISTINCT_ID = /^[A-Za-z0-9._:@-]{1,200}$/;
const EVENT_NAME = /^[$A-Za-z0-9_ .:-]{1,120}$/;

function since(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/** Builds one of the fixed queries. Every value the operator typed is a HogQL placeholder, never text in the query. */
export function buildTemplate(name: string, params: TemplateParams, environment: string, now: Date): HogQL {
  if (!(TEMPLATES as readonly string[]).includes(name)) throw new HttpError(400, "invalid_query", "Unknown PostHog query.");
  if (!Number.isInteger(params.days) || params.days < 1 || params.days > 90) throw new HttpError(400, "invalid_query", "Days must be 1 to 90.");
  const values: Record<string, string | number> = { since: since(now, params.days), environment };
  const scope = "timestamp >= toDateTime({since}) AND properties.environment = {environment}";
  switch (name as TemplateName) {
    case "events_per_day":
      return {
        query: `SELECT toDate(timestamp) AS day, count() AS events, uniq(distinct_id) AS people
FROM events WHERE ${scope}
GROUP BY day ORDER BY day`,
        values,
      };
    case "top_events":
      return {
        query: `SELECT event, count() AS events, uniq(distinct_id) AS people
FROM events WHERE ${scope}
GROUP BY event ORDER BY events DESC LIMIT 100`,
        values,
      };
    case "taps":
      return {
        query: `SELECT coalesce(properties.$screen_name, properties.$pathname, properties.$current_url) AS screen,
  properties.$el_text AS label, count() AS taps, uniq(distinct_id) AS people
FROM events WHERE event = '$autocapture' AND ${scope}
GROUP BY screen, label ORDER BY taps DESC LIMIT 200`,
        values,
      };
    case "screens":
      return {
        query: `SELECT coalesce(properties.$screen_name, properties.$pathname, properties.$current_url) AS screen,
  count() AS views, uniq(distinct_id) AS people
FROM events WHERE event IN ('$pageview', '$screen') AND ${scope}
GROUP BY screen ORDER BY views DESC LIMIT 200`,
        values,
      };
    case "person_events":
    case "recent_events": {
      const filters = [scope];
      if (name === "person_events") {
        if (!params.distinctId || !DISTINCT_ID.test(params.distinctId)) throw new HttpError(400, "invalid_query", "Enter the person's account ID or installation ID.");
        values.distinctId = params.distinctId;
        filters.push("distinct_id = {distinctId}");
      }
      if (params.event) {
        if (!EVENT_NAME.test(params.event)) throw new HttpError(400, "invalid_query", "That is not an event name.");
        values.event = params.event;
        filters.push("event = {event}");
      }
      // PostHog rejects OFFSET on large results, so pages continue from the last timestamp.
      if (params.before) {
        if (!Number.isFinite(Date.parse(params.before))) throw new HttpError(400, "invalid_cursor", "Invalid PostHog cursor.");
        values.before = new Date(params.before).toISOString();
        filters.push("timestamp < toDateTime({before})");
      }
      return {
        query: `SELECT timestamp, event, distinct_id,
  coalesce(properties.$screen_name, properties.$pathname) AS screen, properties.$el_text AS label,
  properties.app_version AS app_version, properties.platform AS platform, properties.$current_url AS url
FROM events WHERE ${filters.join(" AND ")}
ORDER BY timestamp DESC LIMIT ${PAGE}`,
        values,
      };
    }
  }
}

// Statement keywords only; "set" is left out because properties.$set is a normal PostHog column.
const BLOCKED = /\b(insert|update|delete|alter|drop|create|truncate|grant|revoke|system|attach|detach|optimize|rename|kill)\b/i;

/**
 * Accepts one SELECT (or WITH ... SELECT) and returns it wrapped so at most `limit` rows come
 * back. HogQL itself is read-only; this only stops other statements, comments that could hide
 * part of the query, and unbounded results.
 */
export function guardCustomQuery(text: unknown, limit: unknown): HogQL {
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "invalid_query", "Write a SELECT query.");
  if (text.length > 8000) throw new HttpError(400, "invalid_query", "Keep the query under 8,000 characters.");
  const rows = limit === undefined || limit === null ? CUSTOM_DEFAULT_LIMIT : Number(limit);
  if (!Number.isInteger(rows) || rows < 1 || rows > CUSTOM_MAX_LIMIT) throw new HttpError(400, "invalid_query", `Limit must be 1 to ${CUSTOM_MAX_LIMIT.toLocaleString("en-US")}.`);
  const query = text.trim().replace(/;\s*$/, "");
  // Keywords inside string literals are fine, so check the query with its strings blanked out.
  const bare = query.replace(/'(?:[^'\\]|\\.|'')*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`[^`]*`/g, "``");
  if (/--|\/\*|#/.test(bare)) throw new HttpError(400, "invalid_query", "Remove comments from the query.");
  if (bare.includes(";")) throw new HttpError(400, "invalid_query", "Send one query at a time.");
  if (!/^\s*(select|with)\b/i.test(bare)) throw new HttpError(400, "invalid_query", "Only SELECT queries can run here.");
  const blocked = BLOCKED.exec(bare);
  if (blocked) throw new HttpError(400, "invalid_query", `${blocked[1].toUpperCase()} is not allowed here. Only SELECT queries can run.`);
  if (/\{[^}]*\}/.test(bare)) throw new HttpError(400, "invalid_query", "Placeholders like {name} are only for the built-in queries.");
  return { query: `SELECT * FROM (\n${query}\n) LIMIT ${rows}` };
}

/** Per-instance pacing: Edge instances do not share memory, so PostHog's own 429 is the real guard. */
class Pacer {
  private active = 0;
  private waiting: (() => void)[] = [];
  private started: number[] = [];
  blockedUntil = 0;

  async acquire(now: () => number): Promise<void> {
    const at = now();
    if (this.blockedUntil > at) throw rateLimited(Math.ceil((this.blockedUntil - at) / 1000));
    this.started = this.started.filter((time) => at - time < 60_000);
    if (this.started.length >= 240) throw rateLimited(Math.ceil((this.started[0] + 60_000 - at) / 1000));
    if (this.active >= 3) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    this.started.push(now());
  }

  release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

const pacer = new Pacer();

function rateLimited(seconds: number): HttpError {
  const wait = Math.max(1, Math.min(seconds, 3600));
  return new HttpError(429, "posthog_rate_limited", `PostHog's query budget is used up for now. Try again in ${wait} second${wait === 1 ? "" : "s"}.`);
}

export interface RunOptions {
  fetch?: typeof fetch;
  now?(): number;
  maxRows?: number;
  signal?: AbortSignal;
  /** For the paged templates: which column holds the timestamp to continue from. */
  cursorColumn?: string;
  pageSize?: number;
}

function errorDetail(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const detail = (body as Record<string, unknown>).detail;
  return typeof detail === "string" && detail.trim() ? detail.trim().slice(0, 400) : null;
}

/** Runs HogQL against the project and returns plain columns and rows. */
export async function runHogQL(config: PostHogConfig, hogql: HogQL, options: RunOptions = {}): Promise<QueryResult> {
  const now = options.now ?? Date.now;
  await pacer.acquire(now);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${config.host}/api/projects/${encodeURIComponent(config.projectId)}/query/`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql.query, ...(hogql.values ? { values: hogql.values } : {}) }, name: "parkdex-operator" }),
        // The Edge runtime refuses redirect "error"; a redirect is treated as no answer instead.
        redirect: "manual",
        signal: options.signal,
      });
    } catch {
      throw new HttpError(502, "posthog_unreachable", "PostHog did not answer. Try again in a moment.");
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new HttpError(502, "posthog_unreachable", "PostHog did not answer. Try again in a moment.");
    }
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* PostHog error pages are not always JSON. */ }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
      pacer.blockedUntil = now() + seconds * 1000;
      throw rateLimited(seconds);
    }
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, "posthog_forbidden", "PostHog refused the key. Check that POSTHOG_PERSONAL_API_KEY has the Query Read scope for this project.");
    }
    if (response.status === 404) throw new HttpError(502, "posthog_not_found", "PostHog has no project with that POSTHOG_PROJECT_ID.");
    if (response.status === 400) throw new HttpError(400, "posthog_query_error", errorDetail(body) ?? "PostHog could not run that query.");
    if (!response.ok || typeof body !== "object" || body === null) throw new HttpError(502, "posthog_error", "PostHog could not run that query right now.");
    const record = body as Record<string, unknown>;
    const columns = Array.isArray(record.columns) ? record.columns.map(String) : [];
    const all = Array.isArray(record.results) ? record.results.filter(Array.isArray) as unknown[][] : [];
    const maxRows = Math.min(options.maxRows ?? MAX_ROWS, MAX_ROWS);
    const rows = all.slice(0, maxRows);
    let nextCursor: string | null = null;
    if (options.cursorColumn && rows.length >= (options.pageSize ?? PAGE)) {
      const index = columns.indexOf(options.cursorColumn);
      const last = index >= 0 ? rows[rows.length - 1][index] : null;
      if (typeof last === "string" && Number.isFinite(Date.parse(last))) nextCursor = last;
    }
    return { columns, rows, hasMore: all.length > rows.length || record.hasMore === true, nextCursor };
  } finally {
    pacer.release();
  }
}

/** Clears the per-instance back-off, for tests. */
export function resetPostHogPacing(): void {
  pacer.blockedUntil = 0;
}

/** What the route runs; the demo swaps in sample data. */
export interface PostHogClient {
  status(): PostHogStatus;
  template(name: string, params: TemplateParams, environment: string, now: Date): Promise<QueryResult>;
  custom(text: unknown, limit: unknown): Promise<QueryResult>;
}

export function createPostHogClient(env: PostHogEnv, fetchFn?: typeof fetch): PostHogClient {
  const config = () => {
    const value = posthogConfig(env);
    if (!value) throw new HttpError(503, "posthog_not_configured", "PostHog is not set up on this deployment yet.");
    return value;
  };
  return {
    status: () => posthogStatus(env),
    async template(name, params, environment, now) {
      const hogql = buildTemplate(name, params, environment, now);
      const paged = name === "person_events" || name === "recent_events";
      return runHogQL(config(), hogql, { fetch: fetchFn, cursorColumn: paged ? "timestamp" : undefined, pageSize: PAGE });
    },
    async custom(text, limit) {
      const hogql = guardCustomQuery(text, limit);
      return runHogQL(config(), hogql, { fetch: fetchFn, maxRows: CUSTOM_MAX_LIMIT });
    },
  };
}
