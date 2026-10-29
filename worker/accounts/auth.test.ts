import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { test } from "node:test";
import {
  handleAuthRequest,
  purgeAbandonedGuests,
  resumeAccountDeletion,
  type AuthDependencies,
  type AuthEnvironment,
  type GoogleIdentityClaims,
} from "./auth.ts";
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
  IdentityLinkInput,
  IdentityProvider,
  IdentityReauthInput,
  SessionInsert,
  StoredSession,
} from "./auth-store.ts";
import { AppleTokenError, decryptAppleRefreshToken, type AppleIdentityClaims } from "./apple.ts";

const API_ORIGIN = "https://kip.example.test";
const GOOGLE_CLIENT_ID = "123456789-test.apps.googleusercontent.com";
const GOOGLE_NATIVE_CLIENT_ID = "987654321-native.apps.googleusercontent.com";
const GOOGLE_IOS_CLIENT_ID = "555555555-ios.apps.googleusercontent.com";
const NATIVE_APP_ORIGIN = "https://localhost";
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
    guest: account.email === "",
  };
}

class MemoryAuthStore implements AccountAuthStore {
  readonly accounts = new Map<string, AccountCredentials>();
  readonly sessions = new Map<string, StoredSession>();
  readonly revokedSessions = new Set<string>();
  readonly actionTokens = new Map<string, { accountId: string; purpose: "verification" | "password_reset"; expiresAt: string; usedAt: string | null }>();
  readonly challenges = new Map<string, { input: GoogleChallengeInput; consumedAt: string | null }>();
  readonly googleSubjects = new Map<string, string>();
  readonly appleSubjects = new Map<string, string>();
  /** Encrypted Apple refresh tokens by subject. */
  readonly appleTokens = new Map<string, string>();
  readonly receipts = new Map<string, DeletionReceipt>();
  readonly events: Array<{ eventType: string; scopeHash: string | null; outcome: string }> = [];
  readonly rates = new Map<string, number>();
  readonly createdAt = new Map<string, string>();

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

  async createGuestAccount(accountId: string, session: SessionInsert) {
    const account: AccountCredentials = {
      id: accountId,
      email: "",
      emailVerified: false,
      displayName: null,
      providers: [],
      passwordHash: null,
      deletionState: "active",
    };
    this.accounts.set(account.id, account);
    const stored = this.addSession(account, session);
    return { account: summary(account), sessionId: stored.sessionId, expiresAt: stored.expiresAt, absoluteExpiresAt: stored.absoluteExpiresAt };
  }

