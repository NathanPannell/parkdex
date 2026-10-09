import { neon } from "@neondatabase/serverless";
import { sendEmail } from "../../../worker/feedbackDelivery.js";
import { createNeonFeedbackStore, type FeedbackCursor, type FeedbackStore } from "../../../worker/store.js";
import { readJsonBody, validateRetryBody, validateStatus } from "../../../worker/validation.js";
import type { DashboardEnv, SectionContext } from "../api.js";
import { allowMethods, databaseUrl, HttpError, json, plainObject } from "../http.js";

/** Feedback section: the report board, screenshots and email retry under /api/feedback. */

export interface FeedbackEnv {
  RESEND_API_KEY?: string;
  EMAIL_MODE?: string;
}

export interface FeedbackDependencies {
  feedbackStore?(env: DashboardEnv): FeedbackStore;
  /** Report counts by status, for the note about the database the operator is not looking at. */
  feedbackCounts?(env: DashboardEnv): Promise<Record<string, number>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEEDBACK_FILTERS = ["all", "new", "reviewing", "planned", "closed"] as const;
const PAGE_SIZE = 30;

export function encodeListCursor(report: { id: string; createdAt: string }, status: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ id: report.id, createdAt: report.createdAt, status }));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeListCursor(value: string, expectedStatus: string): FeedbackCursor {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, "invalid_cursor", "Invalid feedback cursor.");
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw, (char) => char.charCodeAt(0)))) as Record<string, unknown>;
    if (Object.keys(parsed).length !== 3 || typeof parsed.id !== "string" || !UUID.test(parsed.id) ||
      typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) || parsed.status !== expectedStatus) {
      throw new Error("invalid cursor");
    }
    return { id: parsed.id.toLowerCase(), createdAt: new Date(parsed.createdAt).toISOString() };
  } catch {
    throw new HttpError(400, "invalid_cursor", "Invalid feedback cursor.");
  }
}

function reportId(value: string): string {
  if (!UUID.test(value)) throw new HttpError(404, "not_found", "Feedback report not found.");
  return value.toLowerCase();
}

async function neonFeedbackCounts(env: DashboardEnv): Promise<Record<string, number>> {
  const rows = await neon(databaseUrl(env)).query("SELECT status, count(*)::int AS count FROM kip_feedback.reports GROUP BY status") as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

export async function feedbackRoutes(request: Request, context: SectionContext): Promise<Response | null> {
  const { path, url, dependencies } = context;
  const store = () => dependencies.feedbackStore?.(context.env) ?? createNeonFeedbackStore(databaseUrl(context.env));

  if (path === "/api/feedback") {
    allowMethods(request, "GET");
    const status = url.searchParams.get("status") ?? "all";
    if (!(FEEDBACK_FILTERS as readonly string[]).includes(status) || url.searchParams.getAll("status").length > 1 || url.searchParams.getAll("cursor").length > 1) {
      throw new HttpError(400, "invalid_query", "Invalid feedback list query.");
    }
    const cursorToken = url.searchParams.get("cursor");
    const cursor = cursorToken ? decodeListCursor(cursorToken, status) : null;
    const reports = await store().listReports(PAGE_SIZE + 1, status === "all" ? null : validateStatus(status), cursor);
    const page = reports.slice(0, PAGE_SIZE);
    const nextCursor = reports.length > PAGE_SIZE && page.length > 0 ? encodeListCursor(page[page.length - 1], status) : null;
    return json({ reports: page, nextCursor });
  }

  if (path === "/api/feedback/other-database") {
    allowMethods(request, "GET");
    const other = context.otherEnv;
    if (!other) return json({ available: false });
    const counts = await (dependencies.feedbackCounts?.(other) ?? neonFeedbackCounts(other));
    return json({ available: true, environment: other.DASHBOARD_ENVIRONMENT ?? "production", feedback: counts });
  }

  const match = /^\/api\/feedback\/([^/]+)(\/attachment|\/retry-emails)?$/.exec(path);
  if (!match) return null;
  const id = reportId(match[1]);
  if (match[2] === "/attachment") {
    allowMethods(request, "GET");
    const attachment = await store().getAttachment(id);
    if (!attachment) throw new HttpError(404, "not_found", "Screenshot not found.");
    const bytes = Uint8Array.from(atob(attachment.base64), (char) => char.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        "content-type": attachment.contentType,
        "content-length": String(bytes.byteLength),
        "content-disposition": `inline; filename="feedback-${id}-attachment"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (match[2] === "/retry-emails") {
    allowMethods(request, "POST");
    context.requireSameOrigin();
    const env = context.env;
    // Without a provider key a retry would only mark deliveries failed, so leave them untouched.
    if (env.EMAIL_MODE !== "disabled" && !env.RESEND_API_KEY) {
      throw new HttpError(503, "email_not_configured", "Email retry is not set up on this deployment yet.");
    }
    const feedback = store();
    const report = await feedback.getReport(id);
    if (!report) throw new HttpError(404, "not_found", "Feedback report not found.");
    const body = request.body ? validateRetryBody(await readJsonBody(request, 4096)) : { audiences: null, confirmAmbiguousAfter24h: false };
    const audiences = body.audiences ?? report.emails.map((email) => email.audience);
    const results = await Promise.all(audiences.map((audience) => sendEmail(feedback, env, dependencies, id, audience, body.confirmAmbiguousAfter24h)));
    return json({ results });
  }
  if (request.method === "GET") {
    const report = await store().getReport(id);
    if (!report) throw new HttpError(404, "not_found", "Feedback report not found.");
    return json({ report });
  }
  allowMethods(request, "GET", "PATCH");
  context.requireSameOrigin();
  const body = plainObject(await readJsonBody(request, 4096), ["status"], "Invalid feedback update.");
  const report = await store().updateStatus(id, validateStatus(body.status));
  if (!report) throw new HttpError(404, "not_found", "Feedback report not found.");
  return json({ report });
}
