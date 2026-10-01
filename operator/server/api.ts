import { createNeonAppConfigStore, CONTENT_CHANNELS, FEATURE_FLAGS, parseBuild, parsePlatform, validateBuildConfigInput, type AppConfigStore } from "../../worker/appConfig.js";
import { sendEmail, type DeliveryDependencies } from "../../worker/feedbackDelivery.js";
import { createNeonParkProposalStore, parseProposalStatus, PROPOSAL_STATUSES, type ParkProposalStore } from "../../worker/parkProposals.js";
import { createNeonFeedbackStore, type FeedbackCursor, type FeedbackStore } from "../../worker/store.js";
import { HttpError, readJsonBody, validateRetryBody, validateStatus } from "../../worker/validation.js";
import type { BadgeEnv } from "./badges.js";
import { createNeonDraftStore, type DraftStore } from "./drafts.js";
import { routeImport } from "./importRoutes.js";
import { createLegacySource, type LegacyEnv, type LegacySource } from "./legacy.js";

/**
 * The operator dashboard API. It has no sign-in of its own: every deployment of this app sits
 * behind Vercel Authentication, which rejects unauthenticated requests before they reach here.
 */

export interface DashboardEnv extends BadgeEnv, LegacyEnv {
  DATABASE_URL?: string;
  RESEND_API_KEY?: string;
  EMAIL_MODE?: string;
  /** Shown in the UI so it is obvious which database the dashboard edits. */
  DASHBOARD_ENVIRONMENT?: string;
  /** Optional second database the operator can switch to, such as the staging branch. */
  STAGING_DATABASE_URL?: string;
}

export interface DashboardDependencies extends DeliveryDependencies {
  feedbackStore?(env: DashboardEnv): FeedbackStore;
  appConfigStore?(env: DashboardEnv): AppConfigStore;
  proposalStore?(env: DashboardEnv): ParkProposalStore;
  draftStore?(env: DashboardEnv): DraftStore;
  legacySource?: LegacySource;
  randomSeed?(): number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEEDBACK_FILTERS = ["all", "new", "reviewing", "planned", "closed"] as const;
const PAGE_SIZE = 30;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
  return json({ error: { code: "service_unavailable", message: "The dashboard service is temporarily unavailable." } }, 503);
}

function databaseUrl(env: DashboardEnv): string {
  if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "The dashboard database is not configured.");
  return env.DATABASE_URL;
}

// Vercel Authentication cookies are not sent on cross-site fetches, but a same-origin check
// keeps writes safe even if that ever changes.
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, "forbidden", "This change must come from the dashboard itself.");
  }
}

function plainObject(value: unknown, keys: string[], message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new HttpError(400, "invalid_request", message);
  }
  return value as Record<string, unknown>;
}

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

async function routeFeedback(request: Request, path: string, store: () => FeedbackStore, env: DashboardEnv, dependencies: DashboardDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  if (path === "/api/feedback") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
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
  const match = /^\/api\/feedback\/([^/]+)(\/attachment|\/retry-emails)?$/.exec(path);
  if (!match) return null;
  const id = reportId(match[1]);
  if (match[2] === "/attachment") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
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
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
    requireSameOrigin(request);
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
  if (request.method !== "PATCH") throw new HttpError(405, "method_not_allowed", "Use GET or PATCH.");
  requireSameOrigin(request);
  const body = plainObject(await readJsonBody(request, 4096), ["status"], "Invalid feedback update.");
  const report = await store().updateStatus(id, validateStatus(body.status));
  if (!report) throw new HttpError(404, "not_found", "Feedback report not found.");
  return json({ report });
}