  addGoogleOnlyAccount(email: string, subject: string): AccountCredentials {
    const account: AccountCredentials = {
      id: randomUUID(),
      email,
      emailVerified: true,
      displayName: null,
      providers: ["google"],
      passwordHash: null,
      deletionState: "active",
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
    return account ? { ...account, providers: [...account.providers], guest: account.email === "" } : null;
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

  async rotateSession(
    sessionId: string,
    previousTokenHash: string,
    session: SessionInsert,
    now: string,
    renewWindowMs = 7 * 24 * 60 * 60 * 1000,
  ): Promise<string | null> {
    const stored = this.sessions.get(sessionId);
    if (!stored || stored.tokenHash !== previousTokenHash || this.revokedSessions.has(sessionId)) return null;
    if (Date.parse(stored.expiresAt) <= Date.parse(now) || Date.parse(stored.expiresAt) > Date.parse(now) + renewWindowMs) return null;
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
    return Boolean(
      token &&
      token.purpose === purpose &&
      !token.usedAt &&
      Date.parse(token.expiresAt) > Date.parse(now) &&
      account?.deletionState === "active" &&
      (purpose !== "password_reset" || account.passwordHash),
    );
  }

  async consumeVerificationToken(tokenHash: string, now: string): Promise<boolean> {
    if (!(await this.hasValidActionToken(tokenHash, "verification", now))) return false;
    const token = this.actionTokens.get(tokenHash)!;
    token.usedAt = now;
    const account = this.accounts.get(token.accountId)!;
    account.emailVerified = true;
    return true;
  }

  async consumePasswordResetToken(tokenHash: string, passwordHash: string, now: string): Promise<boolean> {
    if (!(await this.hasValidActionToken(tokenHash, "password_reset", now))) return false;
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
      provider: challenge.input.provider ?? "google",
      purpose: challenge.input.purpose,
      transport: challenge.input.transport,
      accountId: challenge.input.accountId,
      sessionId: challenge.input.sessionId,
    };
  }

  subjects(provider: IdentityProvider): Map<string, string> {
    return provider === "apple" ? this.appleSubjects : this.googleSubjects;
  }

  completeGoogleSignIn(input: GoogleSignInInput): Promise<GoogleSignInResult> {
    return this.identitySignIn("google", input);
  }

  completeAppleSignIn(input: GoogleSignInInput): Promise<GoogleSignInResult> {
    return this.identitySignIn("apple", input);
  }

  completeGoogleReauthentication(input: IdentityReauthInput): Promise<boolean> {
    return this.identityReauthentication("google", input);
  }

  completeAppleReauthentication(input: IdentityReauthInput): Promise<boolean> {
    return this.identityReauthentication("apple", input);
  }

  completeGoogleLink(input: IdentityLinkInput): Promise<GoogleLinkResult> {
    return this.identityLink("google", input);
  }

  completeAppleLink(input: IdentityLinkInput): Promise<GoogleLinkResult> {
    return this.identityLink("apple", input);
  }

  async saveAppleRefreshToken(input: { subject: string; accountId: string; ciphertext: string }): Promise<boolean> {
    if (this.appleSubjects.get(input.subject) !== input.accountId) return false;
    this.appleTokens.set(input.subject, input.ciphertext);
    return true;
  }

  async appleRefreshTokens(accountId: string): Promise<string[]> {
    return [...this.appleSubjects].filter(([, owner]) => owner === accountId).flatMap(([subject]) => this.appleTokens.get(subject) ?? []);
  }

  private async identitySignIn(provider: IdentityProvider, input: GoogleSignInInput): Promise<GoogleSignInResult> {
    let account: AccountCredentials | undefined;
    const linkedId = this.subjects(provider).get(input.subject);
    if (linkedId) account = this.accounts.get(linkedId);
    if (account && account.deletionState !== "active") return { status: "account_unavailable" };
    if (!account) {
      const emailOwner = input.email ? await this.findAccountByEmail(input.email) : null;
      if (emailOwner) return { status: "email_conflict" };
      if (!input.email) return { status: "email_required" };
      account = {
        id: input.accountId,
        email: input.email,
        emailVerified: true,
        displayName: input.displayName,
        providers: [provider],
        passwordHash: null,
        deletionState: "active",
      };
      this.accounts.set(account.id, account);
      this.subjects(provider).set(input.subject, account.id);
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

  private async identityReauthentication(provider: IdentityProvider, input: IdentityReauthInput): Promise<boolean> {
    if (this.subjects(provider).get(input.subject) !== input.accountId) return false;
    const session = this.sessions.get(input.sessionId);
    if (!session || session.tokenHash !== input.tokenHash || session.id !== input.accountId || this.revokedSessions.has(input.sessionId)) return false;
    session.reauthenticatedAt = input.now;
    return true;
  }

  private async identityLink(provider: IdentityProvider, input: IdentityLinkInput): Promise<GoogleLinkResult> {
    const session = this.sessions.get(input.sessionId);
    const account = this.accounts.get(input.accountId);
    if (
      !session ||
      !account ||
      session.tokenHash !== input.tokenHash ||
      session.id !== input.accountId ||
      account.deletionState !== "active" ||
      this.revokedSessions.has(input.sessionId) ||
      (account.email !== "" && (!session.reauthenticatedAt || Date.parse(session.reauthenticatedAt) < Date.parse(input.now) - 5 * 60 * 1000))
    )
      return "retry";
    const subjectOwner = this.subjects(provider).get(input.subject);
    if (subjectOwner) return subjectOwner === input.accountId ? "ok" : "subject_conflict";
    const emailOwner = input.email ? await this.findAccountByEmail(input.email) : null;
    if (emailOwner && emailOwner.id !== input.accountId) return "email_conflict";
    if (account.email === "" && !input.email) return "email_required";
    this.subjects(provider).set(input.subject, input.accountId);
    account.providers = [...new Set([...account.providers, provider])];
    if (account.email === "" && input.email) {
      account.email = input.email;
      account.emailVerified = true;
      for (const stored of this.sessions.values()) {
        if (stored.id !== account.id) continue;
        stored.absoluteExpiresAt = new Date(Math.min(Date.parse(stored.absoluteExpiresAt), Date.parse(input.now) + 90 * 24 * 60 * 60 * 1000)).toISOString();
        stored.expiresAt = new Date(Math.min(Date.parse(stored.expiresAt), Date.parse(input.now) + 30 * 24 * 60 * 60 * 1000)).toISOString();
      }
    }
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
    if (
      !account ||
      !current ||
      account.deletionState !== "active" ||
      current.tokenHash !== tokenHash ||
      (account.email !== "" && (!current.reauthenticatedAt || Date.parse(current.reauthenticatedAt) < Date.parse(now) - 5 * 60 * 1000))
    )
      return null;
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
    for (const [subject, accountId] of this.appleSubjects) {
      if (accountId !== receipt.accountId) continue;
      this.appleSubjects.delete(subject);
      this.appleTokens.delete(subject);
    }
    for (const [tokenHash, token] of this.actionTokens) if (token.accountId === receipt.accountId) this.actionTokens.delete(tokenHash);
    this.accounts.delete(receipt.accountId);
    this.receipts.set(receiptId, { ...receipt, status: "complete" });
    return true;
  }

  async markAbandonedGuestsForDeletion(cutoff: string, now: string, limit: number): Promise<string[]> {
    const receipts: string[] = [];
    for (const account of this.accounts.values()) {
      if (receipts.length >= limit) break;
      if (account.email !== "" || account.deletionState !== "active") continue;
      if (Date.parse(this.createdAt.get(account.id) ?? new Date(NOW).toISOString()) >= Date.parse(cutoff)) continue;
      const sessions = [...this.sessions.values()].filter((session) => session.id === account.id);
      const live = sessions.some(
        (session) =>
          !this.revokedSessions.has(session.sessionId) &&
          Date.parse(session.expiresAt) > Date.parse(now) &&
          Date.parse(session.absoluteExpiresAt) > Date.parse(now),
      );
      const recent = sessions.some((session) => Math.min(Date.parse(session.expiresAt), Date.parse(session.absoluteExpiresAt)) >= Date.parse(cutoff));
      if (live || recent) continue;
      account.deletionState = "deleting";
      for (const session of sessions) this.revokedSessions.add(session.sessionId);
      const receiptId = randomUUID();
      this.receipts.set(receiptId, { receiptId, accountId: account.id, status: "pending" });
      receipts.push(receiptId);
    }
    return receipts;
  }

  async pendingGuestDeletionReceipts(limit: number): Promise<string[]> {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.status === "pending" && this.accounts.get(receipt.accountId)?.email === "")
      .slice(0, limit)
      .map((receipt) => receipt.receiptId);
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
  googleAudiences: Array<readonly string[]>;
  /** Identity tokens the fake Apple verifier accepts, with the claims it returns. */
  appleTokens: Map<string, AppleIdentityClaims>;
  appleAudiences: string[];
}

function rig(overrides: Partial<AuthEnvironment> = {}): TestRig {
  const store = new MemoryAuthStore();
  const emails: TestRig["emails"] = [];
  const googleTokens = new Map<string, GoogleIdentityClaims>();
  const googleAudiences: Array<readonly string[]> = [];
  const appleTokens = new Map<string, AppleIdentityClaims>();
  const appleAudiences: string[] = [];
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
    verifyGoogleIdToken: async (token, audiences) => {
      googleAudiences.push(audiences);
      if (!audiences.includes(GOOGLE_CLIENT_ID)) throw new Error("unexpected audience");
      const claims = googleTokens.get(token);
      if (!claims) throw new Error("unknown test token");
      return claims;
    },
    verifyAppleIdentityToken: async (token, options) => {
      appleAudiences.push(options.audience);
      const claims = appleTokens.get(token);
      if (!claims || claims.nonce !== options.nonce) throw new AppleTokenError();
      return claims;
    },
    sendEmail: async (message) => {
      emails.push(message);
    },
    waitUntil: (promise) => {
      void promise;
    },
  };
  return { store, env, dependencies, emails, googleTokens, googleAudiences, appleTokens, appleAudiences };
}

function request(
  path: string,
  body?: unknown,
  options: {
    method?: string;
    origin?: string | null;
    cookie?: string;
    csrf?: string;
    authorization?: string;
    accountId?: string;
    ip?: string;
    native?: boolean;
  } = {},
): Request {
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
  return (await response.json()) as Record<string, any>;
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
    email: " Person@Example.Test ",
    password: "a long enough password",
    displayName: "  Kip User  ",
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
  const params = Object.fromEntries(
    encodedHash
      .split("$")[3]
      .split(",")
      .map((part) => part.split("=")),
  );
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
    const response = await call(
      sprayRig,
      "/api/auth/login",
      { email: `spray${attempt}@example.test`, password: "wrong password here" },
      { ip: "203.0.113.50" },
    );
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
    method: "POST",
    origin: "https://evil.example",
    cookie: `kip_account_session=${session}; kip_account_csrf=${csrf}`,
    csrf,
    accountId,
  });
  assert.equal(badOrigin.status, 403);
  const changedAccount = await call(r, "/api/auth/logout", undefined, {
    method: "POST",
    cookie: `kip_account_session=${session}; kip_account_csrf=${csrf}`,
    csrf,
  });
  assert.equal(changedAccount.status, 409);
  const mismatchedAccount = await call(r, "/api/auth/logout", undefined, {
    method: "POST",
    cookie: `kip_account_session=${session}; kip_account_csrf=${csrf}`,
    csrf,
    accountId: randomUUID(),
  });
  assert.equal(mismatchedAccount.status, 409);
  assert.equal((await call(r, "/api/auth/me", undefined, { cookie: `kip_account_session=${session}` })).status, 200);
  const loggedOut = await call(r, "/api/auth/logout", undefined, {
    method: "POST",
    cookie: `kip_account_session=${session}; kip_account_csrf=${csrf}`,
    csrf,
    accountId,
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

test("verification and reset Resend requests configure redirect rejection", async () => {
  const r = rig();
  const requests: Array<{ url: string; redirect: string | undefined; payload: Record<string, any> }> = [];
  const deliveries: Promise<unknown>[] = [];
  r.dependencies.sendEmail = undefined;
  r.dependencies.waitUntil = (promise) => {
    deliveries.push(promise);
  };
  r.dependencies.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      redirect: init?.redirect,
      payload: JSON.parse(String(init?.body)),
    });
    return new Response(null, { status: 200 });
  };

  const registered = await call(r, "/api/auth/register", { email: "redirect@example.test", password: "a long enough password" });
  assert.equal(registered.status, 201);
  const resetRequested = await call(r, "/api/auth/password-reset/request", { email: "redirect@example.test" });
  assert.equal(resetRequested.status, 202);
  await Promise.all(deliveries);

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "https://api.resend.com/emails");
    assert.equal(request.redirect, "error");
  }
  assert.match(requests.find((request) => request.payload.subject.includes("Verify"))?.payload.text ?? "", /#verificationToken=[A-Za-z0-9_-]{43}/u);
  assert.match(requests.find((request) => request.payload.subject.includes("password"))?.payload.text ?? "", /#resetToken=[A-Za-z0-9_-]{43}/u);
});

