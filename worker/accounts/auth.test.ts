import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { handleAuthRequest, resumeAccountDeletion, type AuthDependencies, type AuthEnvironment, type GoogleIdentityClaims } from "./auth.ts";
import type {
  AccountAuthStore,
  AccountCredentials,
  AccountSummary,
  CreateAccountInput,
  DeletionReceipt,
  GoogleChallengeInput,
  GoogleChallengeRecord,
  GoogleLinkResult,
  GoogleSignInInput,
  GoogleSignInResult,
  SessionInsert,
  StoredSession,
} from "./auth-store.ts";

const API_ORIGIN = "https://kip.example.test";
const GOOGLE_CLIENT_ID = "123456789-test.apps.googleusercontent.com";
const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const AUTH_SECRET = "consumer-session-secret-long-enough-for-tests";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function summary(account: AccountCredentials): AccountSummary {
  return {
    id: account.id,
    email: account.email,
    emailVerified: account.emailVerified,
    displayName: account.displayName,
    providers: [...account.providers],
  };
}

class MemoryAuthStore implements AccountAuthStore {
  readonly accounts = new Map<string, AccountCredentials>();
  readonly sessions = new Map<string, StoredSession>();
  readonly revokedSessions = new Set<string>();
  readonly actionTokens = new Map<string, { accountId: string; purpose: "verification" | "password_reset"; expiresAt: string; usedAt: string | null }>();
  readonly challenges = new Map<string, { input: GoogleChallengeInput; consumedAt: string | null }>();
  readonly googleSubjects = new Map<string, string>();
  readonly receipts = new Map<string, DeletionReceipt>();
  readonly events: Array<{ eventType: string; scopeHash: string | null; outcome: string }> = [];
  readonly rates = new Map<string, number>();

