import { apiEnvironment, apiUrl } from "../apiPointer";
import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { hasRawUrlCredentials, hasUrlCredentials, isSecureUserDataApiOrigin, resolveUserDataApiOrigin } from "../userDataDestination";

export { KIP_PRODUCTION_ORIGIN, KIP_STAGING_ORIGIN } from "../userDataDestination";

export interface NativeAccountSession {
  token: string;
  /** Unix epoch time in milliseconds. */
  expiresAt: number;
  apiOrigin: string;
}

export interface ServerAccountSession {
  sessionToken: string;
  expiresAt: number | string;
}

/** What Sign in with Apple hands the app; the server verifies the token and may trade the code. */
export interface AppleCredential {
  identityToken: string;
  authorizationCode?: string;
  /** Apple shares the name only on the first sign-in on a device. */
  givenName?: string;
  familyName?: string;
}

interface NativeIdentityPlugin {
  /** On iOS `serverClientId` is the iOS OAuth client, which the server names for iOS requests. */
  getGoogleIdToken(options: { serverClientId: string; nonce: string }): Promise<{ idToken: string }>;
  /** iOS only. */
  getAppleCredential(options: { nonce: string }): Promise<AppleCredential>;
  setSession(options: { token: string; expiresAt: number; apiOrigin: string }): Promise<void>;
  getSession(): Promise<{ token?: string; expiresAt?: number; apiOrigin?: string; requiresReauth?: boolean } | null | undefined>;
  clearSession(options?: { clearCredentialState?: boolean }): Promise<void>;
}

export interface NativeAuthLink {
  kind: "verification" | "password_reset";
  token: string;
}

type AppUrlOpenListener = { remove: () => Promise<void> };
type AuthLinkHandler = (url: string) => void | Promise<void>;

const NativeIdentity = registerPlugin<NativeIdentityPlugin>("NativeIdentity");
const recentAuthLinkDigests = new Set<string>();

export class NativeSessionOriginMismatchError extends Error {
  constructor() {
    super(
      "This saved Parkdex session needs a new sign-in before it can sync with this app environment. Your saved progress stays on this device. Sign in again here to sync it.",
    );
    this.name = "NativeSessionOriginMismatchError";
  }
}

export function isAndroidNativeIdentityAvailable(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("NativeIdentity");
}

/** Sign-in and the saved session: Android's plugin, or the iOS one every iOS build compiles in. */
export function isNativeIdentityAvailable(): boolean {
  return isAndroidNativeIdentityAvailable() || Capacitor.getPlatform() === "ios";
}

/** Sign in with Apple exists only in the iOS app (App Store guideline 4.8). */
export function isAppleSignInAvailable(): boolean {
  return Capacitor.getPlatform() === "ios";
}

/** A public OAuth web client ID may come from server config or a build-time public variable. */
export function resolveGoogleWebClientId(explicitClientId?: string | null): string | null {
  const requested = (explicitClientId ?? "").trim();
  const clientId = requested || (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID ?? "").trim();
  return clientId.length > 0 ? clientId : null;
}