test("Google-only accounts get sign-in directions from password reset, never a reset token", async () => {
  const r = rig();
  r.store.addGoogleOnlyAccount("google-only@example.test", "stable-google-subject");
  const response = await call(r, "/api/auth/password-reset/request", { email: "Google-Only@example.test" });
  assert.equal(response.status, 202);
  assert.deepEqual(await responseJson(response), { accepted: true });
  assert.equal([...r.store.actionTokens.values()].filter((token) => token.purpose === "password_reset").length, 0);
  assert.equal(r.emails.length, 1);
  const [message] = r.emails;
  assert.equal(message.to, "google-only@example.test");
  assert.equal(message.subject, "How to sign in to Parkdex");
  for (const body of [message.text, message.html]) {
    assert.match(body, /Continue with Google/u);
    assert.match(body, /google-only@example\.test/u);
    assert.match(body, /No password is needed/u);
    assert.ok(body.includes(`${API_ORIGIN}/account`));
    assert.doesNotMatch(body, /resetToken|verificationToken/u);
  }
  assert.match(message.html, /PARKDEX/u);
});

test("password reset responses are identical for password, Google-only and unknown emails", async () => {
  const r = rig();
  const seeded = await seedPasswordAccount(r, "password@example.test");
  r.store.addGoogleOnlyAccount("google@example.test", "google-subject");
  const responses = [
    await call(r, "/api/auth/password-reset/request", { email: "password@example.test" }),
    await call(r, "/api/auth/password-reset/request", { email: "google@example.test" }),
    await call(r, "/api/auth/password-reset/request", { email: "nobody@example.test" }),
  ];
  const shapes = await Promise.all(
    responses.map(async (response) => {
      const headers: string[][] = [];
      response.headers.forEach((value, name) => {
        headers.push([name, value]);
      });
      return { status: response.status, headers, body: await response.text() };
    }),
  );
  assert.equal(shapes[0].status, 202);
  assert.equal(shapes[0].body, JSON.stringify({ accepted: true }));
  assert.deepEqual(shapes[1], shapes[0]);
  assert.deepEqual(shapes[2], shapes[0]);

  assert.deepEqual(
    r.emails.map((message) => [message.to, message.subject]),
    [
      ["password@example.test", "Reset your Parkdex password"],
      ["google@example.test", "How to sign in to Parkdex"],
    ],
  );
  assert.match(r.emails[0].text, /#resetToken=[A-Za-z0-9_-]{43}/u);
  const resetTokens = [...r.store.actionTokens.values()].filter((token) => token.purpose === "password_reset");
  assert.deepEqual(
    resetTokens.map((token) => token.accountId),
    [seeded.account!.id],
  );
});

test("password reset sends nothing to a deleting Google-only account", async () => {
  const r = rig();
  const account = r.store.addGoogleOnlyAccount("leaving@example.test", "leaving-subject");
  account.deletionState = "deleting";
  const response = await call(r, "/api/auth/password-reset/request", { email: "leaving@example.test" });
  assert.equal(response.status, 202);
  assert.deepEqual(await responseJson(response), { accepted: true });
  assert.equal(r.emails.length, 0);
});

test("a failed Google sign-in directions email records its own delivery failure", async () => {
  const r = rig();
  const deliveries: Promise<unknown>[] = [];
  r.dependencies.sendEmail = async () => {
    throw new Error("provider down");
  };
  r.dependencies.waitUntil = (promise) => {
    deliveries.push(promise);
  };
  r.store.addGoogleOnlyAccount("google-fail@example.test", "google-fail-subject");
  const response = await call(r, "/api/auth/password-reset/request", { email: "google-fail@example.test" });
  assert.equal(response.status, 202);
  await Promise.all(deliveries);
  assert.deepEqual(
    r.store.events.filter((event) => event.outcome === "delivery_failed").map((event) => event.eventType),
    ["password_reset_google_email"],
  );
});

test("Google nonce is single use and changed Google email does not change the Kip account email", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const invalidAudience = await googleSignIn(r, { sub: "subject-1", email: "google@example.test", aud: "wrong-audience" });
  assert.equal(invalidAudience.status, 401);

  const challengeResponse = await call(r, "/api/auth/google/challenge", { purpose: "sign_in" });
  const { nonce } = await responseJson(challengeResponse);
  const token = "valid-google-token";
  r.googleTokens.set(token, {
    sub: "subject-1",
    email: "google@example.test",
    email_verified: true,
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 3_000,
    iat: Math.floor(NOW / 1000),
    nonce,
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
    sub: "already-linked",
    email: "google-owner@example.test",
    email_verified: true,
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 3_000,
    iat: Math.floor(NOW / 1000),
    nonce,
  });
  const link = await call(r, "/api/auth/google/native", { idToken: token, nonce }, bearerOptions(target.bearer, target.account!.id));
  assert.equal(link.status, 409);
  const targetAccount = await r.store.findAccountById(target.account!.id);
  assert.deepEqual(targetAccount?.providers, ["email"]);
  assert.equal(r.store.googleSubjects.get("already-linked"), (await r.store.findAccountByEmail("google-owner@example.test"))?.id);
  assert.ok(owner.account);
});

