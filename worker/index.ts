import { renderOperatorEmail, renderReceiptEmail } from "./emails.js";
import { getClientAddress, keyedHash, requestOriginAllowed } from "./security.js";
import { createNeonFeedbackStore } from "./store.js";
import type { FeedbackStore, MailIntent, ResendPayload } from "./store.js";
import { sendEmail } from "./feedbackDelivery.js";
import { handleInteractionRequest, handleRetentionRequest, retentionAuthorized, type InteractionDependencies, type InteractionEnv } from "./interactions.js";
import { handleAuthRequest, requireAccount, requireAccountMutation, resumeAccountDeletion, purgeAuthRetention, type AuthDependencies, type AuthEnvironment } from "./accounts/auth.js";
import { deleteAccountData, handleProgressRequest, type ProgressDependencies, type ProgressEnv } from "./accounts/progress.js";
import { createNeonAppConfigStore, handleAppConfigRequest, type AppConfigStore } from "./appConfig.js";
import { createNeonParkProposalStore, handleParkProposalRequest, type ParkProposalStore } from "./parkProposals.js";
import { createNeonSocialStore, handleSocialRequest, type SocialStore } from "./social.js";
import {
  HttpError,
  readJsonBody,
  validateFeedbackBody,
  type EmailAudience,
  type FeedbackEmailReport,
  type ValidatedFeedback,
} from "./validation.js";

export interface WorkerEnvironment extends InteractionEnv, AuthEnvironment, ProgressEnv {
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
  EMAIL_MODE?: "resend" | "disabled" | string;
  ALLOWED_ORIGINS?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

export interface WorkerExecutionContext {
  waitUntil?(promise: Promise<unknown>): void;
}

export interface WorkerDependencies {
  auth?: AuthDependencies;
  progress?: ProgressDependencies;
  interactions?: InteractionDependencies;
  createStore?(env: WorkerEnvironment): FeedbackStore;
  createAppConfigStore?(env: WorkerEnvironment): AppConfigStore;
  createParkProposalStore?(env: WorkerEnvironment): ParkProposalStore;
  createSocialStore?(env: WorkerEnvironment): SocialStore;
  friendCode?(): string;
  fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  now?(): number;
  uuid?(): string;
}

const BASIC_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function getStore(env: WorkerEnvironment, dependencies: WorkerDependencies): FeedbackStore {
  if (dependencies.createStore) return dependencies.createStore(env);
  if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "Feedback service is unavailable.");
  return createNeonFeedbackStore(env.DATABASE_URL);
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
  const interactionResponse = await handleInteractionRequest(request, env, dependencies.interactions);
  if (interactionResponse) return interactionResponse;
  const retentionResponse = await handleRetentionRequest(request, env, dependencies.interactions);
  if (retentionResponse) {
    if (!retentionResponse.ok) return retentionResponse;
    const interactionResult = await retentionResponse.json() as { deleted: number; remainingExpired: number };
    const authResult = await purgeAuthRetention(env, dependencies.auth);
    return json({ ...interactionResult, authDeleted: authResult.deleted, remainingExpired: interactionResult.remainingExpired + authResult.remainingExpired });
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
  if (path === "/api/social" || path.startsWith("/api/social/")) {
    const auth = request.method === "GET"
      ? await requireAccount(request, env, authDependencies)
      : await requireAccountMutation(request, env, authDependencies);
    const socialResponse = await handleSocialRequest(request, {
      json,
      accountId: auth.accountId,
      newCode: dependencies.friendCode,
      store: () => {
        if (dependencies.createSocialStore) return dependencies.createSocialStore(env);
        if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "Friends are unavailable.");
        return createNeonSocialStore(env.DATABASE_URL);
      },
    });
    if (socialResponse) return socialResponse;
  }
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
    store: () => {
      if (dependencies.createAppConfigStore) return dependencies.createAppConfigStore(env);
      if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "App configuration is unavailable.");
      return createNeonAppConfigStore(env.DATABASE_URL);
    },
  });
  if (appConfigResponse) return appConfigResponse;
  const proposalResponse = await handleParkProposalRequest(request, {
    json,
    ipHash: async () => {
      if (!env.SESSION_SECRET || new TextEncoder().encode(env.SESSION_SECRET).length < 32) {
        throw new HttpError(503, "service_unavailable", "Park proposals are unavailable.");
      }
      return keyedHash(env.SESSION_SECRET, "proposal-ip", getClientAddress(request));
    },
    newId: () => requestUuid(dependencies),
    store: () => {
      if (dependencies.createParkProposalStore) return dependencies.createParkProposalStore(env);
      if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "Park proposals are unavailable.");
      return createNeonParkProposalStore(env.DATABASE_URL);
    },
  });
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
  headers.set("access-control-allow-headers", "Content-Type, Authorization, X-CSRF-Token, X-Kip-Auth-Transport, X-Kip-Account-ID, X-Content-SHA256");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createFeedbackWorker(dependencies: WorkerDependencies = {}) {
  return {
    async fetch(request: Request, env: WorkerEnvironment, context: WorkerExecutionContext = {}): Promise<Response> {
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
    },
  };
}

const worker = createFeedbackWorker();
export default worker;
