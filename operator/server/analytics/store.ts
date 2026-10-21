import { neon } from "@neondatabase/serverless";
import type { SqlRunner } from "../drafts.js";
import { DB_EVENT_TYPES } from "./filters.js";
import { probeFeatures, unavailableNotes, type Features } from "./schema.js";
import type { AccountQuery, AccountRow, AnalyticsStore, DeletionRow, EventCursor, EventFilter, EventRow, HistogramBucket, Overview, Period } from "./types.js";

/**
 * Read-mostly SQL behind the analytics pages. Every read runs in a read-only transaction with a
 * statement timeout, so a slow chart can never hold locks or write by mistake. The queries are
 * bounded by time windows or LIMITs and use the indexes listed in
 * database/migrations/operator_analytics_001_indexes.sql and the analytics migrations.
 */

type Row = Record<string, unknown>;
type Statement = { text: string; params: unknown[] };
type Keyed = Statement & { key: string };

const TIME_ZONE = "America/Vancouver";
const READ_TIMEOUT = "15s";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function day(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function textArray(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String);
  // pg returns text[] as "{a,b}" when its type parser is not loaded.
  const raw = String(value);
  return raw === "{}"
    ? []
    : raw
        .replace(/^\{|\}$/g, "")
        .split(",")
        .map((item) => item.replace(/^"|"$/g, ""));
}

function period(row: Row, current: string, previous: string): Period {
  return { current: num(row[current]), previous: num(row[previous]) };
}

/** j***@g***.com: enough to recognise an address on a support call, not enough to read it off the screen. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${host[0] ?? ""}***${tld}`;
}

function providers(row: Row): string[] {
  const list: string[] = [];
  if (row.has_google === true) list.push("google");
  if (row.has_password === true) list.push("email");
  return list;
}

function accountRow(row: Row): AccountRow {
  const lastEvent = isoOrNull(row.last_event_at);
  const lastSession = isoOrNull(row.last_session_at);
  return {
    id: String(row.id),
    handle: textOrNull(row.handle),
    createdAt: iso(row.created_at),
    lastActiveAt: lastEvent && lastSession ? (lastEvent > lastSession ? lastEvent : lastSession) : (lastEvent ?? lastSession),
    providers: providers(row),
    visits: num(row.visits),
    parksHeld: num(row.parks_held),
    score: num(row.score),
    foundedParks: row.founded === null || row.founded === undefined ? null : num(row.founded),
    deletionState: row.deletion_state === "deleting" ? "deleting" : "active",
  };
}

const INTERACTION_FIELDS = ["entry_point", "provider", "travel_mode", "claim_status"] as const;

function eventRow(row: Row): EventRow {
  let properties = jsonObject(row.properties);
  // The original app interaction events keep their details in columns, not properties.
  const interaction = Object.fromEntries(INTERACTION_FIELDS.filter((key) => row[key] !== null && row[key] !== undefined).map((key) => [key, row[key]]));
  if (Object.keys(interaction).length) properties = { ...interaction, ...properties };
  return {
    id: String(row.event_id),
    type: String(row.event_type),
    occurredAt: isoOrNull(row.occurred_at ?? row.client_occurred_at),
    receivedAt: iso(row.received_at),
    route: textOrNull(row.route),
    accountId: textOrNull(row.account_id),
    handle: textOrNull(row.handle),
    installationId: textOrNull(row.installation_id),
    appVersion: textOrNull(row.app_version),
    bundleId: textOrNull(row.bundle_id),
    environment: String(row.environment),
    operation: textOrNull(row.operation),
    tables: textArray(row.tables),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : num(row.duration_ms),
    result: textOrNull(row.result),
    parkId: textOrNull(row.park_id),
    properties,
  };
}

const EVENT_COLUMNS = `e.event_id::text AS event_id, e.event_type, e.occurred_at, e.client_occurred_at, e.received_at, e.route,
  e.account_id::text AS account_id, pl.handle, e.installation_id::text AS installation_id, e.app_version, e.bundle_id, e.environment,
  e.operation, e.tables, e.duration_ms, e.result, e.park_id, e.properties, e.entry_point, e.provider, e.travel_mode, e.claim_status`;

/**
 * The WHERE clause for the event explorer. Only placeholders are interpolated, so each filter
 * stays a bound parameter while the planner still sees exactly which indexes apply.
 */