async function configFor(r: TestRig, options: Parameters<typeof request>[2]): Promise<Record<string, any>> {
  const response = await call(r, "/api/auth/config", undefined, options);
  assert.equal(response.status, 200);
  return responseJson(response);
}

const NATIVE_APP_REQUEST = { native: true, origin: NATIVE_APP_ORIGIN } as const;
const IOS_APP_REQUEST = { native: true, origin: "capacitor://localhost" } as const;

test("auth config hands installed apps the native Google client and web pages the web client", async () => {
  const withoutKey = rig();
  for (const options of [{}, NATIVE_APP_REQUEST]) {
    const config = await configFor(withoutKey, options);
    assert.equal(config.googleWebClientId, GOOGLE_CLIENT_ID);
    assert.equal(config.googleNativeEnabled, true);
    assert.equal(config.googleWebEnabled, true);
  }

  const withKey = rig({ GOOGLE_NATIVE_CLIENT_ID });
  const web = await configFor(withKey, {});
  assert.equal(web.googleWebClientId, GOOGLE_CLIENT_ID);
  const native = await configFor(withKey, NATIVE_APP_REQUEST);
  assert.equal(native.googleWebClientId, GOOGLE_NATIVE_CLIENT_ID);
  assert.equal(native.googleNativeEnabled, true);
  assert.equal(native.googleEnabled, true);
  assert.equal(native.capabilities.native.google, true);
  // The iOS app signs in with the iOS client, never the Android one; without it iOS shows no Google button.
  const iosShell = await configFor(withKey, IOS_APP_REQUEST);
  assert.equal(iosShell.googleWebClientId, null);
  assert.equal(iosShell.googleNativeEnabled, false);
  assert.equal(iosShell.appleEnabled, true);
  assert.equal(iosShell.capabilities.native.apple, true);
  const withIos = await configFor(rig({ GOOGLE_NATIVE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID }), IOS_APP_REQUEST);
  assert.equal(withIos.googleWebClientId, GOOGLE_IOS_CLIENT_ID);
  assert.equal(withIos.googleNativeEnabled, true);
  // Android and web requests never see the iOS client or Sign in with Apple.
  assert.equal(native.appleEnabled, false);
  assert.equal(web.appleEnabled, false);
  assert.equal((await configFor(rig({ GOOGLE_IOS_CLIENT_ID }), NATIVE_APP_REQUEST)).googleWebClientId, GOOGLE_CLIENT_ID);

  // The transport header alone, or the WebView origin alone, is not a native app request.
  assert.equal((await configFor(withKey, { native: true })).googleWebClientId, GOOGLE_CLIENT_ID);
  assert.equal((await configFor(withKey, { native: true, origin: null })).googleWebClientId, GOOGLE_CLIENT_ID);
  assert.equal((await configFor(withKey, { origin: NATIVE_APP_ORIGIN })).googleWebClientId, GOOGLE_CLIENT_ID);

  const invalidKey = rig({ GOOGLE_NATIVE_CLIENT_ID: "not-a-client-id" });
  assert.equal((await configFor(invalidKey, NATIVE_APP_REQUEST)).googleWebClientId, GOOGLE_CLIENT_ID);

  // Without the web client, Google stays off for everyone, as before.
  const noWeb = rig({ GOOGLE_WEB_CLIENT_ID: undefined, GOOGLE_NATIVE_CLIENT_ID });
  const disabled = await configFor(noWeb, NATIVE_APP_REQUEST);
  assert.equal(disabled.googleWebClientId, null);
  assert.equal(disabled.googleNativeEnabled, false);
});

async function googleSignInVia(
  r: TestRig,
  route: "/api/auth/google" | "/api/auth/google/native",
  claims: Pick<GoogleIdentityClaims, "sub" | "email" | "aud">,
): Promise<Response> {
  const options = route === "/api/auth/google/native" ? NATIVE_APP_REQUEST : {};
  const challengeResponse = await call(r, "/api/auth/google/challenge", { purpose: "sign_in" }, options);
  assert.equal(challengeResponse.status, 200);
  const { nonce } = await responseJson(challengeResponse);
  const token = `google-test-${randomUUID()}`;
  r.googleTokens.set(token, {
    ...claims,
    email_verified: true,
    iss: "https://accounts.google.com",
    exp: Math.floor(NOW / 1000) + 3_000,
    iat: Math.floor(NOW / 1000),
    nonce,
  });
  return call(r, route, { idToken: token, nonce }, options);
}

