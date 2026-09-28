import { HttpError } from "./validation.js";

export const OPERATOR_SESSION_COOKIE = "kip_operator_session";
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const PBKDF2_ITERATIONS = 210_000;
const HEX = /^[0-9a-f]+$/i;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHashPart(value: string): Uint8Array | null {
  if (value.length % 2 === 0 && HEX.test(value)) {
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    return bytes;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length, 1);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export async function verifyOperatorPassword(password: string, encodedHash: string | undefined): Promise<boolean> {
  if (!encodedHash || password.length > 256) return false;
  const parts = encodedHash.split(":");
  if (parts.length !== 2) return false;
  const salt = decodeHashPart(parts[0]);
  const expected = decodeHashPart(parts[1]);
  if (!salt || salt.length < 16 || salt.length > 64 || !expected || expected.length !== 32) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt).buffer, iterations: PBKDF2_ITERATIONS },
      key,
      256,
    );
    return constantTimeEqual(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}

export async function keyedHash(secret: string, scope: string, value: string): Promise<string> {
  if (new TextEncoder().encode(secret).length < 32) throw new Error("session secret is unavailable");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${scope}\u0000${value}`));
  return bytesToHex(new Uint8Array(signature));
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function hmac(secret: string, input: string): Promise<Uint8Array> {
  if (new TextEncoder().encode(secret).length < 32) throw new HttpError(503, "service_unavailable", "Operator sign-in is unavailable.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
}

export async function createSessionToken(secret: string, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const payload = base64UrlEncode(JSON.stringify({ v: 1, iat: issuedAt, exp: issuedAt + SESSION_MAX_AGE_SECONDS, nonce: crypto.randomUUID() }));
  const signature = await hmac(secret, payload);
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `${payload}.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

export async function verifySessionToken(token: string | null, secret: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token || !secret || token.length > 1024 || new TextEncoder().encode(secret).length < 32) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(signature)) return false;
  let actual: Uint8Array;
  try {
    const base64 = signature.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    actual = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return false;
  }
  let expected: Uint8Array;
  try {
    expected = await hmac(secret, payload);
  } catch {
    return false;
  }
  if (!constantTimeEqual(actual, expected)) return false;
  const decoded = base64UrlDecode(payload);
  if (!decoded) return false;
  try {
    const session = JSON.parse(decoded) as { v?: unknown; iat?: unknown; exp?: unknown; nonce?: unknown };
    const nowSeconds = Math.floor(now / 1000);
    return session.v === 1 && Number.isSafeInteger(session.iat) && Number.isSafeInteger(session.exp) &&
      (session.iat as number) <= nowSeconds + 60 && (session.exp as number) > nowSeconds &&
      (session.exp as number) - (session.iat as number) <= SESSION_MAX_AGE_SECONDS && typeof session.nonce === "string";
  } catch {
    return false;
  }
}

export function readSessionCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const item of cookie.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === OPERATOR_SESSION_COOKIE) return item.slice(separator + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string): string {
  return `${OPERATOR_SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${OPERATOR_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function getClientAddress(request: Request): string {
  const address = request.headers.get("cf-connecting-ip")?.trim();
  if (!address || address.length > 64 || /[\s,]/.test(address)) return "unknown";
  return address.toLowerCase();
}

function normalizedOrigin(value: string | null): string | null {
  if (!value || value === "null") return null;
  if (value === "capacitor://localhost") return value;
  try {
    const origin = new URL(value);
    if (origin.origin === "null" || origin.origin !== value.replace(/\/$/, "")) return null;
    return origin.origin;
  } catch {
    return null;
  }
}

export interface OriginEnvironment {
  PUBLIC_APP_URL?: string;
  ALLOWED_ORIGINS?: string;
}

export function allowedOrigins(request: Request, env: OriginEnvironment): Set<string> {
  const origins = new Set<string>([
    new URL(request.url).origin,
    "http://localhost",
    "https://localhost",
    "capacitor://localhost",
  ]);
  for (const value of (env.ALLOWED_ORIGINS ?? "").split(/[\s,]+/)) {
    const origin = normalizedOrigin(value);
    if (origin) origins.add(origin);
  }
  if (env.PUBLIC_APP_URL) {
    try {
      const url = new URL(env.PUBLIC_APP_URL);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin !== "null") origins.add(url.origin);
    } catch {
      // Invalid public URLs do not expand the cross-origin allowlist.
    }
  }
  return origins;
}

export function requestOriginAllowed(request: Request, env: OriginEnvironment): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return true;
  const origin = normalizedOrigin(originHeader);
  return origin !== null && allowedOrigins(request, env).has(origin);
}

export function isSameOriginWrite(request: Request): boolean {
  const origin = normalizedOrigin(request.headers.get("origin"));
  return origin !== null && origin === new URL(request.url).origin;
}