export function eventWhere(filter: EventFilter, cursor: EventCursor | null): { sql: string; params: unknown[] } {
  const params: unknown[] = [filter.from, filter.to, filter.types];
  const clauses = ["e.received_at >= $1::timestamptz", "e.received_at < $2::timestamptz", "e.event_type = ANY($3::text[])"];
  const add = (clause: (index: number) => string, value: unknown) => {
    params.push(value);
    clauses.push(clause(params.length));
  };
  if (filter.accountId) add((i) => `e.account_id = $${i}::uuid`, filter.accountId);
  if (filter.parkId) add((i) => `e.park_id = $${i}`, filter.parkId);
  if (filter.route) add((i) => `e.route = $${i}`, filter.route);
  if (filter.result === "ok") clauses.push("e.result = 'ok'");
  if (filter.result === "failed") clauses.push("e.result <> 'ok'");
  if (cursor) {
    params.push(cursor.receivedAt, cursor.id);
    clauses.push(`(e.received_at, e.event_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  return { sql: clauses.join("\n    AND "), params };
}

const DB_TYPES_SQL = `ARRAY[${DB_EVENT_TYPES.map((type) => `'${type}'`).join(", ")}]::text[]`;

/** Days in Victoria, oldest first, with their UTC bounds. $1 is now and $2 the number of days. */
const DAYS_CTE = `days AS (
    SELECT d::date AS day,
      (d::date::timestamp AT TIME ZONE '${TIME_ZONE}') AS starts,
      ((d::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}') AS ends
    FROM generate_series((kip_game.local_day($1::timestamptz) - ($2::int - 1))::timestamp, kip_game.local_day($1::timestamptz)::timestamp, interval '1 day') d
  ), bounds AS (SELECT min(starts) AS starts, max(ends) AS ends FROM days)`;

/**
 * Accounts that had a session at some point in the given number of days before $1. Signed-in events always come
 * from a session, so only these accounts can count as active, and each one costs a single probe
 * of the (account_id, received_at) index instead of a scan over every retained event.
 */
function candidatesCte(daysParam: string): string {
  return `candidates AS MATERIALIZED (
    SELECT DISTINCT s.account_id FROM kip_account.sessions s
    WHERE s.created_at < $1::timestamptz AND coalesce(s.revoked_at, s.expires_at) > $1::timestamptz - make_interval(days => ${daysParam}::int)
  )`;
}

function activeIn(from: string, to: string): string {
  return `count(*) FILTER (WHERE EXISTS (SELECT 1 FROM kip_analytics.events e WHERE e.account_id = c.account_id
      AND e.received_at > $1::timestamptz - interval '${from}' AND e.received_at <= $1::timestamptz - interval '${to}'))::int`;
}

/**
 * The overview's queries. Founder tiles and charts are left out when the database has no
 * kip_founders schema yet, so a release that lags behind still gets the rest of the page.
 */
export function overviewStatements(now: Date, days: number, features: Features): Keyed[] {
  const at = now.toISOString();
  const span = (n: string) => `make_interval(days => ${n})`;
  const founders = features.founders;
  const statements: (Keyed | null)[] = [
    {
      key: "counts",
      text: `SELECT
        (SELECT count(*) FROM kip_account.accounts)::int AS accounts_total,
        (SELECT count(*) FROM kip_account.accounts WHERE deletion_state = 'deleting')::int AS accounts_deleting,
        (SELECT count(*) FROM kip_account.accounts WHERE created_at > $1::timestamptz - interval '7 days')::int AS accounts_new7,
        (SELECT count(*) FROM kip_account.accounts WHERE created_at > $1::timestamptz - interval '30 days')::int AS accounts_new30,
        (SELECT count(*) FROM kip_account.accounts WHERE created_at > $1::timestamptz - ${span("$2::int")})::int AS accounts_period,
        (SELECT count(*) FROM kip_account.accounts WHERE created_at > $1::timestamptz - ${span("2 * $2::int")}
          AND created_at <= $1::timestamptz - ${span("$2::int")})::int AS accounts_previous,
        (SELECT count(*) FROM kip_game.players p JOIN kip_account.accounts a ON a.id = p.account_id AND a.deletion_state = 'active')::int AS with_handle,
${
  founders
    ? `
        (SELECT count(*) FROM kip_founders.parks)::int AS founded_total,
        (SELECT count(*) FROM kip_founders.parks WHERE founded_at > $1::timestamptz - interval '7 days')::int AS founded_new7,
        (SELECT count(*) FROM kip_founders.parks WHERE founded_at > $1::timestamptz - ${span("$2::int")})::int AS founded_period,
        (SELECT count(*) FROM kip_founders.parks WHERE founded_at > $1::timestamptz - ${span("2 * $2::int")}
          AND founded_at <= $1::timestamptz - ${span("$2::int")})::int AS founded_previous,`
    : ""
}
        (SELECT count(*) FROM kip_feedback.reports WHERE status IN ('new', 'reviewing', 'planned'))::int AS feedback_open`,
      params: [at, days],
    },
    {
      key: "players",
      text: `WITH ${candidatesCte("$2")}
      SELECT ${activeIn("1 day", "0 days")} AS day_current, ${activeIn("2 days", "1 day")} AS day_previous,
        ${activeIn("7 days", "0 days")} AS week_current, ${activeIn("14 days", "7 days")} AS week_previous,
        ${activeIn("30 days", "0 days")} AS month_current, ${activeIn("60 days", "30 days")} AS month_previous
      FROM candidates c`,
      params: [at, 60],
    },
    {
      key: "visits",
      text: `SELECT
        count(*) FILTER (WHERE visited_at > $1::timestamptz - ${span("$2::int")} AND outcome = 'planted')::int AS planted_current,
        count(*) FILTER (WHERE visited_at <= $1::timestamptz - ${span("$2::int")} AND outcome = 'planted')::int AS planted_previous,
        count(*) FILTER (WHERE visited_at > $1::timestamptz - ${span("$2::int")} AND outcome = 'took')::int AS took_current,
        count(*) FILTER (WHERE visited_at <= $1::timestamptz - ${span("$2::int")} AND outcome = 'took')::int AS took_previous,
        count(*) FILTER (WHERE visited_at > $1::timestamptz - ${span("$2::int")} AND outcome = 'held')::int AS held_current,
        count(*) FILTER (WHERE visited_at <= $1::timestamptz - ${span("$2::int")} AND outcome = 'held')::int AS held_previous
      FROM kip_game.visits
      WHERE visited_at > $1::timestamptz - ${span("2 * $2::int")} AND visited_at <= $1::timestamptz AND source = 'visit'`,
      params: [at, days],
    },
    !founders
      ? null
      : {
          key: "checks",
          text: `SELECT
        count(*) FILTER (WHERE created_at > $1::timestamptz - ${span("$2::int")})::int AS total_current,
        count(*) FILTER (WHERE created_at <= $1::timestamptz - ${span("$2::int")})::int AS total_previous,
        count(*) FILTER (WHERE created_at > $1::timestamptz - ${span("$2::int")} AND outcome = 'approve')::int AS approved_current,
        count(*) FILTER (WHERE created_at <= $1::timestamptz - ${span("$2::int")} AND outcome = 'approve')::int AS approved_previous,
        count(*) FILTER (WHERE created_at > $1::timestamptz - ${span("$2::int")} AND outcome = 'reject')::int AS rejected,
        count(*) FILTER (WHERE created_at > $1::timestamptz - ${span("$2::int")} AND outcome = 'unsure')::int AS unsure,
        count(*) FILTER (WHERE created_at > $1::timestamptz - ${span("$2::int")} AND outcome = 'unavailable')::int AS unavailable
      FROM kip_founders.photo_checks
      WHERE created_at > $1::timestamptz - ${span("2 * $2::int")} AND created_at <= $1::timestamptz`,
          params: [at, days],
        },
    !founders
      ? null
      : {
          key: "flags",
          text: `SELECT flag, count(*)::int AS count
      FROM kip_founders.photo_checks, unnest(flags) AS flag
      WHERE created_at > $1::timestamptz - ${span("$2::int")} AND created_at <= $1::timestamptz
      GROUP BY flag ORDER BY count DESC, flag`,
          params: [at, days],
        },
    {
      key: "topParks",
      text: `SELECT v.park_id, coalesce(p.name, v.park_id) AS name, count(*)::int AS visits, count(DISTINCT v.account_id)::int AS players
      FROM kip_game.visits v LEFT JOIN public.parks p ON p.id = v.park_id
      WHERE v.visited_at > $1::timestamptz - ${span("$2::int")} AND v.visited_at <= $1::timestamptz AND v.source = 'visit'
      GROUP BY v.park_id, p.name ORDER BY visits DESC, v.park_id LIMIT 10`,
      params: [at, days],
    },
    {
      key: "series",
      text: `WITH ${DAYS_CTE},
      accounts AS (
        SELECT kip_game.local_day(a.created_at) AS day, count(*)::int AS n FROM kip_account.accounts a, bounds
        WHERE a.created_at >= bounds.starts AND a.created_at < bounds.ends GROUP BY 1
      ), visits AS (
        SELECT kip_game.local_day(v.visited_at) AS day,
          count(*) FILTER (WHERE v.outcome = 'planted')::int AS planted,
          count(*) FILTER (WHERE v.outcome = 'took')::int AS took,
          count(*) FILTER (WHERE v.outcome = 'held')::int AS held
        FROM kip_game.visits v, bounds
        WHERE v.visited_at >= bounds.starts AND v.visited_at < bounds.ends AND v.source = 'visit' GROUP BY 1
      ), foundings AS (
        ${
          founders
            ? `SELECT kip_game.local_day(f.founded_at) AS day, count(*)::int AS n FROM kip_founders.parks f, bounds
        WHERE f.founded_at >= bounds.starts AND f.founded_at < bounds.ends GROUP BY 1`
            : "SELECT NULL::date AS day, 0 AS n WHERE false"
        }
      ), active AS (
        -- One index-only pass over the signed-in part of (account_id, received_at) for the
        -- window. Retention caps it at 90 days of events, and it costs the same however many
        -- accounts are active each day.
        SELECT x.day, count(*)::int AS n FROM (
          SELECT DISTINCT kip_game.local_day(e.received_at) AS day, e.account_id
          FROM kip_analytics.events e, bounds
          WHERE e.account_id IS NOT NULL AND e.received_at >= bounds.starts AND e.received_at < bounds.ends
        ) x GROUP BY x.day
      )
      SELECT d.day::text AS day, coalesce(a.n, 0) AS new_accounts, coalesce(act.n, 0) AS active_players,
        coalesce(v.planted, 0) AS planted, coalesce(v.took, 0) AS took, coalesce(v.held, 0) AS held, coalesce(f.n, 0) AS foundings
      FROM days d
      LEFT JOIN accounts a ON a.day = d.day
      LEFT JOIN visits v ON v.day = d.day
      LEFT JOIN foundings f ON f.day = d.day
      LEFT JOIN active act ON act.day = d.day
      ORDER BY d.day`,
      params: [at, days],
    },
  ];
  return statements.filter((statement): statement is Keyed => statement !== null);
}

function toOverview(byKey: Record<string, Row[]>, now: Date, days: number, features: Features): Overview {
  const { counts, players, visits, checks, flags, topParks, series } = byKey;
  const founders = features.founders;
  const c = counts[0] ?? {};
  const p = players[0] ?? {};
  const v = visits[0] ?? {};
  const k = checks?.[0] ?? {};
  return {
    generatedAt: now.toISOString(),
    days,
    accounts: {
      total: num(c.accounts_total),
      new7: num(c.accounts_new7),
      new30: num(c.accounts_new30),
      period: period(c, "accounts_period", "accounts_previous"),
      deleting: num(c.accounts_deleting),
      withHandle: num(c.with_handle),
    },
    players: {
      day: period(p, "day_current", "day_previous"),
      week: period(p, "week_current", "week_previous"),
      month: period(p, "month_current", "month_previous"),
    },
    founded: founders ? { total: num(c.founded_total), new7: num(c.founded_new7), period: period(c, "founded_period", "founded_previous") } : null,
    visits: {
      planted: period(v, "planted_current", "planted_previous"),
      took: period(v, "took_current", "took_previous"),
      held: period(v, "held_current", "held_previous"),
    },
    photoChecks: founders
      ? {
          total: period(k, "total_current", "total_previous"),
          approved: period(k, "approved_current", "approved_previous"),
          rejected: num(k.rejected),
          unsure: num(k.unsure),
          unavailable: num(k.unavailable),
        }
      : null,
    feedbackOpen: num(c.feedback_open),
    series: {
      days: series.map((row) => day(row.day)),
      newAccounts: series.map((row) => num(row.new_accounts)),
      activePlayers: series.map((row) => num(row.active_players)),
      planted: series.map((row) => num(row.planted)),
      took: series.map((row) => num(row.took)),
      held: series.map((row) => num(row.held)),
      foundings: founders ? series.map((row) => num(row.foundings)) : null,
    },
    topParks: topParks.map((row) => ({ parkId: String(row.park_id), name: String(row.name), visits: num(row.visits), players: num(row.players) })),
    rejectionFlags: (flags ?? []).map((row) => ({ flag: String(row.flag), count: num(row.count) })),
    unavailable: unavailableNotes(features),
  };
}

/**
 * Per-account columns for the accounts table. $1 is now. Each one is an index probe on the
 * account. Without kip_founders the score has no founder bonus, as kip_game.player_scores from
 * game_001 has none, and the founded count is null. Visit bonuses come from visits.points_earned:
 * before game_002_points.sql that is each take's bounty, the same as tenures.bounty_points, so
 * this matches kip_game.player_scores on either side of that migration. Holding points follow
 * kip_game.holding_points (days before game_002, hours after).
 */
function accountSelect(founders: boolean): string {
  return `SELECT a.id::text AS id, pl.handle, a.created_at, a.deletion_state,
    (a.password_hash IS NOT NULL) AS has_password,
    EXISTS (SELECT 1 FROM kip_account.google_identities g WHERE g.account_id = a.id) AS has_google,
    (SELECT max(e.received_at) FROM kip_analytics.events e WHERE e.account_id = a.id) AS last_event_at,
    (SELECT max(s.created_at) FROM kip_account.sessions s WHERE s.account_id = a.id) AS last_session_at,
    (SELECT count(*) FROM kip_game.visits v WHERE v.account_id = a.id AND v.source = 'visit')::int AS visits,
    (SELECT count(*) FROM kip_game.tenures t WHERE t.holder_account_id = a.id AND t.started_at <= $1::timestamptz
      AND kip_game.flag_up(t.last_visit_at, t.ended_at, $1::timestamptz))::int AS parks_held,
    ((SELECT coalesce(sum(kip_game.holding_points(t.started_at, t.last_visit_at, t.ended_at, $1::timestamptz)), 0)
      FROM kip_game.tenures t WHERE t.holder_account_id = a.id AND t.started_at <= $1::timestamptz)
      + (SELECT coalesce(sum(v.points_earned), 0) FROM kip_game.visits v WHERE v.account_id = a.id AND v.visited_at <= $1::timestamptz)
      ${founders ? "+ kip_founders.founder_points(a.id, $1::timestamptz)" : ""})::int AS score,
    ${founders ? "(SELECT count(*) FROM kip_founders.parks f WHERE f.account_id = a.id)::int" : "NULL::int"} AS founded
  FROM kip_account.accounts a
  LEFT JOIN kip_game.players pl ON pl.account_id = a.id`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function accountListStatement(query: AccountQuery, now: Date, features: Features): Statement {
  const params: unknown[] = [now.toISOString()];
  const clauses: string[] = [];
  const add = (clause: (index: number) => string, value: unknown) => {
    params.push(value);
    clauses.push(clause(params.length));
  };
  const search = query.search?.trim().toLowerCase() ?? "";
  if (search && UUID.test(search)) add((i) => `a.id = $${i}::uuid`, search);
  else if (search.includes("@")) add((i) => `a.normalized_email = $${i}`, search);
  else if (search) add((i) => `pl.handle LIKE $${i} ESCAPE '\\'`, `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  if (query.state) add((i) => `a.deletion_state = $${i}`, query.state);
  if (query.cursor) {
    params.push(query.cursor.createdAt, query.cursor.id);
    clauses.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(query.limit);
  return {
    text: `${accountSelect(features.founders)}
  ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT $${params.length}`,
    params,
  };
}

/**
 * @param cacheKey identifies the database, so which optional schemas it has is checked once a
 * minute rather than on every request. Without one, each call checks again.
 */
export function createSqlAnalyticsStore(db: SqlRunner, cacheKey: string | null = null): AnalyticsStore {
  const features = () => probeFeatures(db, cacheKey);
  async function read(statements: Statement[]): Promise<Row[][]> {
    const results = await db.transaction([
      { text: "SET TRANSACTION READ ONLY", params: [] },
      { text: `SET LOCAL statement_timeout = '${READ_TIMEOUT}'`, params: [] },
      ...statements,
    ]);
    return results.slice(2);
  }
  async function readOne(text: string, params: unknown[]): Promise<Row[]> {
    return (await read([{ text, params }]))[0];
  }

  return {
    features,

    async overview(now, days) {
      const available = await features();
      const statements = overviewStatements(now, days, available);
      const results = await read(statements);
      return toOverview(Object.fromEntries(statements.map((statement, index) => [statement.key, results[index]])), now, days, available);
    },

    async listAccounts(query, now) {
      const statement = accountListStatement(query, now, await features());
      return (await readOne(statement.text, statement.params)).map(accountRow);
    },

    async getAccount(id, now) {
      const at = now.toISOString();
      const { founders } = await features();
      const [accounts, extra, events, visits, founded, receipts] = await read([
        { text: `${accountSelect(founders)} WHERE a.id = $2::uuid`, params: [at, id] },
        {
          text: `SELECT a.normalized_email, (a.email_verified_at IS NOT NULL) AS email_verified,
            (SELECT count(*) FROM kip_account.sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL AND s.expires_at > $2::timestamptz)::int AS active_sessions
          FROM kip_account.accounts a WHERE a.id = $1::uuid`,
          params: [id, at],
        },
        {
          text: `SELECT ${EVENT_COLUMNS} FROM kip_analytics.events e LEFT JOIN kip_game.players pl ON pl.account_id = e.account_id
          WHERE e.account_id = $1::uuid ORDER BY e.received_at DESC, e.event_id DESC LIMIT 50`,
          params: [id],
        },
        {
          text: `SELECT v.park_id, coalesce(p.name, v.park_id) AS park_name, v.visited_at, v.outcome, v.points_earned
          FROM kip_game.visits v LEFT JOIN public.parks p ON p.id = v.park_id
          WHERE v.account_id = $1::uuid ORDER BY v.visited_at DESC LIMIT 20`,
          params: [id],
        },
        founders
          ? {
              text: `SELECT f.park_id, coalesce(p.name, f.park_id) AS park_name, f.founded_at
          FROM kip_founders.parks f LEFT JOIN public.parks p ON p.id = f.park_id
          WHERE f.account_id = $1::uuid ORDER BY f.founded_at DESC LIMIT 50`,
              params: [id],
            }
          : { text: "SELECT 1 WHERE false", params: [] },
        {
          text: `SELECT receipt_id::text AS receipt_id, status, created_at FROM kip_account.account_deletion_receipts
          WHERE account_id = $1::uuid ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 1`,
          params: [id],
        },
      ]);
      if (!accounts[0] || !extra[0]) return null;
      const base = accountRow(accounts[0]);
      const receipt = receipts[0];
      return {
        ...base,
        // A guest account has no email until Google upgrades it.
        maskedEmail: extra[0].normalized_email == null ? "Guest" : maskEmail(String(extra[0].normalized_email)),
        emailVerified: extra[0].email_verified === true,
        activeSessions: num(extra[0].active_sessions),
        lastSignInAt: isoOrNull(accounts[0].last_session_at),
        recentEvents: events.map(eventRow),
        recentVisits: visits.map((row) => ({
          parkId: String(row.park_id),
          parkName: String(row.park_name),
          visitedAt: iso(row.visited_at),
          outcome: String(row.outcome),
          points: num(row.points_earned),
        })),
        founded: !founders ? null : founded.map((row) => ({ parkId: String(row.park_id), parkName: String(row.park_name), foundedAt: iso(row.founded_at) })),
        deletion: receipt
          ? { receiptId: String(receipt.receipt_id), status: receipt.status === "complete" ? "complete" : "pending", createdAt: iso(receipt.created_at) }
          : null,
      };
    },

    async accountEmail(id) {
      const rows = await readOne("SELECT normalized_email FROM kip_account.accounts WHERE id = $1::uuid", [id]);
      return rows[0]?.normalized_email != null ? String(rows[0].normalized_email) : null;
    },

    async accountIdForHandle(handle) {
      const rows = await readOne("SELECT account_id::text AS account_id FROM kip_game.players WHERE handle = $1", [handle.toLowerCase()]);
      return rows[0] ? String(rows[0].account_id) : null;
    },

    async listEvents(filter, cursor, limit) {
      const where = eventWhere(filter, cursor);
      where.params.push(limit);
      const rows = await readOne(
        `SELECT ${EVENT_COLUMNS}
  FROM kip_analytics.events e LEFT JOIN kip_game.players pl ON pl.account_id = e.account_id
  WHERE ${where.sql}
  ORDER BY e.received_at DESC, e.event_id DESC
  LIMIT $${where.params.length}`,
        where.params,
      );
      return rows.map(eventRow);
    },

    async histogram(filter, bucket) {
      const where = eventWhere(filter, null);
      const rows = await readOne(
        `SELECT (date_trunc('${bucket}', e.received_at AT TIME ZONE '${TIME_ZONE}') AT TIME ZONE '${TIME_ZONE}') AS at,
    count(*)::int AS count, count(*) FILTER (WHERE e.event_type = ANY(${DB_TYPES_SQL}))::int AS db
  FROM kip_analytics.events e
  WHERE ${where.sql}
  GROUP BY 1 ORDER BY 1`,
        where.params,
      );
      return rows.map((row): HistogramBucket => ({ at: iso(row.at), count: num(row.count), db: num(row.db) }));
    },

    async routes() {
      // A loose index scan over interactions_route_received_at_idx: one probe per distinct route.
      const rows = await readOne(
        `WITH RECURSIVE r AS (
    (SELECT route FROM kip_analytics.events WHERE route IS NOT NULL ORDER BY route LIMIT 1)
    UNION ALL
    SELECT (SELECT e.route FROM kip_analytics.events e WHERE e.route > r.route ORDER BY e.route LIMIT 1) FROM r WHERE r.route IS NOT NULL
  )
  SELECT route FROM r WHERE route IS NOT NULL LIMIT 300`,
        [],
      );
      return rows.map((row) => String(row.route));
    },

    async pendingDeletions() {
      const rows = await readOne(
        `SELECT r.receipt_id::text AS receipt_id, r.account_id::text AS account_id, r.created_at, pl.handle, a.deletion_state,
    (SELECT count(*) FROM kip_account.account_deletion_photo_objects o WHERE o.receipt_id = r.receipt_id)::int AS photo_objects,
    (SELECT coalesce(max(o.attempts), 0) FROM kip_account.account_deletion_photo_objects o WHERE o.receipt_id = r.receipt_id)::int AS attempts,
    (SELECT o.last_error FROM kip_account.account_deletion_photo_objects o WHERE o.receipt_id = r.receipt_id AND o.last_error IS NOT NULL LIMIT 1) AS last_error
  FROM kip_account.account_deletion_receipts r
  LEFT JOIN kip_account.accounts a ON a.id = r.account_id
  LEFT JOIN kip_game.players pl ON pl.account_id = r.account_id
  WHERE r.status = 'pending'
  ORDER BY r.created_at
  LIMIT 200`,
        [],
      );
      return rows.map((row): DeletionRow => ({
        receiptId: String(row.receipt_id),
        accountId: String(row.account_id),
        handle: textOrNull(row.handle),
        createdAt: iso(row.created_at),
        photoObjects: num(row.photo_objects),
        attempts: num(row.attempts),
        lastError: textOrNull(row.last_error),
        accountState: row.deletion_state === "deleting" ? "deleting" : row.deletion_state === "active" ? "active" : "gone",
      }));
    },

    async beginDeletion(accountId, receiptId, now) {
      // The app's beginDeletion also requires the player's own fresh session; the operator has
      // none, so this is the same marking, sign-out and receipt without that check.
      const [rows] = await db.transaction([
        {
          text: `WITH target AS MATERIALIZED (
    SELECT id FROM kip_account.accounts WHERE id = $1::uuid AND deletion_state = 'active' FOR UPDATE
  ), marked AS (
    UPDATE kip_account.accounts a SET deletion_state = 'deleting', updated_at = $3::timestamptz
    WHERE a.id IN (SELECT id FROM target) RETURNING a.id
  ), revoked AS (
    UPDATE kip_account.sessions s SET revoked_at = $3::timestamptz
    WHERE s.account_id IN (SELECT id FROM marked) AND s.revoked_at IS NULL RETURNING s.id
  ), receipt AS (
    INSERT INTO kip_account.account_deletion_receipts (receipt_id, account_id)
    SELECT $2::uuid, id FROM marked RETURNING receipt_id
  )
  SELECT (SELECT receipt_id::text FROM receipt) AS created,
    (SELECT receipt_id::text FROM kip_account.account_deletion_receipts WHERE account_id = $1::uuid AND status = 'pending' LIMIT 1) AS pending,
    (SELECT count(*) FROM revoked)::int AS revoked,
    EXISTS (SELECT 1 FROM kip_account.accounts WHERE id = $1::uuid) AS found`,
          params: [accountId, receiptId, now.toISOString()],
        },
      ]);
      const row = rows[0] ?? {};
      if (row.created) return { receiptId: String(row.created), created: true };
      if (row.pending) return { receiptId: String(row.pending), created: false };
      return null;
    },

    async recordSecurityEvent(eventType, outcome) {
      await db.query("INSERT INTO kip_account.security_events (id, event_type, scope_hash, outcome) VALUES ($1::uuid, $2, NULL, $3)", [
        crypto.randomUUID(),
        eventType,
        outcome,
      ]);
    },
  };
}

export function neonRunner(databaseUrl: string): SqlRunner {
  const sql = neon(databaseUrl);
  return {
    query: (statement, params = []) => sql.query(statement, params) as Promise<Record<string, unknown>[]>,
    transaction: (statements) => sql.transaction(statements.map(({ text, params }) => sql.query(text, params))) as Promise<Record<string, unknown>[][]>,
  };
}

export function createNeonAnalyticsStore(databaseUrl: string): AnalyticsStore {
  return createSqlAnalyticsStore(neonRunner(databaseUrl), databaseUrl);
}