test("Google tokens for either configured client sign in to the same account by subject", async () => {
  const r = rig({ EMAIL_MODE: "disabled", GOOGLE_NATIVE_CLIENT_ID });
  const web = await googleSignInVia(r, "/api/auth/google", { sub: "same-person", email: "same@example.test", aud: GOOGLE_CLIENT_ID });
  assert.equal(web.status, 200);
  assert.deepEqual(r.googleAudiences.at(-1), [GOOGLE_CLIENT_ID, GOOGLE_NATIVE_CLIENT_ID]);
  const webAccount = (await responseJson(web)).account as AccountSummary;

  const native = await googleSignInVia(r, "/api/auth/google/native", { sub: "same-person", email: "same@example.test", aud: GOOGLE_NATIVE_CLIENT_ID });
  assert.equal(native.status, 200);
  const nativeBody = await responseJson(native);
  assert.equal(nativeBody.account.id, webAccount.id);
  assert.equal(typeof nativeBody.sessionToken, "string");

  const nativeWithWebAudience = await googleSignInVia(r, "/api/auth/google/native", { sub: "same-person", email: "same@example.test", aud: GOOGLE_CLIENT_ID });
  assert.equal(nativeWithWebAudience.status, 200);
  const webWithNativeAudience = await googleSignInVia(r, "/api/auth/google", { sub: "same-person", email: "same@example.test", aud: GOOGLE_NATIVE_CLIENT_ID });
  assert.equal(webWithNativeAudience.status, 200);
  assert.equal(r.store.accounts.size, 1);
  assert.equal(r.store.googleSubjects.get("same-person"), webAccount.id);

  for (const route of ["/api/auth/google", "/api/auth/google/native"] as const) {
    const third = await googleSignInVia(r, route, { sub: "same-person", email: "same@example.test", aud: "555555-other.apps.googleusercontent.com" });
    assert.equal(third.status, 401);
    assert.equal((await responseJson(third)).code, "invalid_google_token");
  }
});

test("without the native client key only the web client audience is accepted", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const native = await googleSignInVia(r, "/api/auth/google/native", { sub: "native-only", email: "native-only@example.test", aud: GOOGLE_NATIVE_CLIENT_ID });
  assert.equal(native.status, 401);
  assert.deepEqual(r.googleAudiences.at(-1), [GOOGLE_CLIENT_ID]);
  const web = await googleSignInVia(r, "/api/auth/google/native", { sub: "native-only", email: "native-only@example.test", aud: GOOGLE_CLIENT_ID });
  assert.equal(web.status, 200);

  const invalidKey = rig({ EMAIL_MODE: "disabled", GOOGLE_NATIVE_CLIENT_ID: "not-a-client-id" });
  const rejected = await googleSignInVia(invalidKey, "/api/auth/google", { sub: "x", email: "x@example.test", aud: "not-a-client-id" });
  assert.equal(rejected.status, 401);
  assert.deepEqual(invalidKey.googleAudiences.at(-1), [GOOGLE_CLIENT_ID]);
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

async function startGuest(r: TestRig, ip = "203.0.113.7") {
  const response = await call(r, "/api/auth/guest", {}, { native: true, origin: null, ip });
  assert.equal(response.status, 201);
  const body = await responseJson(response);
  return { account: body.account as AccountSummary, bearer: body.sessionToken as string, expiresAt: body.expiresAt as string };
}

async function linkGoogle(r: TestRig, bearer: string, accountId: string, claims: Pick<GoogleIdentityClaims, "sub" | "email">): Promise<Response> {
  const challengeResponse = await call(r, "/api/auth/google/challenge", { purpose: "link" }, bearerOptions(bearer, accountId));
  if (challengeResponse.status !== 200) return challengeResponse;
  const { nonce } = await responseJson(challengeResponse);
  const token = `google-link-${randomUUID()}`;
  r.googleTokens.set(token, {
    ...claims,
    email_verified: true,
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 3_000,
    iat: Math.floor(NOW / 1000),
    nonce,
  });
  return call(r, "/api/auth/google/native", { idToken: token, nonce }, bearerOptions(bearer, accountId));
}

test("a guest account has no email, a year-long session, and is limited per address", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const guest = await startGuest(r);
  assert.equal(guest.account.guest, true);
  assert.equal(guest.account.email, "");
  assert.deepEqual(guest.account.providers, []);
  assert.equal(Date.parse(guest.expiresAt), NOW + 365 * 24 * 60 * 60 * 1000);
  const me = await responseJson(await call(r, "/api/auth/me", undefined, bearerOptions(guest.bearer, guest.account.id)));
  assert.equal(me.account.guest, true);

  const web = await call(r, "/api/auth/guest", {}, { ip: "203.0.113.8" });
  assert.equal(web.status, 201);
  assert.ok(cookieValues(web).session);
  assert.equal((await call(r, "/api/auth/guest", {}, { origin: "https://evil.example.test", ip: "203.0.113.8" })).status, 403);
  assert.equal((await call(r, "/api/auth/guest", { email: "x@example.test" }, { native: true, origin: null, ip: "203.0.113.9" })).status, 400);

  for (let index = 0; index < 20; index += 1) await startGuest(r, "198.51.100.1");
  const limited = await call(r, "/api/auth/guest", {}, { native: true, origin: null, ip: "198.51.100.1" });
  assert.equal(limited.status, 429);
});

test("a guest session renews once it is a month old instead of waiting for its last week", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const guest = await startGuest(r);
  const stored = [...r.store.sessions.values()].find((session) => session.tokenHash === sha256(guest.bearer));
  assert.ok(stored);
  const fresh = await responseJson(await call(r, "/api/auth/sessions/renew", {}, bearerOptions(guest.bearer, guest.account.id)));
  assert.equal(fresh.renewed, false);
  stored.expiresAt = new Date(NOW + 300 * 24 * 60 * 60 * 1000).toISOString();
  const renewed = await responseJson(await call(r, "/api/auth/sessions/renew", {}, bearerOptions(guest.bearer, guest.account.id)));
  assert.equal(renewed.renewed, true);
  assert.equal(Date.parse(renewed.expiresAt), NOW + 365 * 24 * 60 * 60 * 1000);
});

