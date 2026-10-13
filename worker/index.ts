import { renderOperatorEmail, renderReceiptEmail } from "./emails.js";
import { getClientAddress, keyedHash, requestOriginAllowed } from "./security.js";
import { createNeonFeedbackStore } from "./store.js";
import { feedbackRetentionCutoff, purgeArchivedFeedbackFromDatabase, type FeedbackPurgeResult } from "./feedbackArchive.js";
import type { FeedbackStore, MailIntent, ResendPayload } from "./store.js";
import { sendEmail } from "./feedbackDelivery.js";
import { handleInteractionRequest, handleRetentionRequest, retentionAuthorized, type InteractionDependencies, type InteractionEnv } from "./interactions.js";
import { handleAuthRequest, requireAccount, requireAccountMutation, resumeAccountDeletion, purgeAuthRetention, type AuthDependencies, type AuthEnvironment } from "./accounts/auth.js";
import { deleteAccountData, handleProgressRequest, type ProgressDependencies, type ProgressEnv } from "./accounts/progress.js";
import { createNeonAppConfigStore, handleAppConfigRequest, type AppConfigStore } from "./appConfig.js";
import { createNeonOsmSearchLimiter, handleParkProposalRequest } from "./parkProposals.js";
import { createOsmClient, handleOsmParksRequest, type OsmClient } from "./osmParks.js";
import { createSqlOsmParkTable, type OsmParkTable } from "./osmParkTable.js";
import { createSqlProposalReviewStore, databaseSqlRunner, type ProposalReviewStore } from "./proposalReview.js";
import { handleGameRequest, type GameDependencies, type GameEnv, type GameEvent } from "./game.js";
import { handleFriendsRequest, type FriendsDependencies } from "./friends.js";
import { handleFoundersRequest } from "./founders.js";
import { createNeonFoundersStore, type FoundersStore } from "./founders-store.js";
import { purgeFoundingPhotos, type FoundingPurgeResult } from "./founding-reviews.js";
import { database } from "./db.js";
import { createPhotoChecker, type PhotoChecker } from "./founderPhoto.js";
import { appBundleOrigin, handleAppUpdateRequest } from "./appUpdates.js";
import { createAnalyticsSink, posthogConfig, withRequestAnalytics, type AnalyticsSink } from "./analyticsSink.js";
import { emitEvent, REQUEST_CONTEXT_HEADERS } from "./requestContext.js";
import {
  HttpError,
  readJsonBody,
  validateFeedbackBody,
  type EmailAudience,
  type FeedbackEmailReport,
  type ValidatedFeedback,
} from "./validation.js";

export interface WorkerEnvironment extends InteractionEnv, AuthEnvironment, ProgressEnv, GameEnv {
  DATABASE_URL?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  OPERATOR_EMAIL?: string;
  /** Base URL of the operator dashboard deployment, used for links in operator emails. */
  OPERATOR_DASHBOARD_URL?: string;
  PUBLIC_APP_URL?: string;
  SESSION_SECRET?: string;
  RELEASE_SHA?: string;
  /** Local QA only: serves over-the-air bundle pointers instead of the public asset CDN. */
  APP_BUNDLE_ORIGIN?: string;
  EMAIL_MODE?: "resend" | "disabled" | string;
  ALLOWED_ORIGINS?: string;
  /** Public PostHog project key. Without it nothing is sent to PostHog. */
  POSTHOG_PROJECT_KEY?: string;
  POSTHOG_HOST?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** OpenStreetMap services behind the park outline search. */
  OVERPASS_URLS?: string;
  OVERPASS_URL?: string;
  NOMINATIM_URL?: string;
}

export interface WorkerExecutionContext {
  waitUntil?(promise: Promise<unknown>): void;
}

