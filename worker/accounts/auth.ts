import { waitUntil as vercelWaitUntil } from "@vercel/functions";
import { OAuth2Client } from "google-auth-library";
import { argon2id, hash as argonHash, verify as argonVerify } from "argon2";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { HttpError } from "../validation.js";
import { getClientAddress, requestOriginAllowed } from "../security.js";
import {
  createNeonAccountAuthStore,
  type AccountAuthStore,
  type AccountCredentials,
  type AccountSummary,
  type AuthTransport,
  type GoogleChallengeInput,
  type GoogleSignInResult,
  type SessionInsert,
  type StoredSession,
  type StoredTransport,
} from "./auth-store.js";

export interface AuthEnvironment {
  DATABASE_URL?: string;
  AUTH_SESSION_SECRET?: string;
  RESEND_API_KEY?: string;
  AUTH_EMAIL_FROM?: string;
  EMAIL_MODE?: string;
  GOOGLE_WEB_CLIENT_ID?: string;
  PUBLIC_APP_URL?: string;
  ALLOWED_ORIGINS?: string;
}

export interface AuthContext {
  accountId: string;
  sessionId: string;
  transport: AuthTransport;
}

export interface GoogleIdentityClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  name?: string;
}

export interface AccountDeletionDataResult {
  complete: boolean;
}

export interface AuthDependencies {
  createStore?(env: AuthEnvironment): AccountAuthStore;
  now?(): number;
  uuid?(): string;
  hashPassword?(password: string): Promise<string>;
  verifyPassword?(passwordHash: string, password: string): Promise<boolean>;
  verifyGoogleIdToken?(idToken: string, audience: string): Promise<GoogleIdentityClaims>;
  sendEmail?(message: { to: string; subject: string; html: string; text: string }, env: AuthEnvironment): Promise<void>;
  fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  waitUntil?(promise: Promise<unknown>): void;
  deleteAccountData?(input: { accountId: string; receiptId: string }, env: AuthEnvironment): Promise<AccountDeletionDataResult>;
}

interface SessionMaterial {
  token: string;
  csrfToken: string | null;
  record: SessionInsert;
}

interface SessionLookup {
  stored: StoredSession;
  context: AuthContext;
}

const SESSION_COOKIE = "kip_account_session";
const CSRF_COOKIE = "kip_account_csrf";
const CSRF_HEADER = "x-csrf-token";
const ACCOUNT_ID_HEADER = "x-kip-account-id";
export const ACCOUNT_CSRF_HEADER = "X-CSRF-Token";
export const ACCOUNT_CSRF_COOKIE = CSRF_COOKIE;
const TRANSPORT_HEADER = "x-kip-auth-transport";
const RESET_LIFETIME_MS = 60 * 60 * 1000;
const VERIFICATION_LIFETIME_MS = 60 * 60 * 1000;
const GOOGLE_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const SESSION_SLIDING_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const REAUTH_LIFETIME_MS = 5 * 60 * 1000;
const AUTH_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const AUTH_RATE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const AUTH_RETENTION_BATCH_LIMIT = 5_000;
const PASSWORD_OPTIONS = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32 } as const;
const GOOGLE_CLIENT_ID_PATTERN = /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TOKEN_FIELDS = new Set(["token"]);
const PASSWORD_RESET_FIELDS = new Set(["token", "newPassword"]);
const REGISTER_FIELDS = new Set(["email", "password", "displayName"]);
const EMAIL_PASSWORD_FIELDS = new Set(["email", "password"]);
const EMAIL_FIELD = new Set(["email"]);
const GOOGLE_CHALLENGE_FIELDS = new Set(["purpose"]);
const GOOGLE_TOKEN_FIELDS = new Set(["idToken", "nonce"]);
const REAUTH_FIELDS = new Set(["password"]);
const INVALID_LOGIN_MESSAGE = "Email or password is incorrect.";
let dummyHashPromise: Promise<string> | undefined;

class RateLimitError extends HttpError {
  constructor(retryAfterSeconds: number) {
    super(429, "rate_limited", "Too many requests. Try again later.");
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }

  readonly retryAfterSeconds: number;
}

function nowValue(dependencies: AuthDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function uuidValue(dependencies: AuthDependencies): string {
  return dependencies.uuid?.() ?? randomUUID();
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  const output = new Headers(headers);
  output.set("content-type", "application/json; charset=utf-8");
  output.set("cache-control", "no-store");
  output.set("x-content-type-options", "nosniff");
  output.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(value), { status, headers: output });
}

function noContent(headers?: HeadersInit): Response {
  const output = new Headers(headers);
  output.set("cache-control", "no-store");
  output.set("x-content-type-options", "nosniff");
  output.set("referrer-policy", "no-referrer");
  return new Response(null, { status: 204, headers: output });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const headers = error instanceof RateLimitError ? { "retry-after": String(error.retryAfterSeconds) } : undefined;
    return jsonResponse({ error: { code: error.code, message: error.message }, code: error.code, message: error.message }, error.status, headers);
  }
  return jsonResponse({ error: { code: "service_unavailable", message: "Service temporarily unavailable." }, code: "service_unavailable", message: "Service temporarily unavailable." }, 503);
}

function requireSecret(env: AuthEnvironment): string {
  const secret = env.AUTH_SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new HttpError(503, "service_unavailable", "Account authentication is unavailable.");
  }
  return secret;
}

function getStore(env: AuthEnvironment, dependencies: AuthDependencies): AccountAuthStore {
  if (dependencies.createStore) return dependencies.createStore(env);
  if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "Account authentication is unavailable.");
  return createNeonAccountAuthStore(env.DATABASE_URL);
}

function authAvailable(env: AuthEnvironment): boolean {
  return Boolean(env.DATABASE_URL && env.AUTH_SESSION_SECRET && Buffer.byteLength(env.AUTH_SESSION_SECRET, "utf8") >= 32);
}

