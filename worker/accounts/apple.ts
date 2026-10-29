import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify, type JsonWebKey } from "node:crypto";

/**
 * Sign in with Apple for the iOS app.
 *
 * - Identity tokens are verified here against Apple's published keys: RS256 signature, issuer
 *   `https://appleid.apple.com`, audience the app's bundle ID, expiry, and the server-issued nonce.
 * - With a Sign in with Apple key (`APPLE_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID`, `APPLE_SIGN_IN_PRIVATE_KEY`)
 *   the server also trades the one-time authorization code for a refresh token, keeps it encrypted,
 *   and revokes it when the account is deleted (App Store guideline 5.1.1(v)). Without the key,
 *   sign-in still works and deletion skips revocation, recording that it did.
 */

export const APPLE_ISSUER = "https://appleid.apple.com";
/** The iOS app's bundle ID, which is the `aud` of its identity tokens and its Sign in with Apple client ID. */
export const APPLE_BUNDLE_ID = "app.parkdex";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const KEYS_CACHE_MS = 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 8_000;
const APPLE_ID_PATTERN = /^[A-Z0-9]{10}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const TOKEN_CIPHER_VERSION = "v1";

export interface AppleEnvironment {
  AUTH_SESSION_SECRET?: string;
  /** Overrides the bundle ID, for tests and local stacks only. */
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_SIGN_IN_KEY_ID?: string;
  /** The whole .p8 file. Escaped `\n` sequences are accepted for single-line secret stores. */
  APPLE_SIGN_IN_PRIVATE_KEY?: string;
}

export interface AppleIdentityClaims {
  sub: string;
  /** Normalized, or null when Apple sent none. Hide My Email gives a privaterelay.appleid.com address. */
  email: string | null;
  isPrivateEmail: boolean;
  nonce: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class AppleTokenError extends Error {
  constructor() {
    super("Sign in with Apple could not be verified.");
    this.name = "AppleTokenError";
  }
}

let cachedKeys: { keys: Map<string, JsonWebKey>; fetchedAt: number } | null = null;

/** Only for tests: forget the cached Apple keys. */
export function resetAppleKeyCache(): void {
  cachedKeys = null;
}

export function appleClientId(env: AppleEnvironment): string {
  const configured = env.APPLE_CLIENT_ID?.trim();
  return configured && /^[A-Za-z0-9.-]{3,155}$/u.test(configured) ? configured : APPLE_BUNDLE_ID;
}

function applePrivateKey(env: AppleEnvironment): string | null {
  const raw = env.APPLE_SIGN_IN_PRIVATE_KEY;
  if (!raw) return null;
  const pem = raw.includes("\\n") ? raw.replaceAll("\\n", "\n") : raw;
  return pem.includes("-----BEGIN PRIVATE KEY-----") ? pem : null;
}

/** Whether this deployment can trade authorization codes and revoke tokens. */
export function appleRevocationConfigured(env: AppleEnvironment): boolean {
  return (
    APPLE_ID_PATTERN.test(env.APPLE_TEAM_ID ?? "") &&
    APPLE_ID_PATTERN.test(env.APPLE_SIGN_IN_KEY_ID ?? "") &&
    applePrivateKey(env) !== null &&
    Buffer.byteLength(env.AUTH_SESSION_SECRET ?? "", "utf8") >= 32
  );
}

function decodeSegment(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(segment)) throw new AppleTokenError();
  return Buffer.from(segment, "base64url");
}

function jsonSegment(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeSegment(segment).toString("utf8"));
  } catch {
    throw new AppleTokenError();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppleTokenError();
  return value as Record<string, unknown>;
}