  async reserveRateLimit(action: string, scopeHash: string, limit: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const key = `${action}:${scopeHash}`;
    const count = this.rates.get(key) ?? 0;
    if (count >= limit) return { allowed: false, retryAfterSeconds: 60 };
    this.rates.set(key, count + 1);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  async clearRateLimit(action: string, scopeHash: string): Promise<void> {
    this.rates.delete(`${action}:${scopeHash}`);
  }

  async recordSecurityEvent(eventType: string, scopeHash: string | null, outcome: string): Promise<void> {
    this.events.push({ eventType, scopeHash, outcome });
  }

  async createAccount(input: CreateAccountInput) {
    if ([...this.accounts.values()].some((account) => account.email === input.email)) return null;
    const account: AccountCredentials = {
      id: input.accountId,
      email: input.email,
      emailVerified: false,
      displayName: input.displayName,
      providers: ["email"],
      passwordHash: input.passwordHash,
      deletionState: "active",
    };
    this.accounts.set(account.id, account);
    const stored = this.addSession(account, input.session);
    if (input.verificationTokenHash && input.verificationExpiresAt) {
      this.actionTokens.set(input.verificationTokenHash, {
        accountId: account.id,
        purpose: "verification",
        expiresAt: input.verificationExpiresAt,
        usedAt: null,
      });
    }
    return {
      account: summary(account),
      sessionId: stored.sessionId,
      expiresAt: stored.expiresAt,
      absoluteExpiresAt: stored.absoluteExpiresAt,
    };
  }

  addGoogleOnlyAccount(email: string, subject: string): AccountCredentials {
    const account: AccountCredentials = {
      id: randomUUID(), email, emailVerified: true, displayName: null,
      providers: ["google"], passwordHash: null, deletionState: "active",
    };
    this.accounts.set(account.id, account);
    this.googleSubjects.set(subject, account.id);
    return account;
  }

  async findAccountByEmail(email: string): Promise<AccountCredentials | null> {
    return [...this.accounts.values()].find((account) => account.email === email) ?? null;
  }

  async findAccountById(accountId: string): Promise<AccountCredentials | null> {
    const account = this.accounts.get(accountId);
    return account ? { ...account, providers: [...account.providers] } : null;
  }

  async createSession(accountId: string, session: SessionInsert) {
    const account = this.accounts.get(accountId);
    if (!account || account.deletionState !== "active") return null;
    const stored = this.addSession(account, session);
    return {
      account: summary(account),
      sessionId: stored.sessionId,
      expiresAt: stored.expiresAt,
      absoluteExpiresAt: stored.absoluteExpiresAt,
    };
  }

  async findSession(tokenHash: string): Promise<StoredSession | null> {
    const stored = [...this.sessions.values()].find((session) => session.tokenHash === tokenHash);
    if (!stored || this.revokedSessions.has(stored.sessionId)) return null;
    const account = this.accounts.get(stored.id);
    if (!account || account.deletionState !== "active") return null;
    return { ...stored, ...summary(account) };
  }

  async rotateSession(sessionId: string, previousTokenHash: string, session: SessionInsert, now: string): Promise<string | null> {
    const stored = this.sessions.get(sessionId);
    if (!stored || stored.tokenHash !== previousTokenHash || this.revokedSessions.has(sessionId)) return null;
    if (Date.parse(stored.expiresAt) <= Date.parse(now) || Date.parse(stored.expiresAt) > Date.parse(now) + 7 * 24 * 60 * 60 * 1000) return null;
    stored.tokenHash = session.tokenHash;
    stored.csrfHash = session.csrfHash;
    stored.transport = session.transport;
    stored.expiresAt = new Date(Math.min(Date.parse(session.expiresAt), Date.parse(stored.absoluteExpiresAt))).toISOString();
    return stored.expiresAt;
  }

  async revokeSession(sessionId: string, tokenHash: string): Promise<boolean> {
    const stored = this.sessions.get(sessionId);
    if (!stored || stored.tokenHash !== tokenHash || this.revokedSessions.has(sessionId)) return false;
    this.revokedSessions.add(sessionId);
    return true;
  }

  async issueActionToken(accountId: string, purpose: "verification" | "password_reset", tokenHash: string, expiresAt: string): Promise<boolean> {
    const account = this.accounts.get(accountId);
    if (!account || account.deletionState !== "active") return false;
    for (const token of this.actionTokens.values()) {
      if (token.accountId === accountId && token.purpose === purpose && token.usedAt === null) token.usedAt = new Date(NOW).toISOString();
    }
    this.actionTokens.set(tokenHash, { accountId, purpose, expiresAt, usedAt: null });
    return true;
  }

  async hasValidActionToken(tokenHash: string, purpose: "verification" | "password_reset", now: string): Promise<boolean> {
    const token = this.actionTokens.get(tokenHash);
    const account = token ? this.accounts.get(token.accountId) : null;
    return Boolean(token && token.purpose === purpose && !token.usedAt && Date.parse(token.expiresAt) > Date.parse(now) && account?.deletionState === "active" && (purpose !== "password_reset" || account.passwordHash));
  }

  async consumeVerificationToken(tokenHash: string, now: string): Promise<boolean> {
    if (!await this.hasValidActionToken(tokenHash, "verification", now)) return false;
    const token = this.actionTokens.get(tokenHash)!;
    token.usedAt = now;
    const account = this.accounts.get(token.accountId)!;
    account.emailVerified = true;
    return true;
  }

  async consumePasswordResetToken(tokenHash: string, passwordHash: string, now: string): Promise<boolean> {
    if (!await this.hasValidActionToken(tokenHash, "password_reset", now)) return false;
    const token = this.actionTokens.get(tokenHash)!;
    token.usedAt = now;
    const account = this.accounts.get(token.accountId)!;
    account.passwordHash = passwordHash;
    for (const session of this.sessions.values()) if (session.id === account.id) this.revokedSessions.add(session.sessionId);
    return true;
  }

  async createGoogleChallenge(input: GoogleChallengeInput): Promise<void> {
    this.challenges.set(input.nonceHash, { input, consumedAt: null });
  }

  async consumeGoogleChallenge(nonceHash: string, now: string): Promise<GoogleChallengeRecord | null> {
    const challenge = this.challenges.get(nonceHash);
    if (!challenge || challenge.consumedAt || Date.parse(challenge.input.expiresAt) <= Date.parse(now)) return null;
    challenge.consumedAt = now;
    return {
      purpose: challenge.input.purpose,
      transport: challenge.input.transport,
      accountId: challenge.input.accountId,
      sessionId: challenge.input.sessionId,
    };
  }

  async completeGoogleSignIn(input: GoogleSignInInput): Promise<GoogleSignInResult> {
    let account: AccountCredentials | undefined;
    const linkedId = this.googleSubjects.get(input.subject);
    if (linkedId) account = this.accounts.get(linkedId);
    if (account && account.deletionState !== "active") return { status: "account_unavailable" };
    if (!account) {
      const emailOwner = await this.findAccountByEmail(input.email);
      if (emailOwner) return { status: "email_conflict" };
      account = {
        id: input.accountId,
        email: input.email,
        emailVerified: true,
        displayName: input.displayName,
        providers: ["google"],
        passwordHash: null,
        deletionState: "active",
      };
      this.accounts.set(account.id, account);
      this.googleSubjects.set(input.subject, account.id);
    }
    const stored = this.addSession(account, input.session);
    return {
      status: "ok",
      account: summary(account),
      sessionId: stored.sessionId,
      expiresAt: stored.expiresAt,
      absoluteExpiresAt: stored.absoluteExpiresAt,
    };
  }

  async completeGoogleReauthentication(input: { subject: string; accountId: string; sessionId: string; tokenHash: string; now: string }): Promise<boolean> {
    if (this.googleSubjects.get(input.subject) !== input.accountId) return false;
    const session = this.sessions.get(input.sessionId);
    if (!session || session.tokenHash !== input.tokenHash || session.id !== input.accountId || this.revokedSessions.has(input.sessionId)) return false;
    session.reauthenticatedAt = input.now;
    return true;
  }

  async completeGoogleLink(input: { subject: string; email: string; accountId: string; sessionId: string; tokenHash: string; now: string }): Promise<GoogleLinkResult> {
    const session = this.sessions.get(input.sessionId);
    const account = this.accounts.get(input.accountId);
    if (!session || !account || session.tokenHash !== input.tokenHash || session.id !== input.accountId || account.deletionState !== "active" || this.revokedSessions.has(input.sessionId) ||
        !session.reauthenticatedAt || Date.parse(session.reauthenticatedAt) < Date.parse(input.now) - 5 * 60 * 1000) return "retry";
    const subjectOwner = this.googleSubjects.get(input.subject);
    if (subjectOwner) return subjectOwner === input.accountId ? "ok" : "subject_conflict";
    const emailOwner = await this.findAccountByEmail(input.email);
    if (emailOwner && emailOwner.id !== input.accountId) return "email_conflict";
    this.googleSubjects.set(input.subject, input.accountId);
    account.providers = [...new Set([...account.providers, "google" as const])];
    return "ok";
  }

  async confirmPasswordReauthentication(accountId: string, sessionId: string, tokenHash: string, now: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.tokenHash !== tokenHash || session.id !== accountId || this.revokedSessions.has(sessionId)) return false;
    session.reauthenticatedAt = now;
    return true;
  }

