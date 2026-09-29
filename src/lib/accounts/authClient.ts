import { Capacitor } from "@capacitor/core";
import { accountBackupFetch, assertAccountBackupRequest, isAccountBackupPath } from "./accountBackupTransport";
import {
  nativeAuthFetch,
  persistNativeSession,
  isApprovedKipOrigin,
  KIP_STAGING_ORIGIN,
  type NativeAccountSession,
  type ServerAccountSession,
} from "./nativeIdentity";

export type AccountProfile = {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  providers: string[];
};

export type AuthConfig = {
  emailEnabled: boolean;
  emailDeliveryEnabled: boolean;
  googleEnabled: boolean;
  googleWebEnabled: boolean;
  googleNativeEnabled: boolean;
  googleWebClientId: string | null;
  capabilities?: {
    web?: { email?: boolean; google?: boolean };
    native?: { email?: boolean; google?: boolean };
  };
};

export type AuthSessionResponse = { account: AccountProfile } & Partial<ServerAccountSession>;
export type GooglePurpose = "sign_in" | "reauth" | "link";
export type GoogleChallenge = { nonce: string; expiresAt: string | number };
export type DeletionResponse = { receiptId: string; status: "complete" | "pending" };
export type GoogleReauthResponse = { reauthenticatedUntil: string | number };
export type SessionRenewalResponse = { renewed: boolean; sessionToken?: string; expiresAt?: string | number };

export function isValidGoogleWebClientId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.trim());
}

export class AuthHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AuthHttpError";
  }
}

const isNative = Capacitor.isNativePlatform();

function apiUrl(path: string) {
  const configured = (import.meta.env.VITE_ACCOUNT_API_URL ?? import.meta.env.VITE_APP_URL ?? "").trim();
  let origin = isNative || typeof location === "undefined" ? KIP_STAGING_ORIGIN : location.origin;
  if (configured) {
    try {
      const candidate = new URL(configured);
      if (candidate.protocol === "https:" && (!isNative || isApprovedKipOrigin(candidate.origin))) origin = candidate.origin;
    } catch {
      // An invalid optional override falls back to the environment's known origin.
    }
  }
  return new URL(path, origin).href;
}

function csrfToken() {
  if (typeof document === "undefined") return "";
  const encoded = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("kip_account_csrf="))?.slice("kip_account_csrf=".length);
  if (!encoded) return "";
  try { return decodeURIComponent(encoded); }
  catch { return ""; }
}