function validGoogleClientId(value: string | undefined): value is string {
  return Boolean(value && value.length <= 255 && GOOGLE_CLIENT_ID_PATTERN.test(value));
}

function emailLinkBase(env: AuthEnvironment): URL | null {
  let base: URL;
  try { base = new URL(env.PUBLIC_APP_URL ?? ""); } catch { return null; }
  const localHttp = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !localHttp) || base.username || base.password || !base.hostname) return null;
  return base;
}

function emailProviderConfigured(env: AuthEnvironment): boolean {
  return env.EMAIL_MODE !== "disabled" && Boolean(env.RESEND_API_KEY && env.AUTH_EMAIL_FROM);
}

function emailDeliveryEnabled(env: AuthEnvironment): boolean {
  return emailProviderConfigured(env) && Boolean(emailLinkBase(env));
}

function requireEmailDelivery(env: AuthEnvironment): void {
  if (!emailDeliveryEnabled(env)) throw new HttpError(503, "service_unavailable", "Email verification and recovery are unavailable.");
}

function bytesToken(): string {
  return randomBytes(32).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacScope(secret: string, action: string, scope: string): string {
  return createHmac("sha256", secret).update(`kip-account\u0000${action}\u0000${scope}`, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, required: string[] = []): void {
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) {
    throw new HttpError(400, "invalid_request", "Invalid request.");
  }
}

async function readJson(request: Request, limit = 8 * 1024): Promise<Record<string, unknown>> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && (!/^\d+$/u.test(lengthHeader) || Number(lengthHeader) > limit)) {
    throw new HttpError(413, "request_too_large", "Request body is too large.");
  }
  if (!request.body) throw new HttpError(400, "invalid_request", "Invalid request.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large", "Request body is too large.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid request.");
  }
}

function stringField(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new HttpError(400, "invalid_request", `Invalid ${field}.`);
  }
  return value;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_request", "Invalid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email) || email.includes("\r") || email.includes("\n")) {
    throw new HttpError(400, "invalid_request", "Invalid email address.");
  }
  return email;
}

function passwordField(value: unknown, name = "password"): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_request", `Invalid ${name}.`);
  const length = Array.from(value).length;
  if (length < 12 || length > 128 || Buffer.byteLength(value, "utf8") > 512) {
    throw new HttpError(400, "invalid_request", `${name === "newPassword" ? "New password" : "Password"} must contain 12 to 128 characters.`);
  }
  return value;
}

function displayNameField(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "invalid_request", "Invalid display name.");
  const name = value.trim();
  if (!name || Array.from(name).length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new HttpError(400, "invalid_request", "Display name must contain 1 to 80 characters.");
  }
  return name;
}

async function passwordHash(password: string, dependencies: AuthDependencies): Promise<string> {
  return dependencies.hashPassword?.(password) ?? argonHash(password, PASSWORD_OPTIONS);
}

async function passwordMatches(hashValue: string, password: string, dependencies: AuthDependencies): Promise<boolean> {
  try {
    return dependencies.verifyPassword ? await dependencies.verifyPassword(hashValue, password) : await argonVerify(hashValue, password);
  } catch {
    return false;
  }
}

function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= argonHash(bytesToken(), PASSWORD_OPTIONS);
  return dummyHashPromise;
}

function sessionMaterial(transport: StoredTransport, now: number, dependencies: AuthDependencies): SessionMaterial {
  const token = bytesToken();
  const csrfToken = transport === "web" ? bytesToken() : null;
  const createdAt = new Date(now);
  return {
    token,
    csrfToken,
    record: {
      id: uuidValue(dependencies),
      tokenHash: sha256(token),
      csrfHash: csrfToken ? sha256(csrfToken) : null,
      transport,
      expiresAt: new Date(now + SESSION_SLIDING_MS).toISOString(),
      absoluteExpiresAt: new Date(now + SESSION_ABSOLUTE_MS).toISOString(),
    },
  };
}

function parseCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return value.length <= 256 ? value : null;
}

function parseCredential(request: Request): { token: string; transport: AuthTransport } | null {
  const authorization = request.headers.get("authorization");
  const cookieToken = parseCookie(request, SESSION_COOKIE);
  if (authorization && cookieToken) return null;
  if (authorization !== null) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/iu.exec(authorization);
    return match ? { token: match[1], transport: "bearer" } : null;
  }
  if (cookieToken && TOKEN_PATTERN.test(cookieToken)) return { token: cookieToken, transport: "cookie" };
  return null;
}

function sessionContext(stored: StoredSession, transport: AuthTransport): AuthContext | null {
  const expected = transport === "bearer" ? "native" : "web";
  if (stored.transport !== expected) return null;
  return { accountId: stored.id, sessionId: stored.sessionId, transport };
}

async function lookupSession(request: Request, env: AuthEnvironment, dependencies: AuthDependencies): Promise<SessionLookup | null> {
  if (!authAvailable(env)) return null;
  const credential = parseCredential(request);
  if (!credential) return null;
  const store = getStore(env, dependencies);
  const stored = await store.findSession(sha256(credential.token));
  if (!stored) return null;
  const context = sessionContext(stored, credential.transport);
  return context ? { stored, context } : null;
}

function assertTrustedOrigin(request: Request, env: AuthEnvironment, requireOrigin: boolean): void {
  const origin = request.headers.get("origin");
  if ((!origin && requireOrigin) || (origin && !requestOriginAllowed(request, env))) {
    throw new HttpError(403, "forbidden", "Origin is not allowed.");
  }
}

function assertCookieCsrf(request: Request, env: AuthEnvironment, session: StoredSession): void {
  assertTrustedOrigin(request, env, true);
  const headerToken = request.headers.get(CSRF_HEADER);
  const cookieToken = parseCookie(request, CSRF_COOKIE);
  if (!headerToken || !cookieToken || headerToken.length > 128 || headerToken !== cookieToken || !TOKEN_PATTERN.test(headerToken)) {
    throw new HttpError(403, "csrf_failed", "Request could not be verified.");
  }
  const actual = sha256(headerToken);
  if (!session.csrfHash || !safeEqual(actual, session.csrfHash)) {
    throw new HttpError(403, "csrf_failed", "Request could not be verified.");
  }
}