test("Google upgrades a guest in place without a password, and its sessions shorten to an account's", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const guest = await startGuest(r);
  const linked = await linkGoogle(r, guest.bearer, guest.account.id, { sub: "guest-google", email: "Guest.Person@example.test" });
  assert.equal(linked.status, 200);
  const account = (await responseJson(linked)).account as AccountSummary;
  assert.equal(account.id, guest.account.id);
  assert.equal(account.guest, false);
  assert.equal(account.email, "guest.person@example.test");
  assert.deepEqual(account.providers, ["google"]);
  const stored = [...r.store.sessions.values()].find((session) => session.tokenHash === sha256(guest.bearer));
  assert.equal(stored?.expiresAt, new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString());
  // Signing in with that Google account later reaches the same account.
  const again = await googleSignIn(r, { sub: "guest-google", email: "guest.person@example.test" });
  assert.equal((await responseJson(again)).account.id, guest.account.id);
  // Once upgraded, linking needs a fresh reauthentication like any account.
  const relink = await call(r, "/api/auth/google/challenge", { purpose: "link" }, bearerOptions(guest.bearer, guest.account.id));
  assert.equal(relink.status, 403);
});

test("a guest cannot take over a Google account or email that already has a Parkdex account", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const existing = await googleSignIn(r, { sub: "taken-subject", email: "taken@example.test" });
  assert.equal(existing.status, 200);
  await seedPasswordAccount(r, "password-owner@example.test");
  const guest = await startGuest(r);
  const subjectConflict = await linkGoogle(r, guest.bearer, guest.account.id, { sub: "taken-subject", email: "taken@example.test" });
  assert.equal(subjectConflict.status, 409);
  const emailConflict = await linkGoogle(r, guest.bearer, guest.account.id, { sub: "fresh-subject", email: "password-owner@example.test" });
  assert.equal(emailConflict.status, 409);
  const after = await r.store.findAccountById(guest.account.id);
  assert.equal(after?.email, "");
  assert.deepEqual(after?.providers, []);
});

test("a guest can delete its account without reauthenticating", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const guest = await startGuest(r);
  r.dependencies.deleteAccountData = async () => ({ complete: true });
  const deleted = await call(r, "/api/account", undefined, { method: "DELETE", ...bearerOptions(guest.bearer, guest.account.id) });
  assert.equal(deleted.status, 200);
  assert.equal((await call(r, "/api/auth/me", undefined, bearerOptions(guest.bearer, guest.account.id))).status, 401);
});

test("abandoned guests are deleted after 30 days through the ordinary deletion path; live, recent and real accounts stay", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const day = 24 * 60 * 60 * 1000;
  const old = new Date(NOW - 60 * day).toISOString();
  const abandoned = await startGuest(r, "203.0.113.20");
  const live = await startGuest(r, "203.0.113.21");
  const recent = await startGuest(r, "203.0.113.22");
  const realAccount = await seedPasswordAccount(r, "real@example.test");
  for (const id of [abandoned.account.id, live.account.id, recent.account.id, realAccount.account!.id]) r.store.createdAt.set(id, old);
  const sessionOf = (bearer: string) => [...r.store.sessions.values()].find((session) => session.tokenHash === sha256(bearer))!;
  sessionOf(abandoned.bearer).expiresAt = new Date(NOW - 40 * day).toISOString();
  sessionOf(recent.bearer).expiresAt = new Date(NOW - 10 * day).toISOString();
  sessionOf(realAccount.bearer).expiresAt = new Date(NOW - 40 * day).toISOString();

  const deletedData: string[] = [];
  r.dependencies.deleteAccountData = async ({ accountId }) => {
    deletedData.push(accountId);
    return { complete: true };
  };
  const result = await purgeAbandonedGuests(r.env, r.dependencies);
  assert.deepEqual(result, { deleted: 1, pending: 0 });
  assert.deepEqual(deletedData, [abandoned.account.id], "private data goes first, through deleteAccountData");
  assert.equal(await r.store.findAccountById(abandoned.account.id), null);
  for (const kept of [live.account.id, recent.account.id, realAccount.account!.id])
    assert.equal((await r.store.findAccountById(kept))?.deletionState, "active");
});

test("an abandoned guest whose private data couldn't be deleted is resumed on the next run", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const guest = await startGuest(r, "203.0.113.30");
  r.store.createdAt.set(guest.account.id, new Date(NOW - 60 * 24 * 60 * 60 * 1000).toISOString());
  [...r.store.sessions.values()].find((session) => session.tokenHash === sha256(guest.bearer))!.expiresAt = new Date(
    NOW - 40 * 24 * 60 * 60 * 1000,
  ).toISOString();
  r.dependencies.deleteAccountData = async () => ({ complete: false });
  assert.deepEqual(await purgeAbandonedGuests(r.env, r.dependencies), { deleted: 0, pending: 1 });
  assert.equal((await r.store.findAccountById(guest.account.id))?.deletionState, "deleting");
  r.dependencies.deleteAccountData = async () => ({ complete: true });
  assert.deepEqual(await purgeAbandonedGuests(r.env, r.dependencies), { deleted: 1, pending: 0 });
  assert.equal(await r.store.findAccountById(guest.account.id), null);
});

async function appleCall(
  r: TestRig,
  purpose: "sign_in" | "reauth" | "link",
  claims: { sub: string; email: string | null },
  options: { bearer?: string; accountId?: string; extra?: Record<string, string> } = {},
): Promise<Response> {
  const auth = options.bearer ? { authorization: `Bearer ${options.bearer}`, accountId: options.accountId } : {};
  const challengeResponse = await call(r, "/api/auth/apple/challenge", { purpose }, { ...IOS_APP_REQUEST, ...auth });
  if (challengeResponse.status !== 200) return challengeResponse;
  const { nonce } = await responseJson(challengeResponse);
  const token = `apple-test-${randomUUID()}`;
  r.appleTokens.set(token, { sub: claims.sub, email: claims.email, isPrivateEmail: claims.email?.endsWith("@privaterelay.appleid.com") ?? false, nonce });
  return call(r, "/api/auth/apple/native", { identityToken: token, nonce, ...options.extra }, { ...IOS_APP_REQUEST, ...auth });
}