  async beginDeletion(accountId: string, sessionId: string, tokenHash: string, receiptId: string, now: string): Promise<string | null> {
    const account = this.accounts.get(accountId);
    const current = this.sessions.get(sessionId);
    if (!account || !current || account.deletionState !== "active" || current.tokenHash !== tokenHash || !current.reauthenticatedAt ||
        Date.parse(current.reauthenticatedAt) < Date.parse(now) - 5 * 60 * 1000) return null;
    account.deletionState = "deleting";
    for (const session of this.sessions.values()) if (session.id === accountId) this.revokedSessions.add(session.sessionId);
    this.receipts.set(receiptId, { receiptId, accountId, status: "pending" });
    return receiptId;
  }

  async findDeletionReceipt(receiptId: string): Promise<DeletionReceipt | null> {
    return this.receipts.get(receiptId) ?? null;
  }

  async completeDeletion(receiptId: string): Promise<boolean> {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) return false;
    for (const session of [...this.sessions.values()]) if (session.id === receipt.accountId) this.sessions.delete(session.sessionId);
    for (const [subject, accountId] of this.googleSubjects) if (accountId === receipt.accountId) this.googleSubjects.delete(subject);
    for (const [tokenHash, token] of this.actionTokens) if (token.accountId === receipt.accountId) this.actionTokens.delete(tokenHash);
    this.accounts.delete(receipt.accountId);
    this.receipts.set(receiptId, { ...receipt, status: "complete" });
    return true;
  }

  async purgeRetention(): Promise<{ deleted: number; remainingExpired: number }> {
    return { deleted: 0, remainingExpired: 0 };
  }

  private addSession(account: AccountCredentials, session: SessionInsert): StoredSession {
    const stored: StoredSession = {
      ...summary(account),
      sessionId: session.id,
      tokenHash: session.tokenHash,
      csrfHash: session.csrfHash,
      transport: session.transport,
      expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      reauthenticatedAt: null,
    };
    this.sessions.set(stored.sessionId, stored);
    return stored;
  }
}