function assertExpectedAccount(request: Request, accountId: string): void {
  if (request.headers.get(ACCOUNT_ID_HEADER) !== accountId) {
    throw new HttpError(409, "account_changed", "The active account changed in another tab. Refresh and try again.");
  }
}

export async function authenticateAccount(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthDependencies = {},
): Promise<AuthContext | null> {
  return (await lookupSession(request, env, dependencies))?.context ?? null;
}

export async function requireAccount(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthDependencies = {},
): Promise<AuthContext> {
  if (!authAvailable(env)) throw new HttpError(503, "service_unavailable", "Account authentication is unavailable.");
  const context = await authenticateAccount(request, env, dependencies);
  if (!context) throw new HttpError(401, "authentication_required", "Authentication required.");
  assertExpectedAccount(request, context.accountId);
  return context;
}

export async function requireAccountMutation(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthDependencies = {},
): Promise<AuthContext> {
  const lookup = await lookupSession(request, env, dependencies);
  if (!lookup) {
    if (!authAvailable(env)) throw new HttpError(503, "service_unavailable", "Account authentication is unavailable.");
    throw new HttpError(401, "authentication_required", "Authentication required.");
  }
  if (lookup.context.transport === "cookie") assertCookieCsrf(request, env, lookup.stored);
  else assertTrustedOrigin(request, env, false);
  assertExpectedAccount(request, lookup.context.accountId);
  return lookup.context;
}

function sessionCookie(token: string, expiresAt: string, now: number): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/api; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function csrfCookie(token: string, expiresAt: string, now: number): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${CSRF_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`;
}

function clearAuthCookies(): string[] {
  return [
    `${SESSION_COOKIE}=; Path=/api; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`,
    `${CSRF_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Strict`,
  ];
}

function appendCookie(headers: Headers, value: string): void {
  headers.append("set-cookie", value);
}

function sessionResponse(
  account: AccountSummary,
  token: string,
  csrfToken: string | null,
  expiresAt: string,
  transport: StoredTransport,
  status = 200,
  now = Date.now(),
): Response {
  if (transport === "native") return jsonResponse({ account, sessionToken: token, expiresAt }, status);
  if (!csrfToken) throw new Error("web session is missing a CSRF token");
  const headers = new Headers();
  appendCookie(headers, sessionCookie(token, expiresAt, now));
  appendCookie(headers, csrfCookie(csrfToken, expiresAt, now));
  return jsonResponse({ account, expiresAt }, status, headers);
}

function transportHint(request: Request): StoredTransport {
  const value = request.headers.get(TRANSPORT_HEADER)?.toLowerCase();
  if (value === null || value === undefined || value === "web") return "web";
  if (value === "native") return "native";
  throw new HttpError(400, "invalid_request", "Invalid authentication transport.");
}

function requireMethod(request: Request, method: string): void {
  if (request.method !== method) throw new HttpError(405, "method_not_allowed", "Method not allowed.");
}

async function reserveLimit(
  env: AuthEnvironment,
  store: AccountAuthStore,
  action: string,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<string> {
  const secret = requireSecret(env);
  const scopeHash = hmacScope(secret, action, scope);
  const result = await store.reserveRateLimit(action, scopeHash, limit, windowMs);
  if (!result.allowed) {
    await store.recordSecurityEvent(`${action}_rate_limit`, scopeHash, "throttled").catch(() => undefined);
    throw new RateLimitError(result.retryAfterSeconds);
  }
  return scopeHash;
}

async function reserveIpLimit(
  env: AuthEnvironment,
  store: AccountAuthStore,
  request: Request,
  action: string,
  limit: number,
  windowMs: number,
): Promise<string> {
  return reserveLimit(env, store, action, getClientAddress(request), limit, windowMs);
}

async function eventScope(env: AuthEnvironment, action: string, value: string): Promise<string> {
  return hmacScope(requireSecret(env), action, value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
}

function authMailHtml(link: string, kind: "verification" | "password_reset"): string {
  const action = kind === "verification" ? "verify your email address" : "reset your password";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Parkdex account</title></head><body style="margin:0;background:#fff8ec;color:#14231c;font-family:Arial,Helvetica,sans-serif"><main style="max-width:560px;margin:32px auto;padding:32px;background:#fffdf8;border:1px solid #ead6b6;border-radius:20px"><p style="font-weight:800;letter-spacing:.1em">PARKDEX</p><h1 style="font-size:28px">${kind === "verification" ? "Verify your email" : "Reset your password"}</h1><p>Use this link to ${action}. It expires in one hour and works once.</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 20px;background:#ff5a1f;color:#14231c;font-weight:700;text-decoration:none;border-radius:12px">${kind === "verification" ? "Verify email" : "Reset password"}</a></p><p style="font-size:13px;overflow-wrap:anywhere">If the button does not work, paste this address into Kip:<br>${escapeHtml(link)}</p><p style="font-size:13px">If you did not request this, you can ignore this email.</p></main></body></html>`;
}

function authMailText(link: string, kind: "verification" | "password_reset"): string {
  const action = kind === "verification" ? "verify your email address" : "reset your password";
  return `Parkdex account\n\nUse this link to ${action}. It expires in one hour and works once:\n${link}\n\nIf you did not request this, you can ignore this email.`;
}

function authLink(env: AuthEnvironment, kind: "verification" | "password_reset", token: string): string {
  const base = emailLinkBase(env);
  if (!base) {
    throw new HttpError(503, "service_unavailable", "Account email links are unavailable.");
  }
  base.search = "";
  base.hash = "";
  base.pathname = `${base.pathname.replace(/\/+$/u, "")}/account`;
  base.hash = `${kind === "verification" ? "verificationToken" : "resetToken"}=${encodeURIComponent(token)}`;
  return base.toString();
}

async function sendResendEmail(
  message: { to: string; subject: string; html: string; text: string },
  env: AuthEnvironment,
  dependencies: AuthDependencies,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM) throw new Error("email provider unavailable");
  const response = await (dependencies.fetch ?? fetch)("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.AUTH_EMAIL_FROM, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("email provider rejected the request");
}

function queueEmail(
  message: { to: string; subject: string; html: string; text: string },
  env: AuthEnvironment,
  dependencies: AuthDependencies,
  store: AccountAuthStore,
  eventType: string,
  scopeHash: string,
): void {
  const delivery = (dependencies.sendEmail
    ? dependencies.sendEmail(message, env)
    : sendResendEmail(message, env, dependencies))
    .catch(async () => {
      await store.recordSecurityEvent(eventType, scopeHash, "delivery_failed").catch(() => undefined);
    });
  try {
    (dependencies.waitUntil ?? vercelWaitUntil)(delivery);
  } catch {
    // Vercel invokes waitUntil in a request context; local callers can inject one.
    void delivery;
  }
}

function accountResult(account: AccountSummary): { account: AccountSummary } {
  return { account };
}

async function requireFreshSession(lookup: SessionLookup, now: number): Promise<void> {
  const reauthenticatedAt = lookup.stored.reauthenticatedAt ? Date.parse(lookup.stored.reauthenticatedAt) : Number.NaN;
  if (!Number.isFinite(reauthenticatedAt) || reauthenticatedAt < now - REAUTH_LIFETIME_MS) {
    throw new HttpError(403, "reauthentication_required", "Please reauthenticate before continuing.");
  }
}

async function googleClaims(
  idToken: string,
  audience: string,
  expectedNonce: string,
  now: number,
  dependencies: AuthDependencies,
): Promise<GoogleIdentityClaims> {
  let claims: GoogleIdentityClaims;
  try {
    if (dependencies.verifyGoogleIdToken) {
      claims = await dependencies.verifyGoogleIdToken(idToken, audience);
    } else {
      const ticket = await new OAuth2Client(audience).verifyIdToken({ idToken, audience, maxExpiry: 3_600 });
      const payload = ticket.getPayload();
      if (!payload) throw new Error("missing payload");
      claims = payload as GoogleIdentityClaims;
    }
  } catch {
    throw new HttpError(401, "invalid_google_token", "Google sign-in could not be verified.");
  }
  if (!record(claims)) throw new HttpError(401, "invalid_google_token", "Google sign-in could not be verified.");
  const expMillis = claims.exp * 1000;
  const iatMillis = claims.iat * 1000;
  const audienceMatches = claims.aud === audience;
  const issuerMatches = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!claims || typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 255 ||
      !audienceMatches || !issuerMatches || !Number.isFinite(expMillis) || expMillis <= now ||
      !Number.isFinite(iatMillis) || iatMillis > now + 60_000 || expMillis - iatMillis > 3_600_000 ||
      claims.email_verified !== true || !EMAIL_PATTERN.test(email) || claims.nonce !== expectedNonce) {
    throw new HttpError(401, "invalid_google_token", "Google sign-in could not be verified.");
  }
  return { ...claims, email };
}