function writeMethod(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function requestMethod(init: RequestInit, input?: RequestInfo | URL) {
  if (init.method) return init.method;
  if (typeof Request !== "undefined" && input instanceof Request) return input.method;
  return "GET";
}

async function parseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function fetchRequest(pathOrInput: string | Request | URL, init: RequestInit = {}, authenticated = false, expectedAccountId?: string) {
  const method = requestMethod(init, pathOrInput);
  const url = typeof pathOrInput === "string" && pathOrInput.startsWith("/") ? apiUrl(pathOrInput) : pathOrInput;
  const headers = new Headers(typeof Request !== "undefined" && pathOrInput instanceof Request ? pathOrInput.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  if (expectedAccountId) headers.set("X-Kip-Account-ID", expectedAccountId);

  const requestUrl = new URL(typeof Request !== "undefined" && url instanceof Request ? url.url : String(url), apiUrl("/"));
  if (isAccountBackupPath(requestUrl)) {
    if (!authenticated) throw new Error("Account backup requests require an authenticated account session.");
    const accountOrigin = new URL(apiUrl("/")).origin;
    assertAccountBackupRequest(requestUrl, method, accountOrigin);
    const signal = init.signal ?? (typeof Request !== "undefined" && url instanceof Request ? url.signal : undefined);
    if (isNative) {
      const backupFetcher: typeof fetch = (input, fetchInit) => accountBackupFetch(input, fetchInit ?? {}, accountOrigin);
      return nativeAuthFetch(url, { ...init, headers, signal }, backupFetcher);
    }
    headers.delete("Authorization");
    headers.delete("Cookie");
    if (writeMethod(method)) {
      const token = csrfToken();
      if (token) headers.set("X-CSRF-Token", token);
      else throw new Error("The security token is missing. Refresh this page and try again.");
    }
    return accountBackupFetch(url, { ...init, method, headers, signal }, accountOrigin);
  }

  if (isNative) {
    if (authenticated) return nativeAuthFetch(url, { ...init, headers });
    headers.set("X-Kip-Auth-Transport", "native");
    headers.delete("Authorization");
    headers.delete("Cookie");
    return fetch(url, { ...init, headers, credentials: "omit", cache: "no-store" });
  }

  headers.delete("Authorization");
  headers.delete("Cookie");
  if (writeMethod(method)) {
    const token = csrfToken();
    if (token) headers.set("X-CSRF-Token", token);
    else if (authenticated) throw new Error("The security token is missing. Refresh this page and try again.");
  }
  return fetch(url, { ...init, headers, credentials: "include", cache: "no-store" });
}

async function requestJson<T>(path: string, init: RequestInit = {}, authenticated = false, expectedAccountId?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetchRequest(path, { ...init, headers }, authenticated, expectedAccountId);
  const body = await parseBody(response);
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "The account service is unavailable. Try again shortly.";
    throw new AuthHttpError(response.status, message.slice(0, 240));
  }
  return body as T;
}

export function fetchAuthenticated(input: RequestInfo | URL, init?: RequestInit, expectedAccountId?: string): Promise<Response> {
  return fetchRequest(input, init, true, expectedAccountId);
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  return requestJson<AuthConfig>("/api/auth/config");
}

export async function getCurrentAccount(expectedAccountId?: string): Promise<AccountProfile> {
  const body = await requestJson<{ account: AccountProfile }>("/api/auth/me", {}, true, expectedAccountId);
  return body.account;
}

async function acceptSession(response: AuthSessionResponse): Promise<AccountProfile> {
  if (!response.account || typeof response.account.id !== "string") throw new Error("The account service returned an invalid session.");
  if (isNative) {
    if (!response.sessionToken || !response.expiresAt) throw new Error("The native account session was not returned securely.");
    await persistNativeSession(response as ServerAccountSession);
  }
  return response.account;
}

export async function registerAccount(input: { email: string; password: string; displayName: string }): Promise<AccountProfile> {
  const response = await requestJson<AuthSessionResponse>("/api/auth/register", { method: "POST", body: JSON.stringify(input) });
  return acceptSession(response);
}

export async function loginAccount(input: { email: string; password: string }): Promise<AccountProfile> {
  const response = await requestJson<AuthSessionResponse>("/api/auth/login", { method: "POST", body: JSON.stringify(input) });
  return acceptSession(response);
}

export async function renewSession(expectedAccountId: string): Promise<SessionRenewalResponse> {
  const response = await requestJson<SessionRenewalResponse>("/api/auth/sessions/renew", { method: "POST", body: "{}" }, true, expectedAccountId);
  if (typeof response.renewed !== "boolean") throw new Error("The account service returned an invalid renewal response.");
  if (!response.renewed) return response;
  if (!response.expiresAt) throw new Error("The account service did not return a renewed session expiry.");
  if (isNative) {
    if (!response.sessionToken) throw new Error("The account service did not return a secure native session.");
    await persistNativeSession({ sessionToken: response.sessionToken, expiresAt: response.expiresAt });
  }
  return response;
}

export async function logoutAccount(expectedAccountId: string): Promise<void> {
  await requestJson<Record<string, unknown>>("/api/auth/logout", { method: "POST", body: "{}" }, true, expectedAccountId);
}

export async function requestEmailVerification(expectedAccountId: string): Promise<void> {
  await requestJson<Record<string, unknown>>("/api/auth/verification/request", { method: "POST", body: "{}" }, true, expectedAccountId);
}

export async function confirmEmailVerification(token: string): Promise<void> {
  await requestJson<Record<string, unknown>>("/api/auth/verification/confirm", { method: "POST", body: JSON.stringify({ token }) });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await requestJson<Record<string, unknown>>("/api/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email }) });
}

export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  await requestJson<Record<string, unknown>>("/api/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token, newPassword }) });
}

export async function createGoogleChallenge(purpose: GooglePurpose, expectedAccountId?: string): Promise<GoogleChallenge> {
  return requestJson<GoogleChallenge>("/api/auth/google/challenge", { method: "POST", body: JSON.stringify({ purpose }) }, purpose !== "sign_in", expectedAccountId);
}

export async function completeGoogleSignIn(idToken: string, nonce: string, transport: "web" | "native"): Promise<AccountProfile> {
  const path = transport === "native" ? "/api/auth/google/native" : "/api/auth/google";
  const response = await requestJson<AuthSessionResponse>(path, {
    method: "POST",
    headers: transport === "native" ? { "X-Kip-Auth-Transport": "native" } : undefined,
    body: JSON.stringify({ idToken, nonce }),
  });
  return acceptSession(response);
}

export async function linkGoogleAccount(idToken: string, nonce: string, transport: "web" | "native", expectedAccountId: string): Promise<AccountProfile> {
  const path = transport === "native" ? "/api/auth/google/native" : "/api/auth/google";
  const body = await requestJson<{ account: AccountProfile }>(path, {
    method: "POST",
    headers: transport === "native" ? { "X-Kip-Auth-Transport": "native" } : undefined,
    body: JSON.stringify({ idToken, nonce }),
  }, true, expectedAccountId);
  if (!body.account || body.account.id.toLowerCase() !== expectedAccountId.toLowerCase()) {
    throw new Error("Google did not link to the signed-in account.");
  }
  return body.account;
}

export async function reauthenticatePassword(password: string, expectedAccountId: string): Promise<void> {
  await requestJson<Record<string, unknown>>("/api/auth/reauth/password", { method: "POST", body: JSON.stringify({ password }) }, true, expectedAccountId);
}

export async function reauthenticateGoogle(idToken: string, nonce: string, transport: "web" | "native", expectedAccountId: string): Promise<void> {
  const path = transport === "native" ? "/api/auth/google/native" : "/api/auth/google";
  const body = await requestJson<GoogleReauthResponse>(path, {
    method: "POST",
    headers: transport === "native" ? { "X-Kip-Auth-Transport": "native" } : undefined,
    body: JSON.stringify({ idToken, nonce }),
  }, true, expectedAccountId);
  if (!body.reauthenticatedUntil) throw new Error("Google did not confirm recent account verification.");
}

export async function deleteCurrentAccount(expectedAccountId: string): Promise<DeletionResponse> {
  return requestJson<DeletionResponse>("/api/account", { method: "DELETE" }, true, expectedAccountId);
}

export async function clearLocalNativeSession(): Promise<void> {
  if (!isNative) return;
  const { clearNativeSession } = await import("./nativeIdentity");
  await clearNativeSession();
}

export async function readLocalNativeSession(): Promise<NativeAccountSession | null> {
  if (!isNative) return null;
  const { readNativeSession } = await import("./nativeIdentity");
  return readNativeSession();
}

export function isNativeAccountRuntime() {
  return isNative;
}