export interface WorkerDependencies {
  auth?: AuthDependencies;
  progress?: ProgressDependencies;
  interactions?: InteractionDependencies;
  game?: GameDependencies;
  friends?: FriendsDependencies;
  createStore?(env: WorkerEnvironment): FeedbackStore;
  /** Deletes feedback archived on the operator board more than 90 days before `cutoff`. */
  purgeArchivedFeedback?(env: WorkerEnvironment, cutoff: string): Promise<FeedbackPurgeResult>;
  /** Deletes founding photos kept for a manual review once they expire (worker/founding-reviews.ts). */
  purgeFoundingPhotos?(env: WorkerEnvironment, now: number): Promise<FoundingPurgeResult>;
  createAppConfigStore?(env: WorkerEnvironment): AppConfigStore;
  analytics?(env: WorkerEnvironment): AnalyticsSink | null;
  /** Catalogue lookups around a point (matching outlines, regions). */
  createProposalReviewStore?(env: WorkerEnvironment): ProposalReviewStore;
  createFoundersStore?(env: WorkerEnvironment): FoundersStore;
  /** Undefined uses the shared moderation module; null turns the photo model off. */
  photoChecker?: PhotoChecker | null;
  osmClient?: OsmClient;
  /** Our own copy of OpenStreetMap park outlines; defaults to kip_osm.parks in DATABASE_URL. */
  osmParkTable?(env: WorkerEnvironment): OsmParkTable | null;
  osmSearchAllowed?(subjectHash: string): Promise<boolean>;
  fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  now?(): number;
  uuid?(): string;
}

const BASIC_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Catalogue parks this close to the position are checked against search results, to mark them "Already on the map".
const CATALOGUE_MATCH_KM = 5;

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const retryAfter = error.status === 429 ? error.code === "rate_limited" ? "3600" : "900" : undefined;
    const headers = retryAfter ? { "retry-after": retryAfter } : undefined;
    return json({ error: { code: error.code, message: error.message }, code: error.code, message: error.message }, error.status, headers);
  }
  return json({ error: { code: "service_unavailable", message: "Service temporarily unavailable." }, code: "service_unavailable", message: "Service temporarily unavailable." }, 503);
}

/** Game outcomes become analytics events on the request that caused them. */
function recordGameEvent(event: GameEvent): void {
  emitEvent(event.name, { parkId: event.parkId, pointsEarned: event.pointsEarned });
}

function getStore(env: WorkerEnvironment, dependencies: WorkerDependencies): FeedbackStore {
  if (dependencies.createStore) return dependencies.createStore(env);
  if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "Feedback service is unavailable.");
  return createNeonFeedbackStore(env.DATABASE_URL);
}

function purgeFoundingPhotosFromDatabase(databaseUrl: string, now: number): Promise<FoundingPurgeResult> {
  const sql = database(databaseUrl);
  return purgeFoundingPhotos((text, params) => sql.query(text, params) as Promise<Record<string, unknown>[]>, now);
}

function requestUuid(dependencies: WorkerDependencies): string {
  return dependencies.uuid?.() ?? crypto.randomUUID();
}

function requestNow(dependencies: WorkerDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer).then((digest) => Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(""));
}

async function payloadHash(feedback: ValidatedFeedback): Promise<string> {
  const screenshotHash = feedback.screenshot ? await sha256Hex(feedback.screenshot.bytes) : null;
  const canonical = JSON.stringify({
    submissionId: feedback.submissionId,
    kind: feedback.kind,
    message: feedback.message,
    email: feedback.email,
    contact: feedback.contact,
    context: feedback.context,
    screenshotHash,
  });
  return sha256Hex(new TextEncoder().encode(canonical));
}

function appUrl(env: WorkerEnvironment, request: Request): string {
  const candidate = env.PUBLIC_APP_URL ?? new URL(request.url).origin;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return new URL(request.url).origin;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return new URL(request.url).origin;
  }
}

