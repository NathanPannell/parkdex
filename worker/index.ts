import { renderOperatorEmail, renderReceiptEmail } from "./emails.js";
import { createSessionToken, getClientAddress, isSameOriginWrite, keyedHash, readSessionCookie, requestOriginAllowed, sessionCookie, clearSessionCookie, verifyOperatorPassword, verifySessionToken } from "./security.js";
import { createNeonFeedbackStore } from "./store.js";
import type { FeedbackCursor, FeedbackStore, MailIntent, ResendPayload } from "./store.js";
import { handleInteractionRequest, handleRetentionRequest, type InteractionDependencies, type InteractionEnv } from "./interactions.js";
import { handleAuthRequest, requireAccount, requireAccountMutation, resumeAccountDeletion, purgeAuthRetention, type AuthDependencies, type AuthEnvironment } from "./accounts/auth.js";
import { deleteAccountData, handleProgressRequest, type ProgressDependencies, type ProgressEnv } from "./accounts/progress.js";
import {
  HttpError,
  readJsonBody,
  validateFeedbackBody,
  validateRetryBody,
  validateStatus,
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
  PUBLIC_APP_URL?: string;
  SESSION_SECRET?: string;
  OPERATOR_PASSWORD_HASH?: string;
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
  fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  now?(): number;
  uuid?(): string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASIC_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_URL = "https://api.resend.com/emails";
const RESPONSE_TIMEOUT_MS = 8_000;

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

function validEmail(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized.length <= 254 && BASIC_EMAIL.test(normalized) ? normalized : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

async function readProviderMessageId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("id" in body)) return null;
    const id = (body as { id?: unknown }).id;
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : null;
  } catch {
    return null;
  }
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
      ? renderOperatorEmail(report, { appUrl: appUrl(env, request) })
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

async function markEmailFailure(
  store: FeedbackStore,
  reportId: string,
  audience: EmailAudience,
  leaseToken: string,
  state: "failed" | "ambiguous",
  message: string,
): Promise<boolean> {
  try {
    await store.finishEmail(reportId, audience, leaseToken, state, message);
    return true;
  } catch {
    // A still-leased row is recovered safely by the next explicit retry.
    return false;
  }
}

async function sendEmail(
  store: FeedbackStore,
  env: WorkerEnvironment,
  dependencies: WorkerDependencies,
  reportId: string,
  audience: EmailAudience,
  confirmAmbiguousAfter24h: boolean,
  onlyIfPending = false,
): Promise<{ audience: EmailAudience; status: string; error?: string }> {
  const before = await store.getEmailDelivery(reportId, audience);
  if (!before) return { audience, status: "skipped" };
  if (before.status === "sent" || before.status === "disabled") return { audience, status: "skipped" };
  if (onlyIfPending && before.status !== "pending") return { audience, status: "skipped" };
  if (env.EMAIL_MODE === "disabled") {
    await store.markEmailDisabled(reportId, audience);
    return { audience, status: "disabled" };
  }
  if (before.lastError === "Email template could not be rendered.") {
    return { audience, status: "failed", error: "Email template could not be rendered; this saved message cannot be retried." };
  }

  const leaseToken = requestUuid(dependencies);
  const claim = await store.claimEmail(reportId, audience, leaseToken, confirmAmbiguousAfter24h);
  if (claim.status !== "claimed") {
    if (claim.status === "ambiguous" && before.lastAttemptAt && requestNow(dependencies) - Date.parse(before.lastAttemptAt) >= 24 * 60 * 60 * 1000 && !confirmAmbiguousAfter24h) {
      return { audience, status: "requires_confirmation", error: "Provider outcome is unknown; confirm before retrying after 24 hours." };
    }
    return { audience, status: "skipped" };
  }
  const email = claim.email;
  if (!env.RESEND_API_KEY) {
    const persisted = await markEmailFailure(store, reportId, audience, leaseToken, "failed", "Email provider is not configured.");
    return { audience, status: persisted ? "failed" : "ambiguous", error: "Email provider is not configured." };
  }
  if (!email.recipient || !email.payload.from || email.payload.to.length === 0) {
    const persisted = await markEmailFailure(store, reportId, audience, leaseToken, "failed", "Email recipient or sender is not configured.");
    return { audience, status: persisted ? "failed" : "ambiguous", error: "Email recipient or sender is not configured." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);
  try {
    const response = await (dependencies.fetch ?? fetch)(RESEND_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": email.idempotencyKey,
      },
      body: JSON.stringify(email.payload),
      signal: controller.signal,
    });
    if (response.ok) {
      const providerMessageId = await readProviderMessageId(response);
      try {
        await store.finishEmail(reportId, audience, leaseToken, "sent", null, providerMessageId);
        return { audience, status: "sent" };
      } catch {
        return { audience, status: "ambiguous", error: "Provider accepted the message, but its saved status is pending recovery." };
      }
    }
    const ambiguous = response.status === 408 || response.status === 409 || response.status >= 500;
    const message = ambiguous
      ? `Email provider returned HTTP ${response.status}; delivery outcome is uncertain.`
      : `Email provider rejected the message (HTTP ${response.status}).`;
    const persisted = await markEmailFailure(store, reportId, audience, leaseToken, ambiguous ? "ambiguous" : "failed", message);
    return { audience, status: ambiguous || !persisted ? "ambiguous" : "failed", error: message };
  } catch {
    const message = "Email delivery outcome is uncertain after a network failure.";
    await markEmailFailure(store, reportId, audience, leaseToken, "ambiguous", message);
    return { audience, status: "ambiguous", error: message };
  } finally {
    clearTimeout(timeout);
  }
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

