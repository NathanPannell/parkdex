import { database } from "./db.js";
import { getClientAddress, keyedHash } from "./security.js";
import { HttpError, readJsonBody } from "./validation.js";

export type InteractionEntryPoint = "map" | "nearby" | "collection";
export type InteractionProvider = "google_maps" | "apple_maps";
export type InteractionTravelMode = "driving" | "walking" | "bicycling" | "transit";
export type InteractionEnvironment = "staging" | "main" | "preview";

export type ParkViewedEvent = InteractionBase & {
  type: "park_viewed";
  entryPoint: InteractionEntryPoint;
};

export type DirectionsOpenedEvent = InteractionBase & {
  type: "directions_opened";
  entryPoint: InteractionEntryPoint;
  provider: InteractionProvider;
  travelMode: InteractionTravelMode;
};

export type ParkClaimedEvent = InteractionBase & {
  type: "park_claimed";
  claimId: string;
  claimStatus: "first" | "repeat";
};

export type InteractionBase = {
  eventId: string;
  installationId: string;
  sessionId: string;
  occurredAt: string;
  schemaVersion: 1;
  appVersion: string;
  appBuild: string;
  contentReleaseId: string;
  environment: InteractionEnvironment;
  parkId: string;
};

export type InteractionEvent = ParkViewedEvent | DirectionsOpenedEvent | ParkClaimedEvent;

export interface InteractionEnv {
  DATABASE_URL?: string;
  KIP_RETENTION_SECRET?: string;
}

export interface InteractionPurgeResult {
  deleted: number;
  remainingExpired: number;
}

export interface InteractionStore {
  consumeRateLimit(subjectHash: string): Promise<boolean>;
  saveBatch(events: Array<{ event: InteractionEvent; payloadHash: string }>): Promise<{ inserted: number; conflictingEventIds: string[] }>;
  purgeExpired(cutoff: string, batchLimit: number): Promise<InteractionPurgeResult>;
}

export interface InteractionDependencies {
  createStore?(env: InteractionEnv): InteractionStore;
  now?(): number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARK_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const APP_VALUE = /^[A-Za-z0-9.+_-]{1,80}$/;
const RELEASE_ID = /^[0-9a-f]{64}$/i;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_BATCH_EVENTS = 50;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REQUESTS_PER_WINDOW = 30;
const RATE_WINDOW_MS = 15 * 60 * 1000;
export const INTERACTION_PURGE_BATCH_LIMIT = 5000;

const BASE_KEYS = [
  "eventId", "installationId", "sessionId", "occurredAt", "schemaVersion", "appVersion", "appBuild",
  "contentReleaseId", "environment", "parkId",
] as const;

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const headers = error.status === 429 ? { "retry-after": "900" } : undefined;
    const body = { error: { code: error.code, message: error.message }, code: error.code, message: error.message };
    return json(body, error.status, headers);
  }
  return json({ error: { code: "service_unavailable", message: "The interaction service is temporarily unavailable." } }, 503);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new HttpError(400, "invalid_request", `Invalid ${field}.`);
  return value.toLowerCase();
}

function allowedString<T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) throw new HttpError(400, "invalid_request", `Invalid ${field}.`);
  return value as T;
}

function appValue(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max || !APP_VALUE.test(value)) {
    throw new HttpError(400, "invalid_request", `Invalid ${field}.`);
  }
  return value;
}

