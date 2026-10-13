import { HttpError } from "../http.js";
import type { AccountCursor, EventCursor, EventFilter, EventRow } from "./types.js";

/** Parsing and encoding for analytics queries, shared by the routes, the memory store and tests. */

export const DB_EVENT_TYPES = ["db_read", "db_write"] as const;
/** Every event type kip_analytics.events accepts (interactions_002 and founders_001 to founders_003 checks). */
export const EVENT_TYPES = [
  "flag_planted", "flag_taken", "flag_held", "visit_already_today", "flag_fell",
  "leaderboard_viewed", "takeover_message_seen", "handle_set",
  "park_founded", "founder_photo_checked", "founding_review_requested", "founding_review_decided", "park_removed",
  "crew_joined", "crew_code_shown", "visit_logged_protected",
  "park_viewed", "directions_opened", "park_claimed",
  ...DB_EVENT_TYPES,
] as const;

/** Server events are purged after 90 days (docs/analytics.md), so nothing older can match. */
export const RETENTION_DAYS = 90;
export const OVERVIEW_DAYS = [7, 30, 90] as const;
export const EXPORT_LIMIT = 50_000;
export const EXPORT_PAGE = 5_000;
/** The histogram counts db_read and db_write for ranges up to this many days. */
export const HISTOGRAM_DB_DAYS = 31;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARK_ID = /^[a-z0-9][a-z0-9-]{0,159}$/;
const ROUTE = /^[A-Z]+ \/[a-z0-9_:/-]{0,196}$/;
const HANDLE = /^[a-z0-9_]{3,20}$/;
const DAY_MS = 86_400_000;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function single(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new HttpError(400, "invalid_query", `Send ${name} once.`);
  const value = values[0]?.trim();
  return value ? value : null;
}

function instant(value: string | null, label: string): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new HttpError(400, "invalid_query", `${label} must be a date and time.`);
  return parsed;
}

export interface ParsedEventQuery {
  filter: EventFilter;
  /** The account handle the operator typed, when the account filter came from one. */
  handle: string | null;
}

/**
 * The event explorer's filters from the query string. db_read and db_write are left out unless
 * the operator asks for them (db=1 or by type), because they outnumber every other event many
 * times over.
 */
export function parseEventQuery(url: URL, now: Date): ParsedEventQuery {
  const requested = (single(url, "type") ?? "").split(",").map((type) => type.trim()).filter(Boolean);
  for (const type of requested) {
    if (!(EVENT_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "invalid_query", `Unknown event type ${type}.`);
  }
  const includeDb = single(url, "db") === "1";
  // Types the operator picked by name are always shown; the toggle only widens "all types".
  const types = requested.length
    ? [...new Set(requested)]
    : EVENT_TYPES.filter((type) => includeDb || !(DB_EVENT_TYPES as readonly string[]).includes(type));

  const oldest = now.getTime() - RETENTION_DAYS * DAY_MS;
  const to = Math.min(instant(single(url, "to"), "To") ?? now.getTime() + 60_000, now.getTime() + 60_000);
  const from = Math.max(instant(single(url, "from"), "From") ?? to - 7 * DAY_MS, oldest);
  if (from >= to) throw new HttpError(400, "invalid_query", "From must be before To.");

  const account = single(url, "account");
  let accountId: string | null = null;
  let handle: string | null = null;
  if (account) {
    const value = account.replace(/^@/, "").toLowerCase();
    if (UUID.test(value)) accountId = value;
    else if (HANDLE.test(value)) handle = value;
    else throw new HttpError(400, "invalid_query", "Account must be a handle or an account ID.");
  }
  const parkId = single(url, "park");
  if (parkId && !PARK_ID.test(parkId)) throw new HttpError(400, "invalid_query", "Park must be a park ID such as regional-thetis-lake.");
  const route = single(url, "route");
  if (route && !ROUTE.test(route)) throw new HttpError(400, "invalid_query", "Route must look like GET /api/game/leaderboard.");
  const result = single(url, "result");
  if (result && result !== "ok" && result !== "failed") throw new HttpError(400, "invalid_query", "Result must be ok or failed.");

  return {
    filter: { types, from: new Date(from).toISOString(), to: new Date(to).toISOString(), accountId, parkId, route, result: result as EventFilter["result"] },
    handle,
  };
}

/** Hourly buckets up to three days, daily beyond that. */
export function histogramBucket(filter: EventFilter): "hour" | "day" {
  return Date.parse(filter.to) - Date.parse(filter.from) <= 3 * DAY_MS ? "hour" : "day";
}

function encode(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode(value: string): Record<string, unknown> {
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid cursor");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const parsed = JSON.parse(atob(base64 + "=".repeat((4 - base64.length % 4) % 4))) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid cursor");
  return parsed as Record<string, unknown>;
}

export function encodeEventCursor(row: { receivedAt: string; id: string }): string {
  return encode({ t: row.receivedAt, id: row.id });
}

export function decodeEventCursor(value: string): EventCursor {
  try {
    const parsed = decode(value);
    if (typeof parsed.t !== "string" || !Number.isFinite(Date.parse(parsed.t)) || typeof parsed.id !== "string" || !UUID.test(parsed.id)) throw new Error("invalid cursor");
    return { receivedAt: new Date(parsed.t).toISOString(), id: parsed.id.toLowerCase() };
  } catch {
    throw new HttpError(400, "invalid_cursor", "Invalid events cursor.");
  }
}

export function encodeAccountCursor(row: { createdAt: string; id: string }): string {
  return encode({ c: row.createdAt, id: row.id });
}

export function decodeAccountCursor(value: string): AccountCursor {
  try {
    const parsed = decode(value);
    if (typeof parsed.c !== "string" || !Number.isFinite(Date.parse(parsed.c)) || typeof parsed.id !== "string" || !UUID.test(parsed.id)) throw new Error("invalid cursor");
    return { createdAt: new Date(parsed.c).toISOString(), id: parsed.id.toLowerCase() };
  } catch {
    throw new HttpError(400, "invalid_cursor", "Invalid accounts cursor.");
  }
}

export const CSV_COLUMNS = [
  "event_id", "event_type", "occurred_at", "received_at", "route", "account_id", "handle", "installation_id", "app_version",
  "bundle_id", "environment", "operation", "tables", "duration_ms", "result", "park_id", "properties",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : typeof value === "object" ? JSON.stringify(value) : String(value);
  // A leading =, +, - or @ would run as a formula when the file is opened in a spreadsheet.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(row: EventRow): string {
  return [
    row.id, row.type, row.occurredAt, row.receivedAt, row.route, row.accountId, row.handle, row.installationId, row.appVersion,
    row.bundleId, row.environment, row.operation, row.tables, row.durationMs, row.result, row.parkId, row.properties,
  ].map(csvCell).join(",") + "\r\n";
}

export function csvHeader(): string {
  return CSV_COLUMNS.join(",") + "\r\n";
}