interface TestRig {
  store: MemoryAuthStore;
  env: AuthEnvironment;
  dependencies: AuthDependencies;
  emails: Array<{ to: string; subject: string; html: string; text: string }>;
  googleTokens: Map<string, GoogleIdentityClaims>;
}

function rig(overrides: Partial<AuthEnvironment> = {}): TestRig {
  const store = new MemoryAuthStore();
  const emails: TestRig["emails"] = [];
  const googleTokens = new Map<string, GoogleIdentityClaims>();
  const env: AuthEnvironment = {
    DATABASE_URL: "memory://auth-test",
    AUTH_SESSION_SECRET: AUTH_SECRET,
    PUBLIC_APP_URL: API_ORIGIN,
    RESEND_API_KEY: "resend-test-key",
    AUTH_EMAIL_FROM: "Parkdex <accounts@parkdex.example>",
    GOOGLE_WEB_CLIENT_ID: GOOGLE_CLIENT_ID,
    ...overrides,
  };
  const dependencies: AuthDependencies = {
    createStore: () => store,
    now: () => NOW,
    hashPassword: async (password) => `test-hash:${password}`,
    verifyPassword: async (hash, password) => hash === `test-hash:${password}`,
    verifyGoogleIdToken: async (token, audience) => {
      if (audience !== GOOGLE_CLIENT_ID) throw new Error("unexpected audience");
      const claims = googleTokens.get(token);
      if (!claims) throw new Error("unknown test token");
      return claims;
    },
    sendEmail: async (message) => { emails.push(message); },
    waitUntil: (promise) => { void promise; },
  };
  return { store, env, dependencies, emails, googleTokens };
}