function sameOriginRequired(request: Request): void {
  if (!isSameOriginWrite(request)) throw new HttpError(403, "forbidden", "This write must come from the same origin.");
}

async function requireOperator(request: Request, env: WorkerEnvironment): Promise<void> {
  if (!await verifySessionToken(readSessionCookie(request), env.SESSION_SECRET)) {
    throw new HttpError(401, "unauthorized", "Operator sign-in is required.");
  }
}

async function login(request: Request, env: WorkerEnvironment, dependencies: WorkerDependencies): Promise<Response> {
  sameOriginRequired(request);
  const store = getStore(env, dependencies);
  if (!env.SESSION_SECRET || new TextEncoder().encode(env.SESSION_SECRET).length < 32) {
    throw new HttpError(503, "service_unavailable", "Operator sign-in is unavailable.");
  }
  const ipHash = await keyedHash(env.SESSION_SECRET, "operator-login-ip", getClientAddress(request));
  if (!await store.consumeLoginRateLimit(ipHash)) {
    return json({ error: { code: "rate_limited", message: "Too many sign-in attempts. Try again later." }, code: "rate_limited", message: "Too many sign-in attempts. Try again later." }, 429, { "retry-after": "900" });
  }
  const body = await readJsonBody(request, 4096);
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => key !== "password")) {
    throw new HttpError(400, "invalid_request", "Invalid sign-in request.");
  }
  const password = (body as Record<string, unknown>).password;
  const valid = typeof password === "string" && await verifyOperatorPassword(password, env.OPERATOR_PASSWORD_HASH);
  if (!valid) throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
  const token = await createSessionToken(env.SESSION_SECRET, requestNow(dependencies));
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(token) });
}