function timestamp(value: unknown, now: number): string {
  if (typeof value !== "string" || value.length > 32) throw new HttpError(400, "invalid_request", "Invalid occurredAt.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new HttpError(400, "invalid_request", "Invalid occurredAt.");
  if (parsed > now + FUTURE_SKEW_MS || parsed < now - RETENTION_MS) {
    throw new HttpError(400, "event_outside_window", "The event time is outside the accepted window.");
  }
  return value;
}

function baseEvent(value: Record<string, unknown>, now: number): InteractionBase {
  if (value.schemaVersion !== 1) throw new HttpError(400, "invalid_request", "Unsupported interaction schema version.");
  if (typeof value.contentReleaseId !== "string" || !RELEASE_ID.test(value.contentReleaseId)) {
    throw new HttpError(400, "invalid_request", "Invalid contentReleaseId.");
  }
  if (typeof value.parkId !== "string" || !PARK_ID.test(value.parkId)) {
    throw new HttpError(400, "invalid_request", "Invalid parkId.");
  }
  return {
    eventId: uuid(value.eventId, "eventId"),
    installationId: uuid(value.installationId, "installationId"),
    sessionId: uuid(value.sessionId, "sessionId"),
    occurredAt: timestamp(value.occurredAt, now),
    schemaVersion: 1,
    appVersion: appValue(value.appVersion, "appVersion", 64),
    appBuild: appValue(value.appBuild, "appBuild", 80),
    contentReleaseId: value.contentReleaseId.toLowerCase(),
    environment: allowedString(value.environment, ["staging", "main", "preview"], "environment"),
    parkId: value.parkId,
  };
}

export function validateInteractionEvent(value: unknown, now: number): InteractionEvent {
  if (!record(value)) throw new HttpError(400, "invalid_request", "Invalid interaction event.");
  const type = allowedString(value.type, ["park_viewed", "directions_opened", "park_claimed"], "type");
  if (type === "park_viewed") {
    if (!hasExactKeys(value, [...BASE_KEYS, "type", "entryPoint"])) throw new HttpError(400, "invalid_request", "Invalid interaction event shape.");
    return {
      ...baseEvent(value, now),
      type,
      entryPoint: allowedString(value.entryPoint, ["map", "nearby", "collection"], "entryPoint"),
    };
  }
  if (type === "directions_opened") {
    if (!hasExactKeys(value, [...BASE_KEYS, "type", "entryPoint", "provider", "travelMode"])) {
      throw new HttpError(400, "invalid_request", "Invalid interaction event shape.");
    }
    return {
      ...baseEvent(value, now),
      type,
      entryPoint: allowedString(value.entryPoint, ["map", "nearby", "collection"], "entryPoint"),
      provider: allowedString(value.provider, ["google_maps", "apple_maps"], "provider"),
      travelMode: allowedString(value.travelMode, ["driving", "walking", "bicycling", "transit"], "travelMode"),
    };
  }
  if (!hasExactKeys(value, [...BASE_KEYS, "type", "claimId", "claimStatus"])) {
    throw new HttpError(400, "invalid_request", "Invalid interaction event shape.");
  }
  return {
    ...baseEvent(value, now),
    type,
    claimId: uuid(value.claimId, "claimId"),
    claimStatus: allowedString(value.claimStatus, ["first", "repeat"], "claimStatus"),
  };
}

export function validateInteractionBatch(value: unknown, now: number): InteractionEvent[] {
  if (!record(value) || !hasExactKeys(value, ["events"]) || !Array.isArray(value.events) ||
    value.events.length < 1 || value.events.length > MAX_BATCH_EVENTS) {
    throw new HttpError(400, "invalid_request", `An interaction batch must contain 1 to ${MAX_BATCH_EVENTS} events.`);
  }
  const byId = new Map<string, InteractionEvent>();
  for (const item of value.events) {
    const event = validateInteractionEvent(item, now);
    const prior = byId.get(event.eventId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
      throw new HttpError(409, "event_id_reused", "An event ID was repeated with different content.");
    }
    byId.set(event.eventId, event);
  }
  return [...byId.values()];
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function payloadHash(event: InteractionEvent): Promise<string> {
  return sha256Hex(JSON.stringify(event));
}

function interactionStore(env: InteractionEnv, dependencies: InteractionDependencies): InteractionStore {
  if (dependencies.createStore) return dependencies.createStore(env);
  if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "The interaction service is unavailable.");
  return createNeonInteractionStore(env.DATABASE_URL);
}

function responseMethod(request: Request, path: string, method: string): Response | null {
  if (new URL(request.url).pathname !== path) return null;
  if (request.method === method) return null;
  return json({ error: { code: "method_not_allowed", message: "This method is not allowed." } }, 405, { allow: method });
}

export async function handleInteractionRequest(
  request: Request,
  env: InteractionEnv,
  dependencies: InteractionDependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/interactions") return null;
  if (request.method !== "POST") return responseMethod(request, "/api/interactions", "POST");

  try {
    const now = dependencies.now?.() ?? Date.now();
    const body = await readJsonBody(request, MAX_REQUEST_BYTES);
    const events = validateInteractionBatch(body, now);
    if (!env.KIP_RETENTION_SECRET || new TextEncoder().encode(env.KIP_RETENTION_SECRET).length < 32) {
      throw new HttpError(503, "service_unavailable", "The interaction service is unavailable.");
    }
    const store = interactionStore(env, dependencies);
    const address = getClientAddress(request);
    const subjectHash = await keyedHash(env.KIP_RETENTION_SECRET, "kip-interactions-rate-limit-v1", address);
    if (!await store.consumeRateLimit(subjectHash)) throw new HttpError(429, "rate_limited", "Please wait before sending more interactions.");
    const hashed = await Promise.all(events.map(async (event) => ({ event, payloadHash: await payloadHash(event) })));
    const saved = await store.saveBatch(hashed);
    if (saved.conflictingEventIds.length > 0) {
      return json({ error: { code: "event_id_reused", message: "An event ID was already used for different content." }, conflictingEventIds: saved.conflictingEventIds }, 409);
    }
    return json({ accepted: events.length, inserted: saved.inserted, duplicates: events.length - saved.inserted }, saved.inserted === events.length ? 201 : 200);
  } catch (error) {
    return errorResponse(error);
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

export function retentionAuthorized(request: Request, secret: string): boolean {
  const provided = request.headers.get("authorization") ?? "";
  if (provided.length > 1024 || !provided.startsWith("Bearer ")) return false;
  return constantTimeEqual(provided.slice(7), secret);
}

export async function handleRetentionRequest(
  request: Request,
  env: InteractionEnv,
  dependencies: InteractionDependencies = {},
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/retention/interactions/purge") return null;
  if (request.method !== "POST") return responseMethod(request, path, "POST");

  try {
    const secret = env.KIP_RETENTION_SECRET;
    if (!secret || new TextEncoder().encode(secret).length < 32) {
      throw new HttpError(503, "service_unavailable", "The retention service is unavailable.");
    }
    if (!retentionAuthorized(request, secret)) throw new HttpError(401, "unauthorized", "Retention authorization is required.");
    if (request.body) throw new HttpError(400, "invalid_request", "The retention request must not include a body.");
    const store = interactionStore(env, dependencies);
    const now = dependencies.now?.() ?? Date.now();
    const cutoff = new Date(now - RETENTION_MS).toISOString();
    const result = await store.purgeExpired(cutoff, INTERACTION_PURGE_BATCH_LIMIT);
    return json({
      deleted: result.deleted,
      batchLimit: INTERACTION_PURGE_BATCH_LIMIT,
      remainingExpired: result.remainingExpired,
      cutoff,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export function createNeonInteractionStore(databaseUrl: string): InteractionStore {
  const sql = database(databaseUrl);
  return {
    async consumeRateLimit(subjectHash) {
      const rows = await sql`
        WITH expired AS MATERIALIZED (
          DELETE FROM kip_analytics.rate_limits WHERE expires_at <= now() RETURNING subject_hash
        ),
        cleanup_barrier AS MATERIALIZED (
          SELECT count(*) AS removed FROM expired
        ),
        bucket AS (
          INSERT INTO kip_analytics.rate_limits (subject_hash, window_started_at, hit_count, expires_at)
          SELECT ${subjectHash}, now(), 1, now() + interval '2 hours' FROM cleanup_barrier
          ON CONFLICT (subject_hash) DO UPDATE SET
            window_started_at = CASE
              WHEN kip_analytics.rate_limits.window_started_at <= now() - interval '15 minutes' THEN now()
              ELSE kip_analytics.rate_limits.window_started_at
            END,
            hit_count = CASE
              WHEN kip_analytics.rate_limits.window_started_at <= now() - interval '15 minutes' THEN 1
              ELSE kip_analytics.rate_limits.hit_count + 1
            END,
            expires_at = now() + interval '2 hours'
          RETURNING hit_count
        )
        SELECT hit_count <= ${MAX_REQUESTS_PER_WINDOW} AS allowed FROM bucket`;
      return rows[0]?.allowed === true;
    },
    async saveBatch(events) {
      const inputs = events.map(({ event, payloadHash: hash }) => ({
        eventId: event.eventId,
        eventType: event.type,
        installationId: event.installationId,
        sessionId: event.sessionId,
        occurredAt: event.occurredAt,
        schemaVersion: event.schemaVersion,
        appVersion: event.appVersion,
        appBuild: event.appBuild,
        contentReleaseId: event.contentReleaseId,
        environment: event.environment,
        parkId: event.parkId,
        entryPoint: "entryPoint" in event ? event.entryPoint : null,
        provider: "provider" in event ? event.provider : null,
        travelMode: "travelMode" in event ? event.travelMode : null,
        claimId: "claimId" in event ? event.claimId : null,
        claimStatus: "claimStatus" in event ? event.claimStatus : null,
        payloadHash: hash,
      }));
      const lockInputs = JSON.stringify(inputs.map(({ eventId }) => ({ eventId })));
      // Acquire event locks before the conflict query. In READ COMMITTED, the second
      // statement gets a fresh snapshot after any lock wait and sees the winning row.
      const transaction = await sql.transaction([
        sql`
        WITH input AS MATERIALIZED (
          SELECT "eventId" FROM jsonb_to_recordset(${lockInputs}::jsonb) AS x("eventId" uuid)
        )
        SELECT pg_advisory_xact_lock(hashtextextended("eventId"::text, 0))
        FROM input
        ORDER BY "eventId"`,
        sql`
        WITH input AS MATERIALIZED (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb) AS x(
            "eventId" uuid, "eventType" text, "installationId" uuid, "sessionId" uuid,
            "occurredAt" timestamptz, "schemaVersion" integer, "appVersion" text, "appBuild" text,
            "contentReleaseId" text, environment text, "parkId" text, "entryPoint" text,
            provider text, "travelMode" text, "claimId" uuid, "claimStatus" text, "payloadHash" text
          )
        ),
        conflicts AS MATERIALIZED (
          SELECT i."eventId" AS event_id
          FROM input i
          JOIN kip_analytics.events e ON e.event_id = i."eventId"
          WHERE e.payload_hash <> i."payloadHash"
        ),
        inserted AS (
          INSERT INTO kip_analytics.events (
            event_id, event_type, installation_id, session_id, client_occurred_at, schema_version,
            app_version, app_build, content_release_id, environment, park_id, entry_point,
            provider, travel_mode, claim_id, claim_status, payload_hash
          )
          SELECT i."eventId", i."eventType", i."installationId", i."sessionId", i."occurredAt", i."schemaVersion",
            i."appVersion", i."appBuild", i."contentReleaseId", i.environment, i."parkId", i."entryPoint",
            i.provider, i."travelMode", i."claimId", i."claimStatus", i."payloadHash"
          FROM input i
          WHERE NOT EXISTS (SELECT 1 FROM conflicts)
          ON CONFLICT (event_id) DO NOTHING
          RETURNING event_id
        )
        SELECT
          (SELECT count(*) FROM input) AS total,
          (SELECT count(*) FROM inserted) AS inserted,
          (SELECT count(*) FROM conflicts) AS conflict_count,
          COALESCE((SELECT json_agg(event_id::text) FROM conflicts), '[]'::json) AS conflict_ids`,
      ], { isolationLevel: "ReadCommitted" });
      const rows = transaction[1] as Array<Record<string, unknown>>;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error("interaction batch write returned no result");
      const conflictValue = row.conflict_ids;
      let conflictIds: string[] = [];
      try {
        conflictIds = (typeof conflictValue === "string" ? JSON.parse(conflictValue) : conflictValue) as string[];
      } catch {
        throw new Error("interaction conflict list could not be read");
      }
      const conflictCount = Number(row.conflict_count ?? 0);
      if (conflictCount !== conflictIds.length) throw new Error("interaction conflict list was incomplete");
      return { inserted: Number(row.inserted ?? 0), conflictingEventIds: conflictIds };
    },
    async purgeExpired(cutoff, batchLimit) {
      const rows = await sql`
        WITH expired_count AS MATERIALIZED (
          SELECT count(*)::integer AS total FROM kip_analytics.events WHERE received_at < ${cutoff}::timestamptz
        ),
        candidates AS MATERIALIZED (
          SELECT event_id FROM kip_analytics.events
          WHERE received_at < ${cutoff}::timestamptz
          ORDER BY received_at, event_id
          LIMIT ${batchLimit}
        ),
        deleted AS (
          DELETE FROM kip_analytics.events e USING candidates c
          WHERE e.event_id = c.event_id
          RETURNING e.event_id
        )
        SELECT
          (SELECT count(*)::integer FROM deleted) AS deleted,
          GREATEST((SELECT total FROM expired_count) - (SELECT count(*)::integer FROM deleted), 0) AS remaining_expired`;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error("interaction purge returned no result");
      return { deleted: Number(row.deleted ?? 0), remainingExpired: Number(row.remaining_expired ?? 0) };
    },
  };
}