function googleName(claims: GoogleIdentityClaims): string | null {
  if (typeof claims.name !== "string") return null;
  const name = claims.name.trim();
  return name && Array.from(name).length <= 80 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
}

function validActionToken(value: unknown): string {
  const token = stringField(value, 128, "token");
  if (!TOKEN_PATTERN.test(token)) throw new HttpError(400, "invalid_token", "This link is invalid or has expired.");
  return token;
}

function methodForAuthRoute(path: string): string | null {
  const methods: Record<string, string> = {
    "/api/auth/config": "GET",
    "/api/auth/register": "POST",
    "/api/auth/login": "POST",
    "/api/auth/me": "GET",
    "/api/auth/sessions/renew": "POST",
    "/api/auth/logout": "POST",
    "/api/auth/verification/request": "POST",
    "/api/auth/verification/confirm": "POST",
    "/api/auth/password-reset/request": "POST",
    "/api/auth/password-reset/confirm": "POST",
    "/api/auth/google/challenge": "POST",
    "/api/auth/google": "POST",
    "/api/auth/google/native": "POST",
    "/api/auth/reauth/password": "POST",
    "/api/account": "DELETE",
  };
  return methods[path] ?? null;
}

async function routeAuth(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthDependencies,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const expectedMethod = methodForAuthRoute(path);
  if (!expectedMethod) return path === "/api/auth" || path.startsWith("/api/auth/") || path === "/api/account" ? jsonResponse({ error: { code: "not_found", message: "Account API route not found." }, code: "not_found", message: "Account API route not found." }, 404) : null;
  if (request.method === "OPTIONS") return noContent({ allow: "GET, POST, DELETE, OPTIONS" });
  if (request.method !== expectedMethod) return jsonResponse({ error: { code: "method_not_allowed", message: "Method not allowed." }, code: "method_not_allowed", message: "Method not allowed." }, 405, { allow: `${expectedMethod}, OPTIONS` });

  const now = nowValue(dependencies);
  const nowIso = new Date(now).toISOString();
  const origin = request.headers.get("origin");
  if (origin && !requestOriginAllowed(request, env)) throw new HttpError(403, "forbidden", "Origin is not allowed.");

  if (path === "/api/auth/config") {
    const enabled = authAvailable(env);
    const originAllowed = !origin || requestOriginAllowed(request, env);
    const clientId = enabled && originAllowed && validGoogleClientId(env.GOOGLE_WEB_CLIENT_ID) ? env.GOOGLE_WEB_CLIENT_ID : null;
    const googleNativeEnabled = Boolean(clientId);
    const googleWebEnabled = Boolean(clientId && originAllowed);
    const emailEnabled = enabled;
    const mailEnabled = emailEnabled && emailDeliveryEnabled(env);
    return jsonResponse({
      emailEnabled,
      emailDeliveryEnabled: mailEnabled,
      googleEnabled: googleNativeEnabled || googleWebEnabled,
      googleWebEnabled,
      googleNativeEnabled,
      googleWebClientId: googleWebEnabled ? clientId : null,
      capabilities: {
        web: { email: emailEnabled, google: googleWebEnabled },
        native: { email: emailEnabled, google: googleNativeEnabled },
      },
    });
  }

  if (!authAvailable(env)) throw new HttpError(503, "service_unavailable", "Account authentication is unavailable.");
  requireSecret(env);
  const store = getStore(env, dependencies);

  if (path === "/api/auth/register") {
    const transport = transportHint(request);
    if (transport === "web") assertTrustedOrigin(request, env, true);
    if (emailProviderConfigured(env) && !emailLinkBase(env)) {
      throw new HttpError(503, "service_unavailable", "Account email links are unavailable.");
    }
    const body = await readJson(request);
    exactKeys(body, REGISTER_FIELDS, ["email", "password"]);
    const email = normalizeEmail(body.email);
    const password = passwordField(body.password);
    const displayName = displayNameField(body.displayName);
    const emailScope = await reserveLimit(env, store, "register_email", email, 5, 60 * 60 * 1000);
    await reserveIpLimit(env, store, request, "register_ip", 20, 60 * 60 * 1000);
    await reserveLimit(env, store, "register_global", "global", 500, 15 * 60 * 1000);
    const passwordDigest = await passwordHash(password, dependencies);
    const session = sessionMaterial(transport, now, dependencies);
    const verificationToken = emailDeliveryEnabled(env) ? bytesToken() : null;
    const result = await store.createAccount({
      accountId: uuidValue(dependencies),
      email,
      passwordHash: passwordDigest,
      displayName,
      session: session.record,
      verificationTokenHash: verificationToken ? sha256(verificationToken) : null,
      verificationExpiresAt: verificationToken ? new Date(now + VERIFICATION_LIFETIME_MS).toISOString() : null,
    });
    if (!result) throw new HttpError(409, "email_in_use", "An account with this email already exists.");
    await store.recordSecurityEvent("register", emailScope, "succeeded").catch(() => undefined);
    if (verificationToken && emailDeliveryEnabled(env)) {
      const link = authLink(env, "verification", verificationToken);
      queueEmail({ to: email, subject: "Verify your Parkdex email", html: authMailHtml(link, "verification"), text: authMailText(link, "verification") }, env, dependencies, store, "verification_email", emailScope);
    }
    return sessionResponse(result.account, session.token, session.csrfToken, result.expiresAt, transport, 201, now);
  }

  if (path === "/api/auth/login") {
    const transport = transportHint(request);
    if (transport === "web") assertTrustedOrigin(request, env, true);
    const body = await readJson(request);
    exactKeys(body, EMAIL_PASSWORD_FIELDS, ["email", "password"]);
    const email = normalizeEmail(body.email);
    const password = passwordField(body.password);
    const emailScope = await reserveLimit(env, store, "login_email", email, 5, 15 * 60 * 1000);
    await reserveIpLimit(env, store, request, "login_ip", 30, 15 * 60 * 1000);
    const account = await store.findAccountByEmail(email);
    const dummyHash = await dummyPasswordHash();
    const encoded = account?.passwordHash ?? dummyHash;
    const passwordValid = await passwordMatches(encoded, password, dependencies);
    if (!account || account.deletionState !== "active" || !account.passwordHash || !passwordValid) {
      await store.recordSecurityEvent("login", emailScope, "failed").catch(() => undefined);
      throw new HttpError(401, "invalid_credentials", INVALID_LOGIN_MESSAGE);
    }
    await store.clearRateLimit("login_email", emailScope).catch(() => undefined);
    const session = sessionMaterial(transport, now, dependencies);
    const result = await store.createSession(account.id, session.record);
    if (!result) throw new HttpError(401, "invalid_credentials", INVALID_LOGIN_MESSAGE);
    await store.recordSecurityEvent("login", emailScope, "succeeded").catch(() => undefined);
    return sessionResponse(result.account, session.token, session.csrfToken, result.expiresAt, transport, 200, now);
  }

  if (path === "/api/auth/me") {
    const lookup = await lookupSession(request, env, dependencies);
    if (!lookup) throw new HttpError(401, "authentication_required", "Authentication required.");
    const account = await store.findAccountById(lookup.context.accountId);
    if (!account || account.deletionState !== "active") throw new HttpError(401, "authentication_required", "Authentication required.");
    return jsonResponse(accountResult({
      id: account.id,
      email: account.email,
      emailVerified: account.emailVerified,
      displayName: account.displayName,
      providers: account.providers,
    }));
  }

  if (path === "/api/auth/sessions/renew") {
    const lookup = await lookupSession(request, env, dependencies);
    if (!lookup) throw new HttpError(401, "authentication_required", "Authentication required.");
    if (lookup.context.transport === "cookie") assertCookieCsrf(request, env, lookup.stored);
    else assertTrustedOrigin(request, env, false);
    assertExpectedAccount(request, lookup.context.accountId);
    const expiry = Date.parse(lookup.stored.expiresAt);
    if (!Number.isFinite(expiry) || expiry - now > SESSION_RENEW_BEFORE_MS) {
      return jsonResponse({ renewed: false, expiresAt: lookup.stored.expiresAt });
    }
    const transport = lookup.stored.transport;
    const material = sessionMaterial(transport, now, dependencies);
    const expiresAt = await store.rotateSession(lookup.stored.sessionId, lookup.stored.tokenHash, material.record, nowIso);
    if (!expiresAt) throw new HttpError(401, "session_expired", "Your session has expired. Sign in again.");
    if (transport === "native") return jsonResponse({ renewed: true, sessionToken: material.token, expiresAt });
    if (!material.csrfToken) throw new Error("web renewal is missing a CSRF token");
    const headers = new Headers();
    appendCookie(headers, sessionCookie(material.token, expiresAt, now));
    appendCookie(headers, csrfCookie(material.csrfToken, expiresAt, now));
    return jsonResponse({ renewed: true, expiresAt }, 200, headers);
  }

  if (path === "/api/auth/logout") {
    const lookup = await lookupSession(request, env, dependencies);
    if (!lookup) {
      assertTrustedOrigin(request, env, false);
      return noContent(clearAuthCookies().map((cookie) => ["set-cookie", cookie]));
    }
    if (lookup.context.transport === "cookie") assertCookieCsrf(request, env, lookup.stored);
    else assertTrustedOrigin(request, env, false);
    assertExpectedAccount(request, lookup.context.accountId);
    await store.revokeSession(lookup.stored.sessionId, lookup.stored.tokenHash, nowIso);
    return noContent(clearAuthCookies().map((cookie) => ["set-cookie", cookie]));
  }

  if (path === "/api/auth/verification/request") {
    requireEmailDelivery(env);
    const lookup = await lookupSession(request, env, dependencies);
    if (!lookup) throw new HttpError(401, "authentication_required", "Authentication required.");
    if (lookup.context.transport === "cookie") assertCookieCsrf(request, env, lookup.stored);
    else assertTrustedOrigin(request, env, false);
    assertExpectedAccount(request, lookup.context.accountId);
    await reserveIpLimit(env, store, request, "verification_request_ip", 10, 15 * 60 * 1000);
    const account = await store.findAccountById(lookup.context.accountId);
    if (account && account.deletionState === "active" && !account.emailVerified) {
      const accountScope = await reserveLimit(env, store, "verification_request", account.id, 3, 15 * 60 * 1000);
      const token = bytesToken();
      const created = await store.issueActionToken(account.id, "verification", sha256(token), new Date(now + VERIFICATION_LIFETIME_MS).toISOString());
      if (created) {
        const link = authLink(env, "verification", token);
        queueEmail({ to: account.email, subject: "Verify your Parkdex email", html: authMailHtml(link, "verification"), text: authMailText(link, "verification") }, env, dependencies, store, "verification_email", accountScope);
      }
    }
    return jsonResponse({ accepted: true }, 202);
  }

  if (path === "/api/auth/verification/confirm") {
    const body = await readJson(request);
    exactKeys(body, TOKEN_FIELDS, ["token"]);
    const token = validActionToken(body.token);
    await reserveIpLimit(env, store, request, "verification_confirm_ip", 30, 15 * 60 * 1000);
    const confirmed = await store.consumeVerificationToken(sha256(token), nowIso);
    if (!confirmed) throw new HttpError(400, "invalid_token", "This link is invalid or has expired.");
    return noContent();
  }

  if (path === "/api/auth/password-reset/request") {
    requireEmailDelivery(env);
    const body = await readJson(request);
    exactKeys(body, EMAIL_FIELD, ["email"]);
    const email = normalizeEmail(body.email);
    const emailScope = await reserveLimit(env, store, "password_reset_request", email, 3, 15 * 60 * 1000);
    await reserveIpLimit(env, store, request, "password_reset_request_ip", 10, 15 * 60 * 1000);
    const account = await store.findAccountByEmail(email);
    if (account && account.deletionState === "active" && account.passwordHash) {
      const token = bytesToken();
      const issued = await store.issueActionToken(account.id, "password_reset", sha256(token), new Date(now + RESET_LIFETIME_MS).toISOString());
      if (issued) {
        const link = authLink(env, "password_reset", token);
        queueEmail({ to: account.email, subject: "Reset your Parkdex password", html: authMailHtml(link, "password_reset"), text: authMailText(link, "password_reset") }, env, dependencies, store, "password_reset_email", emailScope);
      }
    }
    return jsonResponse({ accepted: true }, 202);
  }

  if (path === "/api/auth/password-reset/confirm") {
    const body = await readJson(request);
    exactKeys(body, PASSWORD_RESET_FIELDS, ["token", "newPassword"]);
    const token = validActionToken(body.token);
    const newPassword = passwordField(body.newPassword, "newPassword");
    const tokenHash = sha256(token);
    await reserveLimit(env, store, "password_reset_confirm", token, 5, 60 * 60 * 1000);
    await reserveIpLimit(env, store, request, "password_reset_confirm_ip", 30, 60 * 60 * 1000);
    if (!await store.hasValidActionToken(tokenHash, "password_reset", nowIso)) {
      throw new HttpError(400, "invalid_token", "This link is invalid or has expired.");
    }
    const newHash = await passwordHash(newPassword, dependencies);
    const changed = await store.consumePasswordResetToken(tokenHash, newHash, nowIso);
    if (!changed) throw new HttpError(400, "invalid_token", "This link is invalid or has expired.");
    return noContent(clearAuthCookies().map((cookie) => ["set-cookie", cookie]));
  }

  if (path === "/api/auth/google/challenge") {
    if (!validGoogleClientId(env.GOOGLE_WEB_CLIENT_ID)) throw new HttpError(503, "service_unavailable", "Google sign-in is unavailable.");
    const transport = transportHint(request);
    if (transport === "web") assertTrustedOrigin(request, env, true);
    const body = await readJson(request);
    exactKeys(body, GOOGLE_CHALLENGE_FIELDS, ["purpose"]);
    if (body.purpose !== "sign_in" && body.purpose !== "reauth" && body.purpose !== "link") {
      throw new HttpError(400, "invalid_request", "Invalid Google sign-in purpose.");
    }
    const purpose = body.purpose;
    const globalScope = await reserveLimit(env, store, "google_challenge", "global", 1000, 15 * 60 * 1000);
    await reserveIpLimit(env, store, request, "google_challenge_ip", 40, 15 * 60 * 1000);
    let accountId: string | null = null;
    let sessionId: string | null = null;
    if (purpose !== "sign_in") {
      const lookup = await lookupSession(request, env, dependencies);
      if (!lookup || lookup.stored.transport !== transport) throw new HttpError(401, "authentication_required", "Authentication required.");
      if (lookup.context.transport === "cookie") assertCookieCsrf(request, env, lookup.stored);
      else assertTrustedOrigin(request, env, false);
      assertExpectedAccount(request, lookup.context.accountId);
      if (purpose === "link") await requireFreshSession(lookup, now);
      accountId = lookup.context.accountId;
      sessionId = lookup.context.sessionId;
    }
    const nonce = bytesToken();
    const challenge: GoogleChallengeInput = {
      nonceHash: sha256(nonce),
      purpose,
      transport,
      accountId,
      sessionId,
      expiresAt: new Date(now + GOOGLE_CHALLENGE_LIFETIME_MS).toISOString(),
    };
    await store.createGoogleChallenge(challenge);
    await store.recordSecurityEvent("google_challenge", globalScope, "created").catch(() => undefined);
    return jsonResponse({ nonce, expiresAt: challenge.expiresAt });
  }

  if (path === "/api/auth/google" || path === "/api/auth/google/native") {
    const routeTransport: StoredTransport = path.endsWith("/native") ? "native" : "web";
    if (!validGoogleClientId(env.GOOGLE_WEB_CLIENT_ID)) throw new HttpError(503, "service_unavailable", "Google sign-in is unavailable.");
    if (routeTransport === "web") assertTrustedOrigin(request, env, true);
    const body = await readJson(request, 16 * 1024);
    exactKeys(body, GOOGLE_TOKEN_FIELDS, ["idToken", "nonce"]);
    const idToken = stringField(body.idToken, 12 * 1024, "Google ID token");
    const nonce = stringField(body.nonce, 128, "nonce");
    if (!TOKEN_PATTERN.test(nonce)) throw new HttpError(400, "invalid_request", "Invalid Google sign-in challenge.");
    await reserveIpLimit(env, store, request, "google_callback_ip", 50, 15 * 60 * 1000);
    const nonceScope = sha256(nonce);
    const challenge = await store.consumeGoogleChallenge(nonceScope, nowIso);
    if (!challenge || challenge.transport !== routeTransport) {
      await store.recordSecurityEvent("google_callback", await eventScope(env, "google_callback", nonceScope), "invalid_challenge").catch(() => undefined);
      throw new HttpError(401, "invalid_google_challenge", "Google sign-in could not be verified.");
    }
    const claims = await googleClaims(idToken, env.GOOGLE_WEB_CLIENT_ID, nonce, now, dependencies);
    const scopeHash = await eventScope(env, "google_subject", claims.sub);

    if (challenge.purpose === "sign_in") {
      const email = normalizeEmail(claims.email);
      const session = sessionMaterial(routeTransport, now, dependencies);
      const result: GoogleSignInResult = await store.completeGoogleSignIn({
        subject: claims.sub,
        email,
        displayName: googleName(claims),
        accountId: uuidValue(dependencies),
        session: session.record,
        now: nowIso,
      });
      if (result.status === "email_conflict") {
        await store.recordSecurityEvent("google_callback", scopeHash, "email_collision").catch(() => undefined);
        throw new HttpError(409, "account_conflict", "An account already uses this email. Sign in to that account and link Google from settings.");
      }
      if (result.status !== "ok") throw new HttpError(409, "account_conflict", "Google sign-in could not be completed.");
      await store.recordSecurityEvent("google_callback", scopeHash, "succeeded").catch(() => undefined);
      return sessionResponse(result.account, session.token, session.csrfToken, result.expiresAt, routeTransport, 200, now);
    }

    const lookup = await lookupSession(request, env, dependencies);
    if (!lookup || lookup.context.transport !== (routeTransport === "native" ? "bearer" : "cookie") ||
        lookup.context.accountId !== challenge.accountId || lookup.context.sessionId !== challenge.sessionId) {
      throw new HttpError(401, "authentication_required", "Authentication required.");
    }
    if (lookup.context.transport === "cookie") assertCookieCsrf(request, env, lookup.stored);
    else assertTrustedOrigin(request, env, false);
    assertExpectedAccount(request, lookup.context.accountId);
    if (challenge.purpose === "reauth") {
      const confirmed = await store.completeGoogleReauthentication({
        subject: claims.sub,
        accountId: lookup.context.accountId,
        sessionId: lookup.context.sessionId,
        tokenHash: lookup.stored.tokenHash,
        now: nowIso,
      });
      if (!confirmed) throw new HttpError(403, "reauthentication_failed", "Google sign-in could not reauthenticate this account.");
      const account = await store.findAccountById(lookup.context.accountId);
      if (!account || account.deletionState !== "active") throw new HttpError(401, "authentication_required", "Authentication required.");
      await store.recordSecurityEvent("google_reauth", scopeHash, "succeeded").catch(() => undefined);
      return jsonResponse({ account: accountSummaryFromCredentials(account), reauthenticatedUntil: new Date(now + REAUTH_LIFETIME_MS).toISOString() });
    }

    const linkResult = await store.completeGoogleLink({
      subject: claims.sub,
      email: normalizeEmail(claims.email),
      accountId: lookup.context.accountId,
      sessionId: lookup.context.sessionId,
      tokenHash: lookup.stored.tokenHash,
      now: nowIso,
    });
    if (linkResult === "email_conflict" || linkResult === "subject_conflict") {
      await store.recordSecurityEvent("google_link", scopeHash, linkResult).catch(() => undefined);
      throw new HttpError(409, "account_conflict", "This Google account is linked to another Kip account.");
    }
    if (linkResult !== "ok") throw new HttpError(403, "reauthentication_required", "Please reauthenticate before linking Google.");
    const account = await store.findAccountById(lookup.context.accountId);
    if (!account || account.deletionState !== "active") throw new HttpError(401, "authentication_required", "Authentication required.");
    return jsonResponse({ account: accountSummaryFromCredentials(account) });
  }

  if (path === "/api/auth/reauth/password") {
    const lookup = await lookupSession(request, env, dependencies);
    if (!lookup) throw new HttpError(401, "authentication_required", "Authentication required.");
    if (lookup.context.transport === "cookie") assertCookieCsrf(request, env, lookup.stored);
    else assertTrustedOrigin(request, env, false);
    assertExpectedAccount(request, lookup.context.accountId);
    const body = await readJson(request);
    exactKeys(body, REAUTH_FIELDS, ["password"]);
    const password = passwordField(body.password);
    const scopeHash = await reserveLimit(env, store, "reauth_password", lookup.context.accountId, 5, 15 * 60 * 1000);
    await reserveIpLimit(env, store, request, "reauth_password_ip", 20, 15 * 60 * 1000);
    const account = await store.findAccountById(lookup.context.accountId);
    const dummyHash = await dummyPasswordHash();
    const encoded = account?.passwordHash ?? dummyHash;
    const passwordValid = await passwordMatches(encoded, password, dependencies);
    if (!account || account.deletionState !== "active" || !account.passwordHash || !passwordValid) {
      await store.recordSecurityEvent("reauth_password", scopeHash, "failed").catch(() => undefined);
      throw new HttpError(401, "reauthentication_failed", "Password could not be verified.");
    }
    const confirmed = await store.confirmPasswordReauthentication(account.id, lookup.context.sessionId, lookup.stored.tokenHash, nowIso);
    if (!confirmed) throw new HttpError(401, "authentication_required", "Authentication required.");
    await store.clearRateLimit("reauth_password", scopeHash).catch(() => undefined);
    await store.recordSecurityEvent("reauth_password", scopeHash, "succeeded").catch(() => undefined);
    return jsonResponse({ reauthenticated: true, reauthenticatedUntil: new Date(now + REAUTH_LIFETIME_MS).toISOString() });
  }

  if (path === "/api/account") {
    const lookup = await lookupSession(request, env, dependencies);
    if (!lookup) throw new HttpError(401, "authentication_required", "Authentication required.");
    if (lookup.context.transport === "cookie") assertCookieCsrf(request, env, lookup.stored);
    else assertTrustedOrigin(request, env, false);
    assertExpectedAccount(request, lookup.context.accountId);
    await requireFreshSession(lookup, now);
    if (!dependencies.deleteAccountData) throw new HttpError(503, "service_unavailable", "Account deletion is unavailable.");
    const receiptId = uuidValue(dependencies);
    const receipt = await store.beginDeletion(lookup.context.accountId, lookup.context.sessionId, lookup.stored.tokenHash, receiptId, nowIso);
    if (!receipt) throw new HttpError(403, "reauthentication_required", "Please reauthenticate before deleting this account.");
    const deletion = await resumeAccountDeletion(receipt, env, dependencies);
    const headers = new Headers();
    for (const cookie of clearAuthCookies()) appendCookie(headers, cookie);
    if (deletion.complete) return jsonResponse({ receiptId: receipt, status: "complete" }, 200, headers);
    return jsonResponse({ receiptId: receipt, status: "pending" }, 202, headers);
  }

  return null;
}