// A malformed dashboard URL must not turn every operator email into a render failure.
function dashboardUrl(env: WorkerEnvironment): string | undefined {
  const value = env.OPERATOR_DASHBOARD_URL?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function validEmail(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized.length <= 254 && BASIC_EMAIL.test(normalized) ? normalized : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function fallbackEmail(report: FeedbackEmailReport, audience: EmailAudience): { subject: string; html: string; text: string } {
  const receipt = audience === "receipt";
  return {
    subject: receipt ? "Parkdex got your note" : `Parkdex feedback: ${report.kind}`,
    html: receipt ? "<p>Your feedback has been saved. Thank you for helping improve Parkdex.</p>" : `<p>${escapeHtml(report.message).replace(/\n/g, "<br>")}</p>`,
    text: receipt ? "Your feedback has been saved. Thank you for helping improve Parkdex." : report.message,
  };
}

function buildMailIntent(
  audience: EmailAudience,
  report: FeedbackEmailReport,
  env: WorkerEnvironment,
  request: Request,
): MailIntent {
  const from = env.EMAIL_FROM?.trim() ?? "";
  const recipient = audience === "operator" ? env.OPERATOR_EMAIL?.trim() ?? "" : report.email ?? "";
  const replyTo = audience === "operator"
    ? (report.contact ? validEmail(report.email ?? undefined) : validEmail(env.EMAIL_REPLY_TO))
    : validEmail(env.EMAIL_REPLY_TO);
  let rendered: { subject: string; html: string; text: string };
  let renderError: string | null = null;
  try {
    rendered = audience === "operator"
      ? renderOperatorEmail(report, { appUrl: appUrl(env, request), reviewUrl: dashboardUrl(env) })
      : renderReceiptEmail(report, { appUrl: appUrl(env, request) });
  } catch {
    rendered = fallbackEmail(report, audience);
    renderError = "Email template could not be rendered.";
  }
  const payload: ResendPayload = {
    from,
    to: recipient ? [recipient] : [],
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };
  if (replyTo) payload.reply_to = replyTo;
  const missing = renderError ?? (!recipient
    ? audience === "operator" ? "Operator email recipient is not configured." : "Receipt recipient is not available."
    : !from ? "Email sender is not configured."
      : !env.RESEND_API_KEY ? "Email provider is not configured."
        : null);
  return {
    audience,
    recipient,
    payload,
    idempotencyKey: `feedback-${report.id}-${audience}-v1`,
    initialStatus: env.EMAIL_MODE === "disabled" ? "pending" : renderError || missing ? "failed" : "pending",
    initialError: env.EMAIL_MODE === "disabled" ? null : renderError ?? missing,
  };
}

function mailReport(feedback: ValidatedFeedback, id: string, createdAt: string): FeedbackEmailReport {
  return {
    id,
    kind: feedback.kind,
    message: feedback.message,
    email: feedback.email,
    contact: feedback.contact,
    context: feedback.context,
    createdAt,
    hasScreenshot: feedback.screenshot !== null,
  };
}

async function submitFeedback(request: Request, env: WorkerEnvironment, dependencies: WorkerDependencies): Promise<Response> {
  const body = await readJsonBody(request);
  const feedback = validateFeedbackBody(body);
  if (!env.SESSION_SECRET || new TextEncoder().encode(env.SESSION_SECRET).length < 32) {
    throw new HttpError(503, "service_unavailable", "Feedback service is unavailable.");
  }
  const store = getStore(env, dependencies);
  const existing = await store.findBySubmissionId(feedback.submissionId);
  const hash = await payloadHash(feedback);
  if (existing) {
    if (existing.payloadHash !== hash) throw new HttpError(409, "submission_id_reused", "This submission ID was already used for different feedback.");
    const report = await store.getReport(existing.id);
    if (!report) throw new HttpError(503, "service_unavailable", "Feedback service is temporarily unavailable.");
    return json({ id: report.id, notification: notificationFromReport(report) }, 200);
  }

  const ipHash = await keyedHash(env.SESSION_SECRET, "feedback-ip", getClientAddress(request));
  const recipientHash = feedback.email ? await keyedHash(env.SESSION_SECRET, "feedback-email", feedback.email) : null;
  const id = requestUuid(dependencies);
  const createdAt = new Date(requestNow(dependencies)).toISOString();
  const emailReport = mailReport(feedback, id, createdAt);
  const mails = [buildMailIntent("operator", emailReport, env, request)];
  if (feedback.email) mails.push(buildMailIntent("receipt", emailReport, env, request));
  const result = await store.saveFeedback({ id, payloadHash: hash, ipHash, recipientHash, createdAt, feedback, mails });
  if (result.status === "conflict") throw new HttpError(409, "submission_id_reused", "This submission ID was already used for different feedback.");
  if (result.status === "rate_limited") throw new HttpError(429, "rate_limited", "Please wait before sending more feedback.");
  if (result.status === "duplicate") return json({ id: result.report.id, notification: notificationFromReport(result.report) }, 200);

  await Promise.all(result.report.emails.map(async (mail) => {
    if (mail.status === "pending") {
      try { await sendEmail(store, env, dependencies, result.report.id, mail.audience, false, true); } catch {
        // Report durability is independent of email delivery.
      }
    }
  }));
  let current = result.report;
  try { current = await store.getReport(result.report.id) ?? current; } catch { /* Preserve the states returned with the committed report. */ }
  return json({ id: current.id, notification: notificationFromReport(current) }, 201);
}

function notificationFromReport(report: { emails: Array<{ audience: EmailAudience; status: string }> }): { operator?: string; receipt?: string } {
  const result: { operator?: string; receipt?: string } = {};
  for (const delivery of report.emails) {
    if (delivery.status === "pending" || delivery.status === "sending" || delivery.status === "sent" || delivery.status === "failed" || delivery.status === "ambiguous" || delivery.status === "disabled") {
      result[delivery.audience] = delivery.status;
    }
  }
  return result;
}

async function routeApi(request: Request, env: WorkerEnvironment, dependencies: WorkerDependencies, context: WorkerExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/health" && request.method === "GET") return json({ ok: true, releaseSha: env.RELEASE_SHA ?? null });
  const updateResponse = await handleAppUpdateRequest(request, {
    json,
    fetch: (input, init) => (dependencies.fetch ?? globalThis.fetch)(input, init),
    origin: appBundleOrigin(env.APP_BUNDLE_ORIGIN),
  });
  if (updateResponse) return updateResponse;
  const interactionResponse = await handleInteractionRequest(request, env, dependencies.interactions);
  if (interactionResponse) return interactionResponse;
  const retentionResponse = await handleRetentionRequest(request, env, dependencies.interactions);
  if (retentionResponse) {
    if (!retentionResponse.ok) return retentionResponse;
    const interactionResult = await retentionResponse.json() as { deleted: number; remainingExpired: number };
    const authResult = await purgeAuthRetention(env, dependencies.auth);
    // Archived feedback rides on the same daily run. Its backlog is reported on its own, because
    // the photo Worker's cron measures progress by the interaction and auth deletions only.
    const feedbackCutoff = feedbackRetentionCutoff(requestNow(dependencies));
    const feedbackResult = dependencies.purgeArchivedFeedback
      ? await dependencies.purgeArchivedFeedback(env, feedbackCutoff)
      : env.DATABASE_URL ? await purgeArchivedFeedbackFromDatabase(env.DATABASE_URL, feedbackCutoff) : { deleted: 0, remainingExpired: 0 };
    // Founding photos kept for a manual review (#153): unrequested ones after a day, decided ones after 90 days.
    const foundingResult = dependencies.purgeFoundingPhotos
      ? await dependencies.purgeFoundingPhotos(env, requestNow(dependencies))
      : env.DATABASE_URL ? await purgeFoundingPhotosFromDatabase(env.DATABASE_URL, requestNow(dependencies)) : { deleted: 0, remainingExpired: 0 };
    return json({
      ...interactionResult,
      authDeleted: authResult.deleted,
      remainingExpired: interactionResult.remainingExpired + authResult.remainingExpired,
      feedbackDeleted: feedbackResult.deleted,
      feedbackRemainingExpired: feedbackResult.remainingExpired,
      foundingPhotosDeleted: foundingResult.deleted,
      foundingPhotosRemainingExpired: foundingResult.remainingExpired,
    });
  }
  const authDependencies: AuthDependencies = {
    ...dependencies.auth,
    waitUntil: dependencies.auth?.waitUntil ?? context.waitUntil,
    deleteAccountData: dependencies.auth?.deleteAccountData ?? ((input) => deleteAccountData(input, env, {
      createStore: dependencies.progress?.createStore,
      fetch: dependencies.progress?.fetch,
    })),
  };
  const authResponse = await handleAuthRequest(request, env, authDependencies);
  if (authResponse) return authResponse;
  if (path === "/api/claims" || path.startsWith("/api/claims/")) {
    const auth = request.method === "GET"
      ? await requireAccount(request, env, authDependencies)
      : await requireAccountMutation(request, env, authDependencies);
    const progressResponse = await handleProgressRequest(request, env, auth, dependencies.progress);
    if (progressResponse) return progressResponse;
  }
  const gameResponse = await handleGameRequest(request, env, {
    account: () => requireAccount(request, env, authDependencies),
    mutation: () => requireAccountMutation(request, env, authDependencies),
  }, { fetch: dependencies.fetch, now: dependencies.now, onEvent: recordGameEvent, publicOrigin: appUrl(env, request), ...dependencies.game });
  if (gameResponse) return gameResponse;
  const friendsResponse = await handleFriendsRequest(request, env, {
    account: () => requireAccount(request, env, authDependencies),
    mutation: () => requireAccountMutation(request, env, authDependencies),
  }, { now: dependencies.now, ...dependencies.friends });
  if (friendsResponse) return friendsResponse;
  const reviewStore = () => {
    if (dependencies.createProposalReviewStore) return dependencies.createProposalReviewStore(env);
    if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "Parks are unavailable.");
    return createSqlProposalReviewStore(databaseSqlRunner(env.DATABASE_URL));
  };
  const foundersStore = () => {
    if (dependencies.createFoundersStore) return dependencies.createFoundersStore(env);
    if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "Becoming a founder isn't available right now.");
    return createNeonFoundersStore(env.DATABASE_URL);
  };
  const foundersResponse = await handleFoundersRequest(request, {
    store: foundersStore,
    osm: () => dependencies.osmClient!,
    photoChecker: () => dependencies.photoChecker === undefined
      ? (env.OPENROUTER_API_KEY?.trim() ? createPhotoChecker(env, dependencies.fetch) : null)
      : dependencies.photoChecker,
    mutation: () => requireAccountMutation(request, env, authDependencies),
    optionalAccount: async () => {
      try {
        return await requireAccount(request, env, authDependencies);
      } catch (error) {
        // The summary is public; a missing or expired session just leaves out "your visits".
        if (error instanceof HttpError && [401, 403, 503].includes(error.status)) return null;
        throw error;
      }
    },
    nearbyParks: (lat, lng, km) => reviewStore().nearbyParks(lat, lng, km),
    publicOrigin: appUrl(env, request),
    now: () => requestNow(dependencies),
    uuid: () => requestUuid(dependencies),
    emit: (type, properties) => emitEvent(type, properties),
  });
  if (foundersResponse) return foundersResponse;
  // Manual recovery for a partially failed account deletion. Uses the retention machine secret.
  const deletionResume = /^\/api\/recovery\/account-deletions\/([0-9a-f-]{36})\/resume$/i.exec(path);
  if (deletionResume && request.method === "POST") {
    if (!env.KIP_RETENTION_SECRET || !retentionAuthorized(request, env.KIP_RETENTION_SECRET)) {
      throw new HttpError(401, "unauthorized", "Recovery authorization is required.");
    }
    const result = await resumeAccountDeletion(deletionResume[1], env, authDependencies);
    return json(result, result.complete ? 200 : 202);
  }
  const appConfigResponse = await handleAppConfigRequest(request, {
    json,
    analytics: () => {
      const posthog = posthogConfig(env);
      return posthog ? { posthogKey: posthog.key, posthogHost: posthog.host } : null;
    },
    store: () => {
      if (dependencies.createAppConfigStore) return dependencies.createAppConfigStore(env);
      if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "App configuration is unavailable.");
      return createNeonAppConfigStore(env.DATABASE_URL);
    },
  });
  if (appConfigResponse) return appConfigResponse;
  const sessionSecret = () => {
    if (!env.SESSION_SECRET || new TextEncoder().encode(env.SESSION_SECRET).length < 32) {
      throw new HttpError(503, "service_unavailable", "Park search is unavailable.");
    }
    return env.SESSION_SECRET;
  };
  const osmResponse = await handleOsmParksRequest(request, {
    json,
    allow: async () => {
      const subject = await keyedHash(sessionSecret(), "osm-ip", getClientAddress(request));
      if (dependencies.osmSearchAllowed) return dependencies.osmSearchAllowed(subject);
      if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "Park search is unavailable.");
      return createNeonOsmSearchLimiter(env.DATABASE_URL)(subject);
    },
    osm: () => dependencies.osmClient!,
    catalogue: !dependencies.createProposalReviewStore && !env.DATABASE_URL ? undefined : (lat, lng) =>
      reviewStore().nearbyParks(lat, lng, CATALOGUE_MATCH_KM),
    founders: !dependencies.createFoundersStore && !env.DATABASE_URL ? undefined : async (parkIds) => {
      const store = foundersStore();
      const [founders, hidden] = await Promise.all([store.founders(parkIds), store.hidden(parkIds)]);
      return { founders, hidden };
    },
  });
  if (osmResponse) return osmResponse;
  const proposalResponse = await handleParkProposalRequest(request);
  if (proposalResponse) return proposalResponse;
  if (path === "/api/feedback" && request.method === "POST") return submitFeedback(request, env, dependencies);

  if (path === "/api" || path.startsWith("/api/")) return json({ error: { code: "not_found", message: "API route not found." }, code: "not_found", message: "API route not found." }, 404);
  return json({ error: { code: "not_found", message: "API route not found." } }, 404);
}

