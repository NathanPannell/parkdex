import { readJsonBody } from "../../../worker/validation.js";
import type { DashboardEnv, SectionContext } from "../api.js";
import { allowMethods, databaseUrl, HttpError, json, plainObject } from "../http.js";
import { createAccountDeleter, photoServiceFor, type AccountDeleter, type AccountDeletionEnv, type DeletionSetup } from "./deletion.js";
import {
  csvHeader,
  csvRow,
  DB_EVENT_TYPES,
  decodeAccountCursor,
  decodeEventCursor,
  encodeAccountCursor,
  encodeEventCursor,
  EXPORT_LIMIT,
  EXPORT_PAGE,
  HISTOGRAM_DB_DAYS,
  histogramBucket,
  isUuid,
  OVERVIEW_DAYS,
  parseEventQuery,
} from "./filters.js";
import { createPostHogClient, type PostHogClient, type PostHogEnv, type TemplateParams } from "./posthog.js";
import { unavailableNotes } from "./schema.js";
import { createNeonAnalyticsStore } from "./store.js";
import type { AnalyticsStore, DeletionState, EventFilter } from "./types.js";

/**
 * Analytics section under /api/analytics: headline numbers, the accounts table with account
 * deletion, the server event explorer and app events from PostHog. Every page follows the
 * Production/Staging toggle; deletion uses the photo service of the same environment.
 */

/** Settings this section reads from the deployment. All optional; missing ones disable a feature with a note. */
export interface AnalyticsEnv extends PostHogEnv, AccountDeletionEnv {}

/** Stores and clients the section uses, so tests and the local demo can swap them out. */
export interface AnalyticsDependencies {
  analyticsStore?(env: DashboardEnv): AnalyticsStore;
  /** Runs a receipt's data and photo cleanup. The default calls the selected environment's photo service. */
  accountDeleter?(env: DashboardEnv): AccountDeleter;
  /** Overrides the photo service check, for the demo, which has no photo service. */
  photoService?(env: DashboardEnv): DeletionSetup;
  posthog?(env: DashboardEnv): PostHogClient;
  photoFetch?: typeof fetch;
  posthogFetch?: typeof fetch;
  analyticsNow?(): Date;
}

const ACCOUNT_PAGE = 50;
const EVENT_PAGE = 100;
const DELETE_EVENT = "operator_account_delete";

function staging(context: SectionContext): boolean {
  const stagingUrl = context.baseEnv.STAGING_DATABASE_URL;
  return Boolean(stagingUrl) && context.env.DATABASE_URL === stagingUrl;
}

/** PostHog's `environment` property for the database on screen (the app registers it on every event). */
function posthogEnvironment(context: SectionContext): string {
  return staging(context) ? "staging" : "production";
}

function accountId(value: string): string {
  if (!isUuid(value)) throw new HttpError(404, "not_found", "That account is not in this database.");
  return value.toLowerCase();
}

async function eventFilter(context: SectionContext, store: AnalyticsStore, now: Date): Promise<{ filter: EventFilter; unknownHandle: string | null }> {
  const { filter, handle } = parseEventQuery(context.url, now);
  if (!handle) return { filter, unknownHandle: null };
  const id = await store.accountIdForHandle(handle);
  // An unknown handle matches nothing, rather than silently showing everyone.
  return { filter: { ...filter, accountId: id ?? "00000000-0000-0000-0000-000000000000" }, unknownHandle: id ? null : handle };
}