const APPLE_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" });
const APPLE_KEY_ENV = {
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_SIGN_IN_KEY_ID: "KEYID12345",
  APPLE_SIGN_IN_PRIVATE_KEY: APPLE_KEY.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
} satisfies Partial<AuthEnvironment>;

/** Answers Apple's token and revoke endpoints and records what was sent to them. */
function fakeAppleEndpoints(r: TestRig) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  r.dependencies.fetch = async (input, init) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url, body });
    if (url === "https://appleid.apple.com/auth/token") {
      return Response.json({ access_token: "apple-access", refresh_token: `apple-refresh-for-${body.get("code")}`, id_token: "unused" });
    }
    if (url === "https://appleid.apple.com/auth/revoke") return new Response(null, { status: 200 });
    return new Response(null, { status: 404 });
  };
  return calls;
}

test("Sign in with Apple creates an account from a relay email and finds it again by subject without one", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const first = await appleCall(
    r,
    "sign_in",
    { sub: "apple-subject-1", email: "abc123@privaterelay.appleid.com" },
    { extra: { givenName: "Robin", familyName: "Park" } },
  );
  assert.equal(first.status, 200);
  const body = await responseJson(first);
  assert.equal(body.account.email, "abc123@privaterelay.appleid.com");
  assert.equal(body.account.displayName, "Robin Park");
  assert.deepEqual(body.account.providers, ["apple"]);
  assert.equal(body.account.guest, false);
  assert.equal(typeof body.sessionToken, "string");
  assert.deepEqual(r.appleAudiences, ["app.parkdex"]);

  // Apple sends the name only once and may omit the email later; the subject finds the account.
  const again = await appleCall(r, "sign_in", { sub: "apple-subject-1", email: null });
  assert.equal(again.status, 200);
  assert.equal((await responseJson(again)).account.id, body.account.id);
  assert.equal(r.store.accounts.size, 1);
});

test("a new Apple identity without an email is refused instead of becoming a guest", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const response = await appleCall(r, "sign_in", { sub: "apple-no-email", email: null });
  assert.equal(response.status, 400);
  assert.equal((await responseJson(response)).code, "apple_email_required");
  assert.equal(r.store.accounts.size, 0);
});

test("Sign in with Apple never auto-links by email and is offered only to the native app", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  await seedPasswordAccount(r, "shared@example.test");
  const conflict = await appleCall(r, "sign_in", { sub: "apple-shared", email: "shared@example.test" });
  assert.equal(conflict.status, 409);
  assert.match((await responseJson(conflict)).message, /link Apple/u);

  const web = await call(r, "/api/auth/apple/challenge", { purpose: "sign_in" });
  assert.equal(web.status, 400);
});

test("Apple and Google nonces cannot be spent on the other provider", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const apple = await responseJson(await call(r, "/api/auth/apple/challenge", { purpose: "sign_in" }, IOS_APP_REQUEST));
  const googleToken = `google-cross-${randomUUID()}`;
  r.googleTokens.set(googleToken, {
    sub: "cross",
    email: "cross@example.test",
    email_verified: true,
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 3_000,
    iat: Math.floor(NOW / 1000),
    nonce: apple.nonce,
  });
  assert.equal((await call(r, "/api/auth/google/native", { idToken: googleToken, nonce: apple.nonce }, IOS_APP_REQUEST)).status, 401);

  const google = await responseJson(await call(r, "/api/auth/google/challenge", { purpose: "sign_in" }, IOS_APP_REQUEST));
  const appleToken = `apple-cross-${randomUUID()}`;
  r.appleTokens.set(appleToken, { sub: "cross", email: "cross@example.test", isPrivateEmail: false, nonce: google.nonce });
  const crossed = await call(r, "/api/auth/apple/native", { identityToken: appleToken, nonce: google.nonce }, IOS_APP_REQUEST);
  assert.equal(crossed.status, 401);
  assert.equal(r.store.accounts.size, 0);
});

test("an invalid Apple identity token is rejected", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const { nonce } = await responseJson(await call(r, "/api/auth/apple/challenge", { purpose: "sign_in" }, IOS_APP_REQUEST));
  const response = await call(r, "/api/auth/apple/native", { identityToken: "not-a-token", nonce }, IOS_APP_REQUEST);
  assert.equal(response.status, 401);
  assert.equal((await responseJson(response)).code, "invalid_apple_token");
});

test("Apple upgrades a guest in place, and a password account links Apple after reauthenticating", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const guest = await startGuest(r);
  const upgraded = await appleCall(
    r,
    "link",
    { sub: "apple-guest", email: "guest@privaterelay.appleid.com" },
    { bearer: guest.bearer, accountId: guest.account.id },
  );
  assert.equal(upgraded.status, 200);
  const account = (await responseJson(upgraded)).account;
  assert.equal(account.id, guest.account.id);
  assert.equal(account.email, "guest@privaterelay.appleid.com");
  assert.equal(account.guest, false);
  assert.deepEqual(account.providers, ["apple"]);

  const seeded = await seedPasswordAccount(r, "linker@example.test");
  const options = { bearer: seeded.bearer, accountId: seeded.account!.id };
  assert.equal((await appleCall(r, "link", { sub: "apple-linker", email: "linker@privaterelay.appleid.com" }, options)).status, 403);
  const reauth = await call(r, "/api/auth/reauth/password", { password: "correct horse battery" }, bearerOptions(seeded.bearer, seeded.account!.id));
  assert.equal(reauth.status, 200);
  const linked = await appleCall(r, "link", { sub: "apple-linker", email: "linker@privaterelay.appleid.com" }, options);
  assert.equal(linked.status, 200);
  const after = (await responseJson(linked)).account;
  assert.equal(after.email, "linker@example.test");
  assert.deepEqual([...after.providers].sort(), ["apple", "email"]);
  // The linked Apple ID now signs in to the same account, and cannot move to another one.
  assert.equal((await responseJson(await appleCall(r, "sign_in", { sub: "apple-linker", email: null }))).account.id, seeded.account!.id);
  const guest2 = await startGuest(r, "203.0.113.99");
  const moved = await appleCall(r, "link", { sub: "apple-linker", email: null }, { bearer: guest2.bearer, accountId: guest2.account.id });
  assert.equal(moved.status, 409);
});