function clearLogin(request: Request): Response {
  sameOriginRequired(request);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

function validReportId(value: string): boolean {
  return UUID.test(value);
}

function parseAttachmentBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
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
  const deletionResume = /^\/api\/operator\/account-deletions\/([0-9a-f-]{36})\/resume$/i.exec(path);
  if (deletionResume && request.method === "POST") {
    sameOriginRequired(request);
    await requireOperator(request, env);
    const result = await resumeAccountDeletion(deletionResume[1], env, authDependencies);
    return json(result, result.complete ? 200 : 202);
  }
  if (path === "/api/feedback" && request.method === "POST") return submitFeedback(request, env, dependencies);
  if (path === "/api/operator/login" && request.method === "POST") return login(request, env, dependencies);
  if (path === "/api/operator/logout" && request.method === "POST") return clearLogin(request);
  if (path === "/api/operator/session" && request.method === "GET") {
    return json({ authenticated: await verifySessionToken(readSessionCookie(request), env.SESSION_SECRET) });
  }

  if (path === "/api/operator/feedback" && request.method === "GET") {
    await requireOperator(request, env);
    const store = getStore(env, dependencies);
    const statuses = ["all", "new", "reviewing", "planned", "closed"] as const;
    const statusValue = url.searchParams.get("status") ?? "all";
    if (!statuses.includes(statusValue as (typeof statuses)[number]) || url.searchParams.getAll("status").length > 1 || url.searchParams.getAll("cursor").length > 1) {
      throw new HttpError(400, "invalid_query", "Invalid feedback list query.");
    }
    const statusFilter = statusValue === "all" ? null : validateStatus(statusValue);
    const cursorToken = url.searchParams.get("cursor");
    const cursor = cursorToken ? decodeListCursor(cursorToken, statusValue) : null;
    const reports = await store.listReports(31, statusFilter, cursor);
    const page = reports.slice(0, 30);
    const nextCursor = reports.length > 30 && page.length > 0
      ? encodeListCursor(page[page.length - 1], statusValue)
      : null;
    return json({ reports: page, nextCursor });
  }

  const detailMatch = /^\/api\/operator\/feedback\/([^/]+)$/.exec(path);
  const attachmentMatch = /^\/api\/operator\/feedback\/([^/]+)\/attachment$/.exec(path);
  const retryMatch = /^\/api\/operator\/feedback\/([^/]+)\/retry-emails$/.exec(path);
  if (attachmentMatch && request.method === "GET") {
    await requireOperator(request, env);
    const id = attachmentMatch[1];
    if (!validReportId(id)) throw new HttpError(404, "not_found", "Feedback report not found.");
    const store = getStore(env, dependencies);
    const attachment = await store.getAttachment(id);
    if (!attachment) throw new HttpError(404, "not_found", "Screenshot not found.");
    const bytes = parseAttachmentBase64(attachment.base64);
    return new Response(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": attachment.contentType,
        "content-length": String(bytes.byteLength),
        "content-disposition": `inline; filename="feedback-${id}-attachment"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (retryMatch && request.method === "POST") {
    sameOriginRequired(request);
    await requireOperator(request, env);
    const id = retryMatch[1];
    if (!validReportId(id)) throw new HttpError(404, "not_found", "Feedback report not found.");
    const store = getStore(env, dependencies);
    const report = await store.getReport(id);
    if (!report) throw new HttpError(404, "not_found", "Feedback report not found.");
    const retryBody = request.body ? validateRetryBody(await readJsonBody(request, 4096)) : { audiences: null, confirmAmbiguousAfter24h: false };
    const selected = retryBody.audiences ?? report.emails.map((email) => email.audience);
    const results = await Promise.all(selected.map((audience) => sendEmail(store, env, dependencies, id, audience, retryBody.confirmAmbiguousAfter24h)));
    return json({ results });
  }
  if (detailMatch && (request.method === "GET" || request.method === "PATCH")) {
    if (request.method === "PATCH") sameOriginRequired(request);
    await requireOperator(request, env);
    const id = detailMatch[1];
    if (!validReportId(id)) throw new HttpError(404, "not_found", "Feedback report not found.");
    const store = getStore(env, dependencies);
    if (request.method === "GET") {
      const report = await store.getReport(id);
      if (!report) throw new HttpError(404, "not_found", "Feedback report not found.");
      return json({ report });
    }
    const body = await readJsonBody(request, 4096);
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => key !== "status")) {
      throw new HttpError(400, "invalid_request", "Invalid feedback update.");
    }
    const status = validateStatus((body as Record<string, unknown>).status);
    const report = await store.updateStatus(id, status);
    if (!report) throw new HttpError(404, "not_found", "Feedback report not found.");
    return json({ report });
  }

  if (path === "/api" || path.startsWith("/api/")) return json({ error: { code: "not_found", message: "API route not found." }, code: "not_found", message: "API route not found." }, 404);
  return json({ error: { code: "not_found", message: "API route not found." } }, 404);
}

function encodeListCursor(report: { id: string; createdAt: string }, status: string): string {
  const binary = new TextEncoder().encode(JSON.stringify({ id: report.id, createdAt: report.createdAt, status }));
  let raw = "";
  for (const byte of binary) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeListCursor(value: string, expectedStatus: string): FeedbackCursor {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, "invalid_cursor", "Invalid feedback cursor.");
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (Object.keys(parsed).length !== 3 || typeof parsed.id !== "string" || !UUID.test(parsed.id) ||
      typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) || parsed.status !== expectedStatus) {
      throw new Error("invalid cursor");
    }
    return { id: parsed.id.toLowerCase(), createdAt: new Date(parsed.createdAt).toISOString() };
  } catch {
    throw new HttpError(400, "invalid_cursor", "Invalid feedback cursor.");
  }
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