async function appleKeys(fetcher: Fetcher, now: number, refresh: boolean): Promise<Map<string, JsonWebKey>> {
  if (!refresh && cachedKeys && now - cachedKeys.fetchedAt < KEYS_CACHE_MS) return cachedKeys.keys;
  const response = await fetcher(APPLE_KEYS_URL, { redirect: "error", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (!response.ok) throw new AppleTokenError();
  const body = (await response.json()) as { keys?: unknown };
  const keys = new Map<string, JsonWebKey>();
  for (const key of Array.isArray(body.keys) ? body.keys : []) {
    if (key && typeof key === "object" && typeof key.kid === "string" && key.kty === "RSA") keys.set(key.kid, key as JsonWebKey);
  }
  if (!keys.size) throw new AppleTokenError();
  cachedKeys = { keys, fetchedAt: now };
  return keys;
}

/**
 * Verifies an identity token from AuthenticationServices. Apple rotates its keys, so an unknown
 * key ID refreshes the cached set once before the token is rejected.
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
  options: { audience: string; nonce: string; now: number; fetch?: Fetcher },
): Promise<AppleIdentityClaims> {
  const parts = identityToken.split(".");
  if (parts.length !== 3) throw new AppleTokenError();
  const header = jsonSegment(parts[0]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AppleTokenError();
  const fetcher = options.fetch ?? globalThis.fetch;
  let jwk: JsonWebKey | undefined;
  try {
    jwk = (await appleKeys(fetcher, options.now, false)).get(header.kid) ?? (await appleKeys(fetcher, options.now, true)).get(header.kid);
  } catch {
    throw new AppleTokenError();
  }
  if (!jwk) throw new AppleTokenError();
  let signatureValid = false;
  try {
    signatureValid = verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
      createPublicKey({ key: jwk, format: "jwk" }),
      decodeSegment(parts[2]),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new AppleTokenError();

  const claims = jsonSegment(parts[1]);
  const expMillis = typeof claims.exp === "number" ? claims.exp * 1000 : Number.NaN;
  const iatMillis = typeof claims.iat === "number" ? claims.iat * 1000 : Number.NaN;
  const audienceMatches = Array.isArray(claims.aud) ? claims.aud.includes(options.audience) : claims.aud === options.audience;
  if (
    claims.iss !== APPLE_ISSUER ||
    !audienceMatches ||
    typeof claims.sub !== "string" ||
    claims.sub.length < 1 ||
    claims.sub.length > 255 ||
    !Number.isFinite(expMillis) ||
    expMillis <= options.now ||
    !Number.isFinite(iatMillis) ||
    iatMillis > options.now + 60_000 ||
    expMillis - iatMillis > 24 * 60 * 60 * 1000 ||
    typeof claims.nonce !== "string" ||
    claims.nonce !== options.nonce
  ) {
    throw new AppleTokenError();
  }
  // Apple sends booleans as booleans or as the strings "true"/"false".
  const truthy = (value: unknown) => value === true || value === "true";
  const rawEmail = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const email =
    rawEmail && EMAIL_PATTERN.test(rawEmail) && rawEmail.length <= 254 && (claims.email_verified === undefined || truthy(claims.email_verified))
      ? rawEmail
      : null;
  return { sub: claims.sub, email, isPrivateEmail: truthy(claims.is_private_email), nonce: claims.nonce };
}

/** The ES256 client secret Apple's token and revoke endpoints expect, valid for five minutes. */
export function appleClientSecret(env: AppleEnvironment, now: number): string {
  const pem = applePrivateKey(env);
  if (!pem || !appleRevocationConfigured(env)) throw new Error("Sign in with Apple key is not configured");
  const issuedAt = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: env.APPLE_SIGN_IN_KEY_ID })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: env.APPLE_TEAM_ID, iat: issuedAt, exp: issuedAt + 300, aud: APPLE_ISSUER, sub: appleClientId(env) }),
  ).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`, "utf8"), { key: createPrivateKey(pem), dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

/** Trades a one-time authorization code for a refresh token. Null when Apple refuses or is unreachable. */
export async function exchangeAppleAuthorizationCode(
  code: string,
  env: AppleEnvironment,
  now: number,
  fetcher: Fetcher = globalThis.fetch,
): Promise<string | null> {
  if (!appleRevocationConfigured(env)) return null;
  try {
    const response = await fetcher(APPLE_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: appleClientId(env), client_secret: appleClientSecret(env, now), code, grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { refresh_token?: unknown };
    return typeof body.refresh_token === "string" && body.refresh_token.length > 0 && body.refresh_token.length <= 2048 ? body.refresh_token : null;
  } catch {
    return null;
  }
}

/** Revokes a refresh token. Apple answers 200 for tokens that are already invalid, so false means "try again later". */
export async function revokeAppleRefreshToken(refreshToken: string, env: AppleEnvironment, now: number, fetcher: Fetcher = globalThis.fetch): Promise<boolean> {
  if (!appleRevocationConfigured(env)) return false;
  try {
    const response = await fetcher(APPLE_REVOKE_URL, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: appleClientId(env),
        client_secret: appleClientSecret(env, now),
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function tokenKey(env: AppleEnvironment): Buffer {
  const secret = env.AUTH_SESSION_SECRET ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("account secret is not configured");
  return createHmac("sha256", secret).update("kip-account\u0000apple-refresh-token\u0000v1", "utf8").digest();
}

/** AES-256-GCM with a key derived from AUTH_SESSION_SECRET. Rotating that secret makes old tokens unreadable, which only skips their revocation. */
export function encryptAppleRefreshToken(token: string, env: AppleEnvironment): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [TOKEN_CIPHER_VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function decryptAppleRefreshToken(value: string, env: AppleEnvironment): string | null {
  const [version, iv, ciphertext, tag, extra] = value.split(".");
  if (version !== TOKEN_CIPHER_VERSION || !iv || !ciphertext || !tag || extra !== undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(env), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** The name Apple shares only on the first sign-in on a device, as the app received it. */
export function appleDisplayName(givenName: unknown, familyName: unknown): string | null {
  const parts = [givenName, familyName].map((part) => (typeof part === "string" ? part.trim() : "")).filter(Boolean);
  const name = parts.join(" ");
  return name && Array.from(name).length <= 80 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
}

/** apple-app-site-association for friend and account links, or null until the team ID is configured. */
export function appleAppSiteAssociation(env: AppleEnvironment): Record<string, unknown> | null {
  const teamId = env.APPLE_TEAM_ID?.trim() ?? "";
  if (!APPLE_ID_PATTERN.test(teamId)) return null;
  const appId = `${teamId}.${appleClientId(env)}`;
  return {
    applinks: {
      details: [
        {
          appIDs: [appId],
          components: [
            { "/": "/friend/*", comment: "Friend invites" },
            { "/": "/account", comment: "Email verification and password reset links" },
            { "/": "/account/", comment: "Email verification and password reset links" },
          ],
        },
      ],
    },
    webcredentials: { apps: [appId] },
  };
}