function accountSummaryFromCredentials(account: AccountCredentials): AccountSummary {
  return {
    id: account.id,
    email: account.email,
    emailVerified: account.emailVerified,
    displayName: account.displayName,
    providers: account.providers,
  };
}

export async function resumeAccountDeletion(
  receiptId: string,
  env: AuthEnvironment,
  dependencies: AuthDependencies = {},
): Promise<{ receiptId: string; status: "pending" | "complete"; complete: boolean }> {
  if (!/^[0-9a-f-]{36}$/iu.test(receiptId)) throw new HttpError(400, "invalid_receipt", "Invalid account deletion receipt.");
  const store = getStore(env, dependencies);
  const receipt = await store.findDeletionReceipt(receiptId);
  if (!receipt) throw new HttpError(404, "not_found", "Account deletion receipt not found.");
  if (receipt.status === "complete") return { receiptId, status: "complete", complete: true };
  if (!dependencies.deleteAccountData) return { receiptId, status: "pending", complete: false };
  let result: AccountDeletionDataResult;
  try {
    result = await dependencies.deleteAccountData({ accountId: receipt.accountId, receiptId }, env);
  } catch {
    result = { complete: false };
  }
  if (!result.complete) return { receiptId, status: "pending", complete: false };
  const complete = await store.completeDeletion(receiptId, new Date(nowValue(dependencies)).toISOString());
  return { receiptId, status: complete ? "complete" : "pending", complete };
}

export async function purgeAuthRetention(
  env: AuthEnvironment,
  dependencies: AuthDependencies = {},
): Promise<{ deleted: number; remainingExpired: number }> {
  if (!env.DATABASE_URL && !dependencies.createStore) {
    throw new HttpError(503, "service_unavailable", "Account authentication is unavailable.");
  }
  const now = nowValue(dependencies);
  return getStore(env, dependencies).purgeRetention(
    new Date(now).toISOString(),
    new Date(now - AUTH_AUDIT_RETENTION_MS).toISOString(),
    new Date(now - AUTH_RATE_RETENTION_MS).toISOString(),
    AUTH_RETENTION_BATCH_LIMIT,
  );
}

export async function handleAuthRequest(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthDependencies = {},
): Promise<Response | null> {
  try {
    return await routeAuth(request, env, dependencies);
  } catch (error) {
    return errorResponse(error);
  }
}