function exportResponse(store: AnalyticsStore, filter: EventFilter, name: string): Response {
  let cursor: { receivedAt: string; id: string } | null = null;
  let sent = 0;
  let started = false;
  const encoder = new TextEncoder();
  // Pages through the filter so one export never asks the database for more than a page at a time.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(csvHeader()));
        return;
      }
      if (sent >= EXPORT_LIMIT) return controller.close();
      const rows = await store.listEvents(filter, cursor, Math.min(EXPORT_PAGE, EXPORT_LIMIT - sent));
      if (!rows.length) return controller.close();
      sent += rows.length;
      cursor = { receivedAt: rows[rows.length - 1].receivedAt, id: rows[rows.length - 1].id };
      controller.enqueue(encoder.encode(rows.map(csvRow).join("")));
      if (rows.length < EXPORT_PAGE) controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function analyticsRoutes(request: Request, context: SectionContext): Promise<Response | null> {
  const { path, url, dependencies } = context;
  const now = () => dependencies.analyticsNow?.() ?? new Date();
  const store = () => dependencies.analyticsStore?.(context.env) ?? createNeonAnalyticsStore(databaseUrl(context.env));
  const posthog = () => dependencies.posthog?.(context.env) ?? createPostHogClient(context.baseEnv, dependencies.posthogFetch);
  const deletionSetup = (): DeletionSetup => dependencies.photoService?.(context.env) ?? photoServiceFor(context.baseEnv, staging(context)).setup;
  // Checked before an account is marked deleting, so a missing photo service never strands one.
  const deleter = (): AccountDeleter => {
    const setup = deletionSetup();
    if (!setup.available) {
      throw new HttpError(
        503,
        "photo_service_unconfigured",
        `Account deletion needs ${setup.missing.join(" and ")} on this deployment, so private photos are deleted too.`,
      );
    }
    if (dependencies.accountDeleter) return dependencies.accountDeleter(context.env);
    const { service } = photoServiceFor(context.baseEnv, staging(context));
    if (!service) throw new HttpError(503, "photo_service_unconfigured", "Account deletion is not set up on this deployment.");
    return createAccountDeleter(databaseUrl(context.env), service, dependencies.photoFetch);
  };

  if (path === "/api/analytics/overview") {
    allowMethods(request, "GET");
    const days = Number(url.searchParams.get("days") ?? 30);
    if (!(OVERVIEW_DAYS as readonly number[]).includes(days)) throw new HttpError(400, "invalid_query", "Days must be 7, 30 or 90.");
    return json({ overview: await store().overview(now(), days) });
  }

  if (path === "/api/analytics/accounts") {
    allowMethods(request, "GET");
    const search = url.searchParams.get("q")?.trim() || null;
    if (search && search.length > 254) throw new HttpError(400, "invalid_query", "Search for a handle, an account ID or an email address.");
    const state = url.searchParams.get("state") || null;
    if (state && state !== "active" && state !== "deleting") throw new HttpError(400, "invalid_query", "State must be active or deleting.");
    const cursorToken = url.searchParams.get("cursor");
    const analytics = store();
    const rows = await analytics.listAccounts(
      {
        search,
        state: state as DeletionState | null,
        cursor: cursorToken ? decodeAccountCursor(cursorToken) : null,
        limit: ACCOUNT_PAGE + 1,
      },
      now(),
    );
    const page = rows.slice(0, ACCOUNT_PAGE);
    return json({
      accounts: page,
      nextCursor: rows.length > ACCOUNT_PAGE ? encodeAccountCursor(page[page.length - 1]) : null,
      deletion: deletionSetup(),
      unavailable: unavailableNotes(await analytics.features()),
    });
  }

  if (path === "/api/analytics/deletions") {
    allowMethods(request, "GET");
    return json({ deletions: await store().pendingDeletions(), deletion: deletionSetup() });
  }

  const resume = /^\/api\/analytics\/deletions\/([^/]+)\/resume$/.exec(path);
  if (resume) {
    allowMethods(request, "POST");
    context.requireSameOrigin();
    if (!isUuid(resume[1])) throw new HttpError(404, "not_found", "That deletion receipt is not in this database.");
    const receiptId = resume[1].toLowerCase();
    const runner = deleter();
    const analytics = store();
    if (!(await analytics.pendingDeletions()).some((row) => row.receiptId === receiptId)) {
      throw new HttpError(404, "not_found", "That deletion is not waiting to finish.");
    }
    const status = await runner.resume(receiptId);
    await analytics.recordSecurityEvent(DELETE_EVENT, `resumed_${status}`);
    return json({ receiptId, status });
  }

  const account = /^\/api\/analytics\/accounts\/([^/]+)(\/email|\/delete)?$/.exec(path);
  if (account) {
    const id = accountId(account[1]);
    if (!account[2]) {
      allowMethods(request, "GET");
      const analytics = store();
      const detail = await analytics.getAccount(id, now());
      if (!detail) throw new HttpError(404, "not_found", "That account is not in this database.");
      return json({ account: detail, deletion: deletionSetup(), unavailable: unavailableNotes(await analytics.features()) });
    }
    allowMethods(request, "POST");
    context.requireSameOrigin();
    const analytics = store();
    if (account[2] === "/email") {
      const email = await analytics.accountEmail(id);
      if (!email) throw new HttpError(404, "not_found", "That account is not in this database.");
      // Each reveal is on the record, like other account security actions.
      await analytics.recordSecurityEvent("operator_email_reveal", "revealed");
      return json({ email });
    }
    const body = plainObject(await readJsonBody(request, 1024), ["accountId"], "Send the account ID you are deleting.");
    if (body.accountId !== id) throw new HttpError(400, "invalid_request", "Send the account ID you are deleting.");
    const runner = deleter();
    const started = await analytics.beginDeletion(id, crypto.randomUUID(), now());
    if (!started) throw new HttpError(404, "not_found", "That account is not in this database.");
    if (started.created) await analytics.recordSecurityEvent(DELETE_EVENT, "started");
    let status: "pending" | "complete" = "pending";
    try {
      status = await runner.resume(started.receiptId);
    } catch {
      status = "pending";
    }
    await analytics.recordSecurityEvent(DELETE_EVENT, started.created ? status : `resumed_${status}`);
    return json({ receiptId: started.receiptId, status }, status === "complete" ? 200 : 202);
  }

  if (path === "/api/analytics/events/routes") {
    allowMethods(request, "GET");
    return json({ routes: await store().routes() });
  }

  if (path === "/api/analytics/events" || path === "/api/analytics/events/histogram" || path === "/api/analytics/events/export") {
    allowMethods(request, "GET");
    const analytics = store();
    const at = now();
    const { filter, unknownHandle } = await eventFilter(context, analytics, at);
    if (path === "/api/analytics/events/histogram") {
      const bucket = histogramBucket(filter);
      // Counting every database query over more than a month takes seconds on a busy table, so
      // the chart leaves them out there; the rows below it still include them.
      const long = Date.parse(filter.to) - Date.parse(filter.from) > HISTOGRAM_DB_DAYS * 86_400_000;
      const types = long ? filter.types.filter((type) => !(DB_EVENT_TYPES as readonly string[]).includes(type)) : filter.types;
      const dbOmitted = types.length < filter.types.length;
      const buckets = types.length ? await analytics.histogram({ ...filter, types }, bucket) : [];
      return json({ bucket, from: filter.from, to: filter.to, buckets, dbOmitted, unknownHandle });
    }
    if (path === "/api/analytics/events/export") {
      const name = `parkdex-events-${posthogEnvironment(context)}-${at.toISOString().slice(0, 16).replace(/[:T]/g, "")}.csv`;
      return exportResponse(analytics, filter, name);
    }
    const cursorToken = url.searchParams.get("cursor");
    const rows = await analytics.listEvents(filter, cursorToken ? decodeEventCursor(cursorToken) : null, EVENT_PAGE + 1);
    const page = rows.slice(0, EVENT_PAGE);
    return json({
      events: page,
      nextCursor: rows.length > EVENT_PAGE ? encodeEventCursor(page[page.length - 1]) : null,
      filter: { from: filter.from, to: filter.to, types: filter.types },
      unknownHandle,
      // Founder event types simply have no rows in a database without founders; say why.
      unavailable: unavailableNotes(await analytics.features()),
    });
  }

  if (path === "/api/analytics/posthog/status") {
    allowMethods(request, "GET");
    return json({ ...posthog().status(), environment: posthogEnvironment(context) });
  }

  if (path === "/api/analytics/posthog/query") {
    allowMethods(request, "POST");
    context.requireSameOrigin();
    const body = plainObject(await readJsonBody(request, 4096), ["template", "days", "distinctId", "event", "before"], "Send a template and its parameters.");
    if (typeof body.template !== "string") throw new HttpError(400, "invalid_query", "Send a template and its parameters.");
    const params: TemplateParams = {
      days: body.days === undefined ? 7 : Number(body.days),
      distinctId: typeof body.distinctId === "string" && body.distinctId.trim() ? body.distinctId.trim() : undefined,
      event: typeof body.event === "string" && body.event.trim() ? body.event.trim() : undefined,
      before: typeof body.before === "string" && body.before ? body.before : undefined,
    };
    return json({ result: await posthog().template(body.template, params, posthogEnvironment(context), now()) });
  }

  if (path === "/api/analytics/posthog/sql") {
    allowMethods(request, "POST");
    context.requireSameOrigin();
    const body = plainObject(await readJsonBody(request, 16 * 1024), ["query", "limit"], "Send a query.");
    return json({ result: await posthog().custom(body.query, body.limit) });
  }

  return null;
}