async function routeBuilds(request: Request, path: string, store: () => AppConfigStore): Promise<Response | null> {
  if (path === "/api/builds") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    return json({ builds: await store().list(), flags: FEATURE_FLAGS, channels: CONTENT_CHANNELS });
  }
  const match = /^\/api\/builds\/([a-z]+)\/(\d{1,10})$/.exec(path);
  if (!match) return null;
  if (request.method !== "PUT" && request.method !== "DELETE") throw new HttpError(405, "method_not_allowed", "Use PUT or DELETE.");
  requireSameOrigin(request);
  const platform = parsePlatform(match[1]);
  const build = parseBuild(match[2]);
  if (request.method === "DELETE") {
    if (!await store().remove(platform, build)) throw new HttpError(404, "not_found", "Build configuration not found.");
    return json({ ok: true });
  }
  const input = validateBuildConfigInput(await readJsonBody(request, 4096));
  return json({ build: await store().upsert(platform, build, input) });
}

async function routeProposals(request: Request, path: string, store: () => ParkProposalStore): Promise<Response | null> {
  if (path === "/api/proposals") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    const value = new URL(request.url).searchParams.get("status");
    const status = !value || value === "all" ? null : parseProposalStatus(value);
    return json({ proposals: await store().list(status), statuses: PROPOSAL_STATUSES });
  }
  const match = /^\/api\/proposals\/([^/]+)$/.exec(path);
  if (!match) return null;
  if (request.method !== "PATCH") throw new HttpError(405, "method_not_allowed", "Use PATCH.");
  requireSameOrigin(request);
  if (!UUID.test(match[1])) throw new HttpError(404, "not_found", "Proposal not found.");
  const body = plainObject(await readJsonBody(request, 4096), ["status"], "Invalid proposal update.");
  const proposal = await store().updateStatus(match[1].toLowerCase(), parseProposalStatus(body.status));
  if (!proposal) throw new HttpError(404, "not_found", "Proposal not found.");
  return json({ proposal });
}

export const DATABASE_COOKIE = "parkdex_operator_db";

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/**
 * The dashboard edits production unless the operator switched to staging with the sidebar
 * toggle, which sets a cookie so image requests follow the same choice.
 */
export function selectDatabase(request: Request, env: DashboardEnv): DashboardEnv {
  if (cookie(request, DATABASE_COOKIE) !== "staging") return env;
  if (!env.STAGING_DATABASE_URL) throw new HttpError(503, "staging_unavailable", "The staging database is not configured on this deployment.");
  return { ...env, DATABASE_URL: env.STAGING_DATABASE_URL, DASHBOARD_ENVIRONMENT: "staging" };
}

export function createDashboardApi(dependencies: DashboardDependencies = {}) {
  // Kept for the life of the isolate so the large legacy files are fetched at most every few minutes.
  let legacy: LegacySource | null = dependencies.legacySource ?? null;
  return async function handle(request: Request, baseEnv: DashboardEnv): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/api/health") {
        const staging = cookie(request, DATABASE_COOKIE) === "staging" && Boolean(baseEnv.STAGING_DATABASE_URL);
        return json({
          ok: true,
          environment: staging ? "staging" : baseEnv.DASHBOARD_ENVIRONMENT ?? "unknown",
          canSwitch: Boolean(baseEnv.STAGING_DATABASE_URL),
          emailMode: baseEnv.EMAIL_MODE === "disabled" ? "disabled" : baseEnv.RESEND_API_KEY ? "resend" : "unconfigured",
        });
      }
      const env = selectDatabase(request, baseEnv);
      const response =
        await routeFeedback(request, path, () => dependencies.feedbackStore?.(env) ?? createNeonFeedbackStore(databaseUrl(env)), env, dependencies) ??
        await routeBuilds(request, path, () => dependencies.appConfigStore?.(env) ?? createNeonAppConfigStore(databaseUrl(env))) ??
        await routeProposals(request, path, () => dependencies.proposalStore?.(env) ?? createNeonParkProposalStore(databaseUrl(env))) ??
        await routeImport(request, path, {
          json,
          env,
          requireSameOrigin: () => requireSameOrigin(request),
          drafts: () => dependencies.draftStore?.(env) ?? createNeonDraftStore(databaseUrl(env)),
          legacy: legacy ??= createLegacySource(env, dependencies.fetch),
          fetch: dependencies.fetch,
          randomSeed: dependencies.randomSeed ?? (() => Math.floor(Math.random() * 1_000_001)),
        });
      return response ?? json({ error: { code: "not_found", message: "API route not found." } }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
