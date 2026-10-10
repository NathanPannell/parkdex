import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request analytics context. Every API request runs inside one, so database queries and
 * game events can be attributed to the account or installation that caused them without
 * threading identifiers through every store.
 */

export const INSTALLATION_HEADER = "X-Kip-Installation-Id";
export const APP_VERSION_HEADER = "X-Kip-App-Version";
export const BUNDLE_ID_HEADER = "X-Kip-Bundle-Id";
export const REQUEST_CONTEXT_HEADERS = [INSTALLATION_HEADER, APP_VERSION_HEADER, BUNDLE_ID_HEADER] as const;

// flag_held and visit_already_today complete the visit outcomes, so takeover share can be measured.
export const GAME_EVENT_TYPES = [
  "flag_planted",
  "flag_taken",
  "flag_held",
  "visit_already_today",
  "flag_fell",
  "leaderboard_viewed",
  "takeover_message_seen",
  "handle_set",
  // Found a park (#126). founders_001_init.sql widens the table's checks for these two.
  "park_founded",
  "founder_photo_checked",
  // Manual review of founding photos (#153); founders_002_reviews.sql widens the checks again.
  // The operator dashboard writes founding_review_decided itself, in the decision's transaction.
  "founding_review_requested",
  "founding_review_decided",
] as const;
export type GameEventType = (typeof GAME_EVENT_TYPES)[number];
export type DbEventType = "db_read" | "db_write";
export type ServerEventType = DbEventType | GameEventType;

/** Values stored in kip_analytics.events.environment. Production is `main` there. */
export type AnalyticsEnvironment = "main" | "staging" | "preview";
export type EventPropertyValue = string | number | boolean | null;
export type EventProperties = Record<string, EventPropertyValue>;

export type ServerEvent = {
  eventId: string;
  type: ServerEventType;
  occurredAt: string;
  parkId: string | null;
  operation: "read" | "write" | null;
  tables: string[] | null;
  durationMs: number | null;
  result: string | null;
  properties: EventProperties | null;
};