function request(path: string, body?: unknown, options: {
  method?: string;
  origin?: string | null;
  cookie?: string;
  csrf?: string;
  authorization?: string;
  accountId?: string;
  ip?: string;
  native?: boolean;
} = {}): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (options.origin !== null) headers.set("origin", options.origin ?? API_ORIGIN);
  if (options.ip) headers.set("cf-connecting-ip", options.ip);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  if (options.authorization) headers.set("authorization", options.authorization);
  if (options.accountId) headers.set("x-kip-account-id", options.accountId);
  if (options.native) headers.set("x-kip-auth-transport", "native");
  return new Request(`${API_ORIGIN}${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(r: TestRig, path: string, body?: unknown, options: Parameters<typeof request>[2] = {}): Promise<Response> {
  const response = await handleAuthRequest(request(path, body, options), r.env, r.dependencies);
  assert.ok(response, `expected auth route for ${path}`);
  return response;
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function seedPasswordAccount(r: TestRig, email = "person@example.test", password = "correct horse battery") {
  const bearer = opaqueToken();
  const session: SessionInsert = {
    id: randomUUID(),
    tokenHash: sha256(bearer),
    csrfHash: null,
    transport: "native",
    expiresAt: new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
    absoluteExpiresAt: new Date(NOW + 90 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const created = await r.store.createAccount({
    accountId: randomUUID(),
    email,
    passwordHash: `test-hash:${password}`,
    displayName: "Test User",
    session,
    verificationTokenHash: null,
    verificationExpiresAt: null,
  });
  assert.ok(created);
  return { account: await r.store.findAccountById(created.account.id), bearer, sessionId: created.sessionId };
}

function bearerOptions(token: string, accountId?: string) {
  return { authorization: `Bearer ${token}`, accountId, native: true, origin: null };
}

function cookieValues(response: Response): { session: string; csrf: string } {
  const cookies = response.headers.get("set-cookie") ?? "";
  const session = /kip_account_session=([^;,]+)/u.exec(cookies)?.[1];
  const csrf = /kip_account_csrf=([^;,]+)/u.exec(cookies)?.[1];
  assert.ok(session);
  assert.ok(csrf);
  return { session, csrf };
}

async function googleSignIn(r: TestRig, claims: Partial<GoogleIdentityClaims> & Pick<GoogleIdentityClaims, "sub" | "email">): Promise<Response> {
  const challengeResponse = await call(r, "/api/auth/google/challenge", { purpose: "sign_in" });
  const { nonce } = await responseJson(challengeResponse);
  const token = `google-test-${randomUUID()}`;
  r.googleTokens.set(token, {
    sub: claims.sub,
    email: claims.email,
    email_verified: claims.email_verified ?? true,
    iss: claims.iss ?? "https://accounts.google.com",
    aud: claims.aud ?? GOOGLE_CLIENT_ID,
    exp: claims.exp ?? Math.floor(NOW / 1000) + 3_000,
    iat: claims.iat ?? Math.floor(NOW / 1000),
    nonce,
    name: claims.name ?? "Google Person",
  });
  return call(r, "/api/auth/google", { idToken: token, nonce });
}

test("registration uses Argon2id with the required work factor and web CSRF cookies", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  r.dependencies.hashPassword = undefined;
  r.dependencies.verifyPassword = undefined;
  const response = await call(r, "/api/auth/register", {
    email: " Person@Example.Test ", password: "a long enough password", displayName: "  Kip User  ",
  });
  assert.equal(response.status, 201);
  const data = await responseJson(response);
  assert.equal(data.account.email, "person@example.test");
  assert.equal(data.account.displayName, "Kip User");
  assert.equal("sessionToken" in data, false);
  const cookies = response.headers.get("set-cookie") ?? "";
  assert.match(cookies, /kip_account_session=[A-Za-z0-9_-]{43}; Path=\/api;[^,]*HttpOnly; Secure; SameSite=Lax/u);
  assert.match(cookies, /kip_account_csrf=[A-Za-z0-9_-]{43}; Path=\/;[^,]*Secure; SameSite=Strict/u);
  const account = [...r.store.accounts.values()][0];
  const encodedHash = account.passwordHash ?? "";
  assert.match(encodedHash, /^\$argon2id\$v=19\$/u);
  const params = Object.fromEntries(encodedHash.split("$")[3].split(",").map((part) => part.split("=")));
  assert.deepEqual(params, { m: "19456", p: "1", t: "2" });
  const login = await call(r, "/api/auth/login", { email: "person@example.test", password: "a long enough password" });
  assert.equal(login.status, 200);
});

test("login failures do not disclose whether an email exists and are rate limited", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  await seedPasswordAccount(r);
  const known = await call(r, "/api/auth/login", { email: "person@example.test", password: "wrong password here" });
  const unknown = await call(r, "/api/auth/login", { email: "missing@example.test", password: "wrong password here" });
  assert.equal(known.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await responseJson(known), await responseJson(unknown));
  const limitedRig = rig({ EMAIL_MODE: "disabled" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await call(limitedRig, "/api/auth/login", { email: "guess@example.test", password: "wrong password here" });
    assert.equal(response.status, 401);
  }
  const limited = await call(limitedRig, "/api/auth/login", { email: "guess@example.test", password: "wrong password here" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");

  const sprayRig = rig({ EMAIL_MODE: "disabled" });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await call(sprayRig, "/api/auth/login", { email: `spray${attempt}@example.test`, password: "wrong password here" }, { ip: "203.0.113.50" });
    assert.equal(response.status, 401);
  }
  const sprayed = await call(sprayRig, "/api/auth/login", { email: "spray-final@example.test", password: "wrong password here" }, { ip: "203.0.113.50" });
  assert.equal(sprayed.status, 429);
});

test("web writes require matching CSRF token and trusted origin, and logout revokes the cookie session", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const registered = await call(r, "/api/auth/register", { email: "web@example.test", password: "a long enough password" });
  const { session, csrf } = cookieValues(registered);
  const accountId = (await responseJson(registered)).account.id as string;
  const noCsrf = await call(r, "/api/auth/logout", undefined, { method: "POST", cookie: `kip_account_session=${session}`, accountId });
  assert.equal(noCsrf.status, 403);
  const badOrigin = await call(r, "/api/auth/logout", undefined, {
    method: "POST", origin: "https://evil.example", cookie: `kip_account_session=${session}; kip_account_csrf=${csrf}`, csrf, accountId,
  });
  assert.equal(badOrigin.status, 403);
  const changedAccount = await call(r, "/api/auth/logout", undefined, {
    method: "POST", cookie: `kip_account_session=${session}; kip_account_csrf=${csrf}`, csrf,
  });
  assert.equal(changedAccount.status, 409);
  const mismatchedAccount = await call(r, "/api/auth/logout", undefined, {
    method: "POST", cookie: `kip_account_session=${session}; kip_account_csrf=${csrf}`, csrf, accountId: randomUUID(),
  });
  assert.equal(mismatchedAccount.status, 409);
  assert.equal((await call(r, "/api/auth/me", undefined, { cookie: `kip_account_session=${session}` })).status, 200);
  const loggedOut = await call(r, "/api/auth/logout", undefined, {
    method: "POST", cookie: `kip_account_session=${session}; kip_account_csrf=${csrf}`, csrf, accountId,
  });
  assert.equal(loggedOut.status, 204);
  const me = await call(r, "/api/auth/me", undefined, { cookie: `kip_account_session=${session}` });
  assert.equal(me.status, 401);
});

test("reset responses do not enumerate accounts, reset tokens are single use, and reset revokes sessions", async () => {
  const r = rig();
  const seeded = await seedPasswordAccount(r, "reset@example.test");
  const known = await call(r, "/api/auth/password-reset/request", { email: "RESET@example.test" });
  const unknown = await call(r, "/api/auth/password-reset/request", { email: "absent@example.test" });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(await responseJson(known), await responseJson(unknown));
  assert.equal(r.emails.length, 1);
  const resetToken = /#resetToken=([A-Za-z0-9_-]{43})/u.exec(r.emails[0].text)?.[1];
  assert.ok(resetToken);
  const changed = await call(r, "/api/auth/password-reset/confirm", { token: resetToken, newPassword: "a replacement password" });
  assert.equal(changed.status, 204);
  const replay = await call(r, "/api/auth/password-reset/confirm", { token: resetToken, newPassword: "another replacement password" });
  assert.equal(replay.status, 400);
  const revoked = await call(r, "/api/auth/me", undefined, bearerOptions(seeded.bearer));
  assert.equal(revoked.status, 401);
  assert.equal((await r.store.findAccountById(seeded.account!.id))?.passwordHash, "test-hash:a replacement password");
});

test("email verification token is one use and marks the account verified", async () => {
  const r = rig();
  const registered = await call(r, "/api/auth/register", { email: "verify@example.test", password: "a long enough password" });
  assert.equal(registered.status, 201);
  assert.equal(r.emails.length, 1);
  const verificationToken = /#verificationToken=([A-Za-z0-9_-]{43})/u.exec(r.emails[0].text)?.[1];
  assert.ok(verificationToken);
  const confirmed = await call(r, "/api/auth/verification/confirm", { token: verificationToken });
  assert.equal(confirmed.status, 204);
  const replay = await call(r, "/api/auth/verification/confirm", { token: verificationToken });
  assert.equal(replay.status, 400);
  assert.equal((await r.store.findAccountByEmail("verify@example.test"))?.emailVerified, true);
});

test("Google-only accounts cannot acquire password access through password reset", async () => {
  const r = rig();
  r.store.addGoogleOnlyAccount("google-only@example.test", "stable-google-subject");
  const response = await call(r, "/api/auth/password-reset/request", { email: "google-only@example.test" });
  assert.equal(response.status, 202);
  assert.deepEqual(await responseJson(response), { accepted: true });
  assert.equal(r.emails.length, 0);
  assert.equal([...r.store.actionTokens.values()].filter((token) => token.purpose === "password_reset").length, 0);
});

test("Google nonce is single use and changed Google email does not change the Kip account email", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const invalidAudience = await googleSignIn(r, { sub: "subject-1", email: "google@example.test", aud: "wrong-audience" });
  assert.equal(invalidAudience.status, 401);

  const challengeResponse = await call(r, "/api/auth/google/challenge", { purpose: "sign_in" });
  const { nonce } = await responseJson(challengeResponse);
  const token = "valid-google-token";
  r.googleTokens.set(token, {
    sub: "subject-1", email: "google@example.test", email_verified: true, iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT_ID, exp: Math.floor(NOW / 1000) + 3_000, iat: Math.floor(NOW / 1000), nonce,
  });
  const first = await call(r, "/api/auth/google", { idToken: token, nonce });
  assert.equal(first.status, 200);
  const firstAccount = (await responseJson(first)).account as AccountSummary;
  const replay = await call(r, "/api/auth/google", { idToken: token, nonce });
  assert.equal(replay.status, 401);

  const changedEmail = await googleSignIn(r, { sub: "subject-1", email: "new-google-email@example.test" });
  assert.equal(changedEmail.status, 200);
  const changedAccount = (await responseJson(changedEmail)).account as AccountSummary;
  assert.equal(changedAccount.id, firstAccount.id);
  assert.equal(changedAccount.email, "google@example.test");
  assert.equal(r.store.accounts.size, 1);
});

test("Google sign-in does not auto-link by email, and a linked subject cannot move between accounts", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const owner = await seedPasswordAccount(r, "owned@example.test");
  const collision = await googleSignIn(r, { sub: "new-google-subject", email: "owned@example.test" });
  assert.equal(collision.status, 409);
  assert.equal(r.store.googleSubjects.has("new-google-subject"), false);

  const googleLogin = await googleSignIn(r, { sub: "already-linked", email: "google-owner@example.test" });
  assert.equal(googleLogin.status, 200);
  const target = await seedPasswordAccount(r, "target@example.test");
  const reauth = await call(r, "/api/auth/reauth/password", { password: "correct horse battery" }, bearerOptions(target.bearer, target.account!.id));
  assert.equal(reauth.status, 200);
  const challengeResponse = await call(r, "/api/auth/google/challenge", { purpose: "link" }, bearerOptions(target.bearer, target.account!.id));
  assert.equal(challengeResponse.status, 200);
  const { nonce } = await responseJson(challengeResponse);
  const token = "already-linked-token";
  r.googleTokens.set(token, {
    sub: "already-linked", email: "google-owner@example.test", email_verified: true,
    iss: "https://accounts.google.com", aud: GOOGLE_CLIENT_ID, exp: Math.floor(NOW / 1000) + 3_000,
    iat: Math.floor(NOW / 1000), nonce,
  });
  const link = await call(r, "/api/auth/google/native", { idToken: token, nonce }, bearerOptions(target.bearer, target.account!.id));
  assert.equal(link.status, 409);
  const targetAccount = await r.store.findAccountById(target.account!.id);
  assert.deepEqual(targetAccount?.providers, ["email"]);
  assert.equal(r.store.googleSubjects.get("already-linked"), (await r.store.findAccountByEmail("google-owner@example.test"))?.id);
  assert.ok(owner.account);
});

test("concurrent renewal rotates a native bearer once and logout revokes the replacement", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const registered = await call(r, "/api/auth/register", { email: "native@example.test", password: "a long enough password" }, { native: true, origin: null });
  const data = await responseJson(registered);
  const oldToken = data.sessionToken as string;
  const oldHash = sha256(oldToken);
  const session = [...r.store.sessions.values()].find((candidate) => candidate.tokenHash === oldHash);
  assert.ok(session);
  session.expiresAt = new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString();
  const renew = () => call(r, "/api/auth/sessions/renew", {}, bearerOptions(oldToken, data.account.id));
  const [first, second] = await Promise.all([renew(), renew()]);
  const successes = [first, second].filter((response) => response.status === 200);
  const failures = [first, second].filter((response) => response.status === 401);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  const replacement = (await responseJson(successes[0])).sessionToken as string;
  assert.notEqual(replacement, oldToken);
  assert.equal((await call(r, "/api/auth/me", undefined, bearerOptions(oldToken, data.account.id))).status, 401);
  assert.equal((await call(r, "/api/auth/me", undefined, bearerOptions(replacement, data.account.id))).status, 200);
  assert.equal((await call(r, "/api/auth/logout", undefined, { method: "POST", ...bearerOptions(replacement, data.account.id) })).status, 204);
  assert.equal((await call(r, "/api/auth/me", undefined, bearerOptions(replacement, data.account.id))).status, 401);
});

test("invalid email-link configuration fails registration before account creation", async () => {
  const r = rig({ PUBLIC_APP_URL: "https://user:password@bad host" });
  const response = await call(r, "/api/auth/register", { email: "misconfigured@example.test", password: "a long enough password" });
  assert.equal(response.status, 503);
  assert.equal(r.store.accounts.size, 0);
});

test("account deletion marks the account unavailable and resumes from a durable receipt", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const seeded = await seedPasswordAccount(r, "delete@example.test");
  const reauth = await call(r, "/api/auth/reauth/password", { password: "correct horse battery" }, bearerOptions(seeded.bearer, seeded.account!.id));
  assert.equal(reauth.status, 200);
  r.dependencies.deleteAccountData = async () => ({ complete: false });
  const pending = await call(r, "/api/account", undefined, { method: "DELETE", ...bearerOptions(seeded.bearer, seeded.account!.id) });
  assert.equal(pending.status, 202);
  const receiptId = (await responseJson(pending)).receiptId as string;
  assert.equal((await r.store.findAccountById(seeded.account!.id))?.deletionState, "deleting");
  assert.equal((await call(r, "/api/auth/me", undefined, bearerOptions(seeded.bearer, seeded.account!.id))).status, 401);
  r.dependencies.deleteAccountData = async () => ({ complete: true });
  const resumed = await resumeAccountDeletion(receiptId, r.env, r.dependencies);
  assert.equal(resumed.status, "complete");
  assert.equal(await r.store.findAccountById(seeded.account!.id), null);
  assert.equal((await r.store.findDeletionReceipt(receiptId))?.status, "complete");
});
