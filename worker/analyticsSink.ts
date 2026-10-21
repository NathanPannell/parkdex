import { neon } from "@neondatabase/serverless";
import { createRequestContext, runWithRequestContext, type RequestContext, type ServerEvent } from "./requestContext.js";

/**
 * Where a request's analytics events go once its response is ready: one batched insert into
 * kip_analytics.events and, when a PostHog project key is configured, one capture batch.
 * Both run after the response through waitUntil and swallow every failure.
 */

export interface AnalyticsEnv {
  DATABASE_URL?: string;
  POSTHOG_PROJECT_KEY?: string;
  POSTHOG_HOST?: string;
}

export interface AnalyticsSink {
  write(context: RequestContext): Promise<void>;
}

export type PosthogConfig = { key: string; host: string };

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const POSTHOG_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const POSTHOG_TIMEOUT_MS = 3_000;

/** The public project key and ingestion host, or null when PostHog is off. */
export function posthogConfig(env: AnalyticsEnv): PosthogConfig | null {
  const key = env.POSTHOG_PROJECT_KEY?.trim();
  if (!key || !POSTHOG_KEY.test(key)) return null;
  return { key, host: posthogHost(env.POSTHOG_HOST) };
}

function posthogHost(value: string | undefined): string {
  if (!value?.trim()) return DEFAULT_POSTHOG_HOST;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return DEFAULT_POSTHOG_HOST;
    return url.origin;
  } catch {
    return DEFAULT_POSTHOG_HOST;
  }
}

/** PostHog and the app speak of production; the events table keeps the older `main`. */
export function productEnvironment(environment: RequestContext["environment"]): "production" | "staging" | "preview" {
  return environment === "main" ? "production" : environment;
}

export function eventRows(context: RequestContext): Record<string, unknown>[] {
  return context.events.map((event) => ({
    event_id: event.eventId,
    event_type: event.type,
    installation_id: context.installationId,
    account_id: context.accountId,
    request_id: context.requestId,
    route: context.route,
    environment: context.environment,
    app_version: context.appVersion,
    bundle_id: context.bundleId,
    occurred_at: event.occurredAt,
    park_id: event.parkId,
    operation: event.operation,
    tables: event.tables,
    duration_ms: event.durationMs,
    result: event.result,
    properties: event.properties,
  }));
}

// The insert goes through the raw driver so it is never itself recorded as a db_write.
export function createPostgresEventWriter(databaseUrl: string): (rows: Record<string, unknown>[]) => Promise<void> {
  const sql = neon(databaseUrl);
  return async (rows) => {
    await sql.query(
      `INSERT INTO kip_analytics.events (
         event_id, event_type, installation_id, account_id, request_id, route, environment, app_version,
         bundle_id, occurred_at, park_id, operation, tables, duration_ms, result, properties, schema_version
       )
       SELECT x.event_id, x.event_type, x.installation_id, x.account_id, x.request_id, x.route, x.environment,
         x.app_version, x.bundle_id, x.occurred_at, x.park_id, x.operation, x.tables, x.duration_ms, x.result,
         x.properties, 1
       FROM jsonb_to_recordset($1::jsonb) AS x(
         event_id uuid, event_type text, installation_id uuid, account_id uuid, request_id uuid, route text,
         environment text, app_version text, bundle_id text, occurred_at timestamptz, park_id text,
         operation text, tables text[], duration_ms integer, result text, properties jsonb
       )
       ON CONFLICT (event_id) DO NOTHING`,
      [JSON.stringify(rows)],
    );
  };
}

/**
 * Reads stay in our own table only. PostHog's free tier is capped at 1M events a month, so it
 * gets writes and the named game events, which are what the field test measures.
 */
export function posthogEvents(context: RequestContext): ServerEvent[] {
  return context.events.filter((event) => event.type !== "db_read");
}

export function posthogBatch(context: RequestContext, key: string): { api_key: string; batch: Record<string, unknown>[] } {
  const distinctId = context.accountId ?? context.installationId ?? context.requestId;
  return {
    api_key: key,
    batch: posthogEvents(context).map((event) => ({
      event: event.type,
      uuid: event.eventId,
      timestamp: event.occurredAt,
      distinct_id: distinctId,
      properties: {
        ...event.properties,
        // Matches the client's identified_only setting: anonymous traffic creates no person.
        $process_person_profile: context.accountId !== null,
        source: "server",
        environment: productEnvironment(context.environment),
        app_version: context.appVersion,
        bundle_id: context.bundleId,
        installation_id: context.installationId,
        request_id: context.requestId,
        route: context.route,
        park_id: event.parkId,
        operation: event.operation,
        tables: event.tables,
        duration_ms: event.durationMs,
        result: event.result,
      },
    })),
  };
}

export async function sendPosthogBatch(context: RequestContext, config: PosthogConfig, fetcher: typeof fetch): Promise<void> {
  const body = posthogBatch(context, config.key);
  if (body.batch.length === 0) return;
  const response = await fetcher(`${config.host}/batch/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
  });
  // Drain the body so the connection is released; the content is not needed.
  await response.arrayBuffer().catch(() => undefined);
}

export function createAnalyticsSink(
  env: AnalyticsEnv,
  options: {
    writeRows?: (rows: Record<string, unknown>[]) => Promise<void>;
    fetch?: typeof fetch;
  } = {},
): AnalyticsSink | null {
  const writeRows = options.writeRows ?? (env.DATABASE_URL ? createPostgresEventWriter(env.DATABASE_URL) : null);
  const posthog = posthogConfig(env);
  if (!writeRows && !posthog) return null;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async write(context) {
      if (context.events.length === 0) return;
      await Promise.allSettled([
        writeRows ? writeRows(eventRows(context)) : Promise.resolve(),
        posthog ? sendPosthogBatch(context, posthog, fetcher) : Promise.resolve(),
      ]);
    },
  };
}

/**
 * Hand the request's events to the sink after the response. With waitUntil the platform keeps
 * the function alive until the write settles; without it the write still runs in the background.
 */
export function flushRequestAnalytics(context: RequestContext, sink: AnalyticsSink | null, waitUntil?: (promise: Promise<unknown>) => void): void {
  if (!sink || context.events.length === 0) return;
  let work: Promise<void>;
  try {
    work = sink.write(context).catch(() => undefined);
  } catch {
    return;
  }
  try {
    if (waitUntil) waitUntil(work);
  } catch {
    // A platform without a working waitUntil still lets the promise run.
  }
}

/** Run one request inside its analytics context and flush that context once the work settles. */
export async function withRequestAnalytics<T>(
  input: {
    method: string | undefined;
    path: string;
    header(name: string): string | null | undefined;
    env: Record<string, string | undefined>;
    sink(): AnalyticsSink | null;
    waitUntil?: (promise: Promise<unknown>) => void;
  },
  work: () => Promise<T>,
): Promise<T> {
  const context = createRequestContext(input);
  try {
    return await runWithRequestContext(context, work);
  } finally {
    let sink: AnalyticsSink | null = null;
    try {
      sink = input.sink();
    } catch {
      /* Without a sink the request simply goes unrecorded. */
    }
    flushRequestAnalytics(context, sink, input.waitUntil);
  }
}
