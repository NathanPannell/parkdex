import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";

export interface NativeAccountSession {
  token: string;
  /** Unix epoch time in milliseconds. */
  expiresAt: number;
}

export interface ServerAccountSession {
  sessionToken: string;
  expiresAt: number | string;
}

interface NativeIdentityPlugin {
  getGoogleIdToken(options: { serverClientId: string; nonce: string }): Promise<{ idToken: string }>;
  setSession(options: { token: string; expiresAt: number }): Promise<void>;
  getSession(): Promise<{ token?: string; expiresAt?: number } | null | undefined>;
  clearSession(): Promise<void>;
}

export interface NativeAuthLink {
  kind: "verification" | "password_reset";
  token: string;
}

type AppUrlOpenListener = { remove: () => Promise<void> };
type AuthLinkHandler = (url: string) => void | Promise<void>;

const NativeIdentity = registerPlugin<NativeIdentityPlugin>("NativeIdentity");
const recentAuthLinkDigests = new Set<string>();
export const KIP_STAGING_ORIGIN = "https://staging.web.parkdex.app";
export const KIP_PRODUCTION_ORIGIN = "https://web.parkdex.app";
const APPROVED_KIP_ORIGINS = new Set([
  KIP_STAGING_ORIGIN,
  KIP_PRODUCTION_ORIGIN,
  "https://parkdex-kip-staging.vercel.app",
  "https://parkdex-kip.vercel.app",
]);

export function isAndroidNativeIdentityAvailable(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("NativeIdentity");
}

/** A public OAuth web client ID may come from server config or a build-time public variable. */
export function resolveGoogleWebClientId(explicitClientId?: string | null): string | null {
  const requested = (explicitClientId ?? "").trim();
  const clientId = requested || (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID ?? "").trim();
  return clientId.length > 0 ? clientId : null;
}

export async function requestNativeGoogleIdToken(options: {
  nonce: string;
  serverClientId?: string | null;
}): Promise<string> {
  assertAndroidNativeIdentityAvailable();
  const nonce = options.nonce;
  const serverClientId = resolveGoogleWebClientId(options.serverClientId);
  if (!nonce || nonce !== nonce.trim() || nonce.length > 512) {
    throw new Error("A valid server-issued Google sign-in nonce is required.");
  }
  if (!serverClientId) throw new Error("Google sign-in is not configured.");

  const result = await NativeIdentity.getGoogleIdToken({ serverClientId, nonce });
  if (typeof result?.idToken !== "string" || !result.idToken.trim()) {
    throw new Error("Google sign-in did not return an ID token.");
  }
  return result.idToken;
}

export async function persistNativeSession(session: ServerAccountSession): Promise<void> {
  assertAndroidNativeIdentityAvailable();
  if (typeof session.sessionToken !== "string" || !session.sessionToken.trim()
      || session.sessionToken !== session.sessionToken.trim()) {
    throw new Error("The server did not return a valid native session.");
  }
  const expiresAt = expiryToEpochMillis(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("The server returned an expired native session.");
  }
  await NativeIdentity.setSession({ token: session.sessionToken, expiresAt });
}

export async function readNativeSession(): Promise<NativeAccountSession | null> {
  assertAndroidNativeIdentityAvailable();
  const stored = await NativeIdentity.getSession();
  if (!stored || typeof stored.token !== "string" || !stored.token.trim()
      || typeof stored.expiresAt !== "number" || !Number.isFinite(stored.expiresAt)) {
    return null;
  }
  if (stored.expiresAt <= Date.now()) {
    await NativeIdentity.clearSession();
    return null;
  }
  return { token: stored.token, expiresAt: stored.expiresAt };
}

export async function clearNativeSession(): Promise<void> {
  assertAndroidNativeIdentityAvailable();
  await NativeIdentity.clearSession();
}

/** Sends native auth requests without WebView cookies or caller-supplied bearer tokens. */
export async function nativeAuthFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Response> {
  assertAndroidNativeIdentityAvailable();
  const session = await readNativeSession();
  const apiOrigin = getAuthApiOrigin();
  const rawUrl = typeof Request !== "undefined" && input instanceof Request ? input.url : String(input);
  const requestUrl = new URL(rawUrl, apiOrigin);
  if (requestUrl.origin !== apiOrigin) {
    throw new Error("Native account requests must use the configured account API origin.");
  }
  const headers = new Headers(
    typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
  );
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.set("X-Kip-Auth-Transport", "native");
  if (session) headers.set("Authorization", `Bearer ${session.token}`);

  return fetcher(typeof Request !== "undefined" && input instanceof Request ? input : requestUrl.href, {
    ...init,
    headers,
    credentials: "omit",
    cache: "no-store",
  });
}