export type RequestContext = {
  requestId: string;
  route: string;
  installationId: string | null;
  appVersion: string | null;
  bundleId: string | null;
  environment: AnalyticsEnvironment;
  accountId: string | null;
  events: ServerEvent[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same shapes the interactions table already enforces for app_version and app_build.
const APP_VERSION = /^[A-Za-z0-9.+_-]{1,64}$/;
const BUNDLE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const PARK_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const PROPERTY_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const ROUTE_SEGMENT = /^[a-z0-9_-]{1,64}$/;
const HEX_ID = /^[0-9a-f]{16,}$/i;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const MAX_PROPERTIES = 16;
const MAX_PROPERTY_STRING = 120;
// Bounds memory and insert size for a pathological request; later events are dropped.
export const MAX_EVENTS_PER_REQUEST = 200;

const storage = new AsyncLocalStorage<RequestContext>();

/** Treat client headers as untrusted labels: anything malformed is dropped, never stored. */
export function validInstallationId(value: string | null | undefined): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

export function validAppVersion(value: string | null | undefined): string | null {
  return typeof value === "string" && APP_VERSION.test(value) ? value : null;
}

export function validBundleId(value: string | null | undefined): string | null {
  return typeof value === "string" && BUNDLE_ID.test(value) ? value : null;
}

/**
 * Identifiers in paths become placeholders so routes group well and never carry account,
 * claim or token values. Unknown segment shapes collapse to `:x`.
 */
export function normalizeRoute(method: string | undefined, path: string): string {
  const verb = METHODS.has((method ?? "GET").toUpperCase()) ? (method ?? "GET").toUpperCase() : "OTHER";
  const segments = path.split("/").filter(Boolean).slice(0, 8).map((segment, index, all) => {
    // Park IDs in /api/parks/:park/... would otherwise make one route per park.
    if (index === 2 && all[0] === "api" && all[1] === "parks" && segment !== "found") return ":park";
    if (UUID.test(segment)) return ":id";
    if (HEX_ID.test(segment)) return ":hash";
    if (/^\d+$/.test(segment)) return ":n";
    return ROUTE_SEGMENT.test(segment) ? segment : ":x";
  });
  return `${verb} /${segments.join("/")}`;
}

export function analyticsEnvironment(env: Record<string, string | undefined>): AnalyticsEnvironment {
  const channel = env.CONTENT_CHANNEL?.trim();
  if (channel === "main") return "main";
  if (channel === "staging") return "staging";
  return "preview";
}

export function createRequestContext(input: {
  method: string | undefined;
  path: string;
  header(name: string): string | null | undefined;
  env: Record<string, string | undefined>;
  requestId?: string;
}): RequestContext {
  return {
    requestId: input.requestId ?? crypto.randomUUID(),
    route: normalizeRoute(input.method, input.path),
    installationId: validInstallationId(input.header(INSTALLATION_HEADER)),
    appVersion: validAppVersion(input.header(APP_VERSION_HEADER)),
    bundleId: validBundleId(input.header(BUNDLE_ID_HEADER)),
    environment: analyticsEnvironment(input.env),
    accountId: null,
    events: [],
  };
}

export function runWithRequestContext<T>(context: RequestContext, work: () => T): T {
  return storage.run(context, work);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Called once a session is verified, so every event of this request carries the account. */
export function setRequestAccount(accountId: string): void {
  const context = storage.getStore();
  if (context && UUID.test(accountId)) context.accountId = accountId.toLowerCase();
}

function push(context: RequestContext, event: ServerEvent): void {
  if (context.events.length < MAX_EVENTS_PER_REQUEST) context.events.push(event);
}

export function recordDbQuery(input: {
  operation: "read" | "write";
  tables: string[];
  durationMs: number;
  result: string;
  startedAt: number;
}, context: RequestContext | undefined = storage.getStore()): void {
  if (!context) return;
  push(context, {
    eventId: crypto.randomUUID(),
    type: input.operation === "write" ? "db_write" : "db_read",
    occurredAt: new Date(input.startedAt).toISOString(),
    parkId: null,
    operation: input.operation,
    tables: input.tables,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    result: input.result,
    properties: null,
  });
}

/** Keep only small scalar properties with simple names; values are labels, not free text. */
export function sanitizeProperties(properties: Record<string, unknown> | undefined): EventProperties | null {
  if (!properties) return null;
  const result: EventProperties = {};
  for (const [name, value] of Object.entries(properties)) {
    if (Object.keys(result).length >= MAX_PROPERTIES) break;
    if (!PROPERTY_NAME.test(name)) continue;
    if (value === null || typeof value === "boolean") result[name] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[name] = value;
    else if (typeof value === "string") result[name] = value.slice(0, MAX_PROPERTY_STRING);
  }
  return Object.keys(result).length ? result : null;
}

/**
 * Record a named product event for this request, written with the request's database events.
 * A `parkId` property also fills the indexed park column. Outside a request it does nothing.
 */
export function emitEvent(type: GameEventType, properties?: Record<string, unknown>): void {
  try {
    const context = storage.getStore();
    if (!context || !(GAME_EVENT_TYPES as readonly string[]).includes(type)) return;
    const parkId = typeof properties?.parkId === "string" && PARK_ID.test(properties.parkId) ? properties.parkId : null;
    const rest = { ...properties };
    delete rest.parkId;
    push(context, {
      eventId: crypto.randomUUID(),
      type,
      occurredAt: new Date().toISOString(),
      parkId,
      operation: null,
      tables: null,
      durationMs: null,
      result: null,
      properties: sanitizeProperties(snakeCaseKeys(rest)),
    });
  } catch {
    // Analytics must never change the outcome of the request that emits it.
  }
}

function snakeCaseKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), item]));
}