async function route(request: Request, env: WorkerEnvironment, context: WorkerExecutionContext, dependencies: WorkerDependencies): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return routeApi(request, env, dependencies, context);
  }
  if (env.ASSETS) {
    try { return await env.ASSETS.fetch(request); } catch { return new Response("Not found", { status: 404 }); }
  }
  return new Response("Not found", { status: 404 });
}

function withCors(request: Request, env: WorkerEnvironment, response: Response): Response {
  const origin = request.headers.get("origin");
  if (!origin || !requestOriginAllowed(request, env)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", `Content-Type, Authorization, X-CSRF-Token, X-Kip-Auth-Transport, X-Kip-Account-ID, X-Content-SHA256, ${REQUEST_CONTEXT_HEADERS.join(", ")}`);
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createFeedbackWorker(dependencies: WorkerDependencies = {}) {
  // One client per instance so its short cache and concurrency cap span requests.
  let osm = dependencies.osmClient ?? null;
  const table = (env: WorkerEnvironment) => dependencies.osmParkTable
    ? dependencies.osmParkTable(env)
    : env.DATABASE_URL ? createSqlOsmParkTable(databaseSqlRunner(env.DATABASE_URL)) : null;
  const withOsm = (env: WorkerEnvironment): WorkerDependencies =>
    ({ ...dependencies, osmClient: osm ??= createOsmClient(env, dependencies.fetch as typeof fetch | undefined, { table: table(env) }) });
  return {
    async fetch(request: Request, env: WorkerEnvironment, context: WorkerExecutionContext = {}): Promise<Response> {
      return withRequestAnalytics({
        method: request.method,
        path: new URL(request.url).pathname,
        header: (name) => request.headers.get(name),
        env: env as Record<string, string | undefined>,
        sink: () => dependencies.analytics ? dependencies.analytics(env) : createAnalyticsSink(env),
        waitUntil: context.waitUntil ? (promise) => context.waitUntil?.(promise) : undefined,
      }, () => handleWorkerRequest(request, env, context, withOsm(env)));
    },
  };
}

async function handleWorkerRequest(request: Request, env: WorkerEnvironment, context: WorkerExecutionContext, dependencies: WorkerDependencies): Promise<Response> {
  try {
    if (request.headers.has("origin") && !requestOriginAllowed(request, env)) {
      return json({ error: { code: "forbidden", message: "Origin is not allowed." }, code: "forbidden", message: "Origin is not allowed." }, 403);
    }
    const path = new URL(request.url).pathname;
    if ((path === "/api" || path.startsWith("/api/")) && request.method === "OPTIONS") {
      const response = new Response(null, { status: 204 });
      return withCors(request, env, response);
    }
    return withCors(request, env, await route(request, env, context, dependencies));
  } catch (error) {
    return withCors(request, env, errorResponse(error));
  }
}

const worker = createFeedbackWorker();
export default worker;