/** Registers the Android App Links event and forwards a cold-start link exactly once. */
export async function listenForNativeAuthLinks(handler: AuthLinkHandler): Promise<() => Promise<void>> {
  if (!isAndroidNativeIdentityAvailable()) return async () => {};

  const expectedOrigin = getAuthLinkOrigin();
  const forward = async (url: string | undefined) => {
    if (!url || !parseNativeAuthLink(url, expectedOrigin)) return;
    const digest = await authLinkDigest(url);
    if (recentAuthLinkDigests.has(digest)) return;
    recentAuthLinkDigests.add(digest);
    if (recentAuthLinkDigests.size > 8) {
      const oldest = recentAuthLinkDigests.values().next().value;
      if (oldest) recentAuthLinkDigests.delete(oldest);
    }
    clearCurrentAuthFragment();
    try {
      await handler(url);
    } catch {
      // Auth UI owns errors for an action link; avoid leaking a token through an unhandled rejection.
    }
  };

  let listener: AppUrlOpenListener | undefined;
  try {
    listener = await App.addListener("appUrlOpen", ({ url }) => { void forward(url); });
    const launchUrl = await App.getLaunchUrl();
    await forward(launchUrl?.url);
  } catch (error) {
    await listener?.remove();
    throw error;
  }

  let removed = false;
  return async () => {
    if (removed) return;
    removed = true;
    await listener?.remove();
  };
}

export function parseNativeAuthLink(rawUrl: string, expectedOrigin = getAuthLinkOrigin()): NativeAuthLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin !== expectedOrigin || !["/account", "/account/"].includes(url.pathname)) {
    return null;
  }
  if (url.searchParams.has("verificationToken") || url.searchParams.has("resetToken")) return null;

  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const verificationToken = params.getAll("verificationToken");
  const resetToken = params.getAll("resetToken");
  if (verificationToken.length + resetToken.length !== 1) return null;
  const token = (verificationToken[0] ?? resetToken[0] ?? "").trim();
  if (!token || token.length > 2048) return null;
  return {
    kind: verificationToken.length === 1 ? "verification" : "password_reset",
    token,
  };
}

function expiryToEpochMillis(value: number | string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  }
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

async function authLinkDigest(rawUrl: string): Promise<string> {
  const data = new TextEncoder().encode(rawUrl);
  try {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    // This digest is only used to suppress duplicate launch callbacks, not for authentication.
    let hash = 2166136261;
    for (let index = 0; index < data.length; index += 1) {
      hash = Math.imul(hash ^ data[index], 16777619);
    }
    return `fallback-${(hash >>> 0).toString(16)}`;
  } finally {
    data.fill(0);
  }
}

function getAuthLinkOrigin(): string {
  return configuredKipOrigin(import.meta.env.VITE_APP_URL) ?? KIP_STAGING_ORIGIN;
}

function getAuthApiOrigin(): string {
  return configuredKipOrigin(import.meta.env.VITE_ACCOUNT_API_URL)
    ?? configuredKipOrigin(import.meta.env.VITE_APP_URL)
    ?? KIP_STAGING_ORIGIN;
}

function configuredKipOrigin(value: string | undefined): string | null {
  const configured = (value ?? "").trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || !isApprovedKipOrigin(url.origin)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isApprovedKipOrigin(origin: string): boolean {
  if (APPROVED_KIP_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
        || (url.port && url.port !== "443") || !["", "/"].includes(url.pathname)) return false;
    const hostname = url.hostname.toLowerCase();
    if (url.origin !== origin) return false;
    return /^parkdex-kip-[a-z0-9]+(?:-[a-z0-9]+)*\.vercel\.app$/.test(hostname)
      || /^parkdex-[a-z0-9]+-nathanpannells-projects\.vercel\.app$/.test(hostname);
  } catch {
    return false;
  }
}

function clearCurrentAuthFragment(): void {
  if (typeof window === "undefined" || typeof history === "undefined") return;
  const current = new URL(window.location.href);
  const params = new URLSearchParams(current.hash.startsWith("#") ? current.hash.slice(1) : current.hash);
  if (!params.has("verificationToken") && !params.has("resetToken")) return;
  params.delete("verificationToken");
  params.delete("resetToken");
  current.hash = params.toString() ? `#${params.toString()}` : "";
  history.replaceState(history.state, "", `${current.pathname}${current.search}${current.hash}`);
}

function assertAndroidNativeIdentityAvailable(): void {
  if (!isAndroidNativeIdentityAvailable()) {
    throw new Error("Native account identity is available only in the Android app.");
  }
}