export async function requestNativeGoogleIdToken(options: { nonce: string; serverClientId?: string | null }): Promise<string> {
  assertNativeIdentityAvailable();
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

export async function requestNativeAppleCredential(options: { nonce: string }): Promise<AppleCredential> {
  if (!isAppleSignInAvailable()) throw new Error("Sign in with Apple is available in the iOS app.");
  const nonce = options.nonce;
  if (!nonce || nonce !== nonce.trim() || nonce.length > 512) {
    throw new Error("A valid server-issued Sign in with Apple nonce is required.");
  }
  const result = await NativeIdentity.getAppleCredential({ nonce });
  if (typeof result?.identityToken !== "string" || !result.identityToken.trim()) {
    throw new Error("Sign in with Apple did not return an identity token.");
  }
  const credential: AppleCredential = { identityToken: result.identityToken };
  if (typeof result.authorizationCode === "string" && result.authorizationCode) credential.authorizationCode = result.authorizationCode;
  if (typeof result.givenName === "string" && result.givenName.trim()) credential.givenName = result.givenName.trim().slice(0, 80);
  if (typeof result.familyName === "string" && result.familyName.trim()) credential.familyName = result.familyName.trim().slice(0, 80);
  return credential;
}

export async function persistNativeSession(session: ServerAccountSession): Promise<void> {
  assertNativeIdentityAvailable();
  if (typeof session.sessionToken !== "string" || !session.sessionToken.trim() || session.sessionToken !== session.sessionToken.trim()) {
    throw new Error("The server did not return a valid native session.");
  }
  const expiresAt = expiryToEpochMillis(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("The server returned an expired native session.");
  }
  await NativeIdentity.setSession({ token: session.sessionToken, expiresAt, apiOrigin: getAuthApiOrigin() });
}

export async function readNativeSession(expectedApiOrigin = getAuthApiOrigin()): Promise<NativeAccountSession | null> {
  assertNativeIdentityAvailable();
  const stored = await NativeIdentity.getSession();
  if (!stored) {
    return null;
  }
  if (stored.requiresReauth) throw new NativeSessionOriginMismatchError();
  if (typeof stored.token !== "string" || !stored.token.trim() || typeof stored.expiresAt !== "number" || !Number.isFinite(stored.expiresAt)) return null;
  if (stored.expiresAt <= Date.now()) {
    throw new NativeSessionOriginMismatchError();
  }
  if (typeof stored.apiOrigin !== "string" || !isSecureUserDataApiOrigin(stored.apiOrigin)) {
    throw new NativeSessionOriginMismatchError();
  }
  if (stored.apiOrigin !== expectedApiOrigin) throw new NativeSessionOriginMismatchError();
  return { token: stored.token, expiresAt: stored.expiresAt, apiOrigin: stored.apiOrigin };
}

export async function clearNativeSession(clearCredentialState = true): Promise<void> {
  assertNativeIdentityAvailable();
  await NativeIdentity.clearSession({ clearCredentialState });
}

/** Sends native auth requests without WebView cookies or caller-supplied bearer tokens. */
export async function nativeAuthFetch(input: RequestInfo | URL, init: RequestInit = {}, fetcher: typeof fetch = globalThis.fetch): Promise<Response> {
  assertNativeIdentityAvailable();
  const apiOrigin = getAuthApiOrigin();
  const session = await readNativeSession(apiOrigin);
  const rawUrl = typeof Request !== "undefined" && input instanceof Request ? input.url : String(input);
  const requestUrl = new URL(rawUrl, apiOrigin);
  if (requestUrl.protocol !== "https:" || requestUrl.origin !== apiOrigin || hasUrlCredentials(requestUrl) || hasRawUrlCredentials(rawUrl) || requestUrl.hash) {
    throw new Error("Native account requests must use the configured account API origin.");
  }
  const headers = new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
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
    redirect: "error",
  });
}

/** Registers the Android App Links (or iOS universal links) event and forwards a cold-start link exactly once. */
export async function listenForNativeAuthLinks(handler: AuthLinkHandler): Promise<() => Promise<void>> {
  if (!isNativeIdentityAvailable()) return async () => {};

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
    listener = await App.addListener("appUrlOpen", ({ url }) => {
      void forward(url);
    });
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
  return getAuthApiOrigin();
}

function getAuthApiOrigin(): string {
  const configured =
    apiUrl(
      (import.meta.env.VITE_ACCOUNT_API_URL ?? "").trim() ||
        (import.meta.env.VITE_APP_URL ?? "").trim() ||
        (import.meta.env.VITE_PREVIEW_API_ORIGIN ?? "").trim(),
    ) ?? "";
  return resolveUserDataApiOrigin(configured, {
    native: true,
    environment: apiEnvironment(),
    previewOrigin: import.meta.env.VITE_PREVIEW_API_ORIGIN,
  });
}

export function isApprovedKipOrigin(origin: string): boolean {
  try {
    return (
      isSecureUserDataApiOrigin(origin) &&
      resolveUserDataApiOrigin(origin, {
        native: true,
        environment: apiEnvironment(),
        previewOrigin: import.meta.env.VITE_PREVIEW_API_ORIGIN,
      }) === origin
    );
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

function assertNativeIdentityAvailable(): void {
  if (!isNativeIdentityAvailable()) {
    throw new Error("Native account identity is available only in the Parkdex app.");
  }
}