test("a guest cannot become an account through Apple without an email", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const guest = await startGuest(r);
  const response = await appleCall(r, "link", { sub: "apple-guest-no-email", email: null }, { bearer: guest.bearer, accountId: guest.account.id });
  assert.equal(response.status, 400);
  assert.equal((await r.store.findAccountById(guest.account.id))?.email, "");
});

test("deleting an Apple account without the Sign in with Apple key still deletes it and skips revocation", async () => {
  const r = rig({ EMAIL_MODE: "disabled" });
  const calls = fakeAppleEndpoints(r);
  const signedIn = await responseJson(
    await appleCall(r, "sign_in", { sub: "apple-nokey", email: "nokey@privaterelay.appleid.com" }, { extra: { authorizationCode: "code-1" } }),
  );
  assert.equal(calls.length, 0, "no key means no code exchange");
  assert.equal(r.store.appleTokens.size, 0);
  const options = { bearer: signedIn.sessionToken as string, accountId: signedIn.account.id as string };
  const reauth = await appleCall(r, "reauth", { sub: "apple-nokey", email: null }, options);
  assert.equal(reauth.status, 200);
  r.dependencies.deleteAccountData = async () => ({ complete: true });
  const deleted = await call(r, "/api/account", undefined, { method: "DELETE", ...bearerOptions(options.bearer, options.accountId) });
  assert.equal(deleted.status, 200);
  assert.equal(await r.store.findAccountById(options.accountId), null);
  assert.equal(calls.length, 0);
});

test("a token kept before the key was removed is not revoked, and deletion records why", async () => {
  const r = rig({ EMAIL_MODE: "disabled", ...APPLE_KEY_ENV });
  fakeAppleEndpoints(r);
  const signedIn = await responseJson(
    await appleCall(r, "sign_in", { sub: "apple-removed", email: "removed@privaterelay.appleid.com" }, { extra: { authorizationCode: "code-1" } }),
  );
  assert.equal(r.store.appleTokens.size, 1);
  const options = { bearer: signedIn.sessionToken as string, accountId: signedIn.account.id as string };
  assert.equal((await appleCall(r, "reauth", { sub: "apple-removed", email: null }, options)).status, 200);
  r.env.APPLE_SIGN_IN_PRIVATE_KEY = undefined;
  r.dependencies.deleteAccountData = async () => ({ complete: true });
  const deleted = await call(r, "/api/account", undefined, { method: "DELETE", ...bearerOptions(options.bearer, options.accountId) });
  assert.equal(deleted.status, 200);
  assert.ok(r.store.events.some((event) => event.eventType === "apple_revoke" && event.outcome === "not_configured"));
});

test("with the Sign in with Apple key, codes become encrypted refresh tokens that deletion revokes", async () => {
  const r = rig({ EMAIL_MODE: "disabled", ...APPLE_KEY_ENV });
  const calls = fakeAppleEndpoints(r);
  const signedIn = await responseJson(
    await appleCall(r, "sign_in", { sub: "apple-key", email: "key@privaterelay.appleid.com" }, { extra: { authorizationCode: "code-1" } }),
  );
  assert.equal(calls[0]?.url, "https://appleid.apple.com/auth/token");
  assert.equal(calls[0]?.body.get("client_id"), "app.parkdex");
  assert.equal(calls[0]?.body.get("grant_type"), "authorization_code");
  assert.equal(calls[0]?.body.get("code"), "code-1");
  const stored = r.store.appleTokens.get("apple-key");
  assert.ok(stored && !stored.includes("apple-refresh"), "the refresh token is stored encrypted");
  assert.equal(decryptAppleRefreshToken(stored, r.env), "apple-refresh-for-code-1");

  // Reauthenticating before deletion replaces it with a fresh token.
  const options = { bearer: signedIn.sessionToken as string, accountId: signedIn.account.id as string };
  assert.equal((await appleCall(r, "reauth", { sub: "apple-key", email: null }, { ...options, extra: { authorizationCode: "code-2" } })).status, 200);
  assert.equal(decryptAppleRefreshToken(r.store.appleTokens.get("apple-key")!, r.env), "apple-refresh-for-code-2");

  r.dependencies.deleteAccountData = async () => ({ complete: true });
  const deleted = await call(r, "/api/account", undefined, { method: "DELETE", ...bearerOptions(options.bearer, options.accountId) });
  assert.equal(deleted.status, 200);
  const revoke = calls.find((entry) => entry.url === "https://appleid.apple.com/auth/revoke");
  assert.equal(revoke?.body.get("token"), "apple-refresh-for-code-2");
  assert.equal(revoke?.body.get("token_type_hint"), "refresh_token");
  assert.equal(revoke?.body.get("client_id"), "app.parkdex");
  // The client secret is an ES256 JWT from the team, signed with the configured key.
  const [header, payload, signature] = (revoke?.body.get("client_secret") ?? "").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "KEYID12345" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, "TEAM123456");
  assert.equal(claims.sub, "app.parkdex");
  assert.equal(claims.aud, "https://appleid.apple.com");
  assert.ok(
    verify("sha256", Buffer.from(`${header}.${payload}`), { key: APPLE_KEY.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
  );
  assert.ok(r.store.events.some((event) => event.eventType === "apple_revoke" && event.outcome === "revoked"));
  assert.equal(await r.store.findAccountById(options.accountId), null);
});

test("Apple being unreachable never blocks sign-in", async () => {
  const r = rig({ EMAIL_MODE: "disabled", ...APPLE_KEY_ENV });
  r.dependencies.fetch = async () => {
    throw new Error("offline");
  };
  const signedIn = await appleCall(
    r,
    "sign_in",
    { sub: "apple-offline", email: "offline@privaterelay.appleid.com" },
    { extra: { authorizationCode: "code-1" } },
  );
  assert.equal(signedIn.status, 200);
  assert.ok(r.store.events.some((event) => event.eventType === "apple_token" && event.outcome === "exchange_failed"));
});
