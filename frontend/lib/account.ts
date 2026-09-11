export type Account = { id: string; email: string; emailVerified?: boolean; hasPassword?: boolean };
export type AuthConfig = { googleEnabled: boolean; emailEnabled: boolean };
export type Visit = { placeId: string; visitedAt: string };
export type AccountSession = {
  token: string;
  expiresAt: string;
  account: Account;
  visitedIds: string[];
  visits: Visit[];
  completedTrailIds: string[];
};

export const ACCOUNT_TOKEN_KEY = "every-park:account-token:v1";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }
  let message = "Something went wrong. Please try again.";
  try { message = (await response.json() as { detail?: string }).detail ?? message; } catch { /* use friendly fallback */ }
  throw new ApiError(message, response.status);
}

function jsonRequest(method: "POST", body?: unknown, token?: string): RequestInit {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  return { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
}

export async function authenticate(apiBaseUrl: string, mode: "register" | "login", email: string, password: string): Promise<AccountSession> {
  const response = await fetch(`${apiBaseUrl}/api/auth/${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseResponse<AccountSession>(response);
}

export async function loadAuthConfig(apiBaseUrl: string): Promise<AuthConfig> {
  return parseResponse<AuthConfig>(await fetch(`${apiBaseUrl}/api/auth/config`, { cache: "no-store" }));
}

export async function requestPasswordReset(apiBaseUrl: string, email: string): Promise<void> {
  await parseResponse<void>(await fetch(`${apiBaseUrl}/api/auth/password-reset/request`, jsonRequest("POST", { email })));
}

export async function confirmPasswordReset(apiBaseUrl: string, token: string, newPassword: string): Promise<void> {
  await parseResponse<void>(await fetch(`${apiBaseUrl}/api/auth/password-reset/confirm`, jsonRequest("POST", { token, newPassword })));
}

export async function requestEmailVerification(apiBaseUrl: string, token: string): Promise<void> {
  await parseResponse<void>(await fetch(`${apiBaseUrl}/api/auth/email-verification/request`, jsonRequest("POST", undefined, token)));
}

export async function confirmEmailVerification(apiBaseUrl: string, token: string): Promise<void> {
  await parseResponse<void>(await fetch(`${apiBaseUrl}/api/auth/email-verification/confirm`, jsonRequest("POST", { token })));
}

export async function requestGoogleAuthorization(apiBaseUrl: string, codeChallenge: string): Promise<string> {
  const params = new URLSearchParams({ codeChallenge });
  const result = await parseResponse<{ authorizationUrl: string }>(await fetch(`${apiBaseUrl}/api/auth/google/start?${params}`));
  return result.authorizationUrl;
}

export async function completeGoogleAuthorization(apiBaseUrl: string, code: string, state: string, codeVerifier: string): Promise<AccountSession> {
  return parseResponse<AccountSession>(await fetch(`${apiBaseUrl}/api/auth/google/callback`, jsonRequest("POST", { code, state, codeVerifier })));
}

export async function loadAccount(apiBaseUrl: string, token: string): Promise<Omit<AccountSession, "token" | "expiresAt">> {
  return parseResponse(await fetch(`${apiBaseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }));
}

export async function logout(apiBaseUrl: string, token: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new ApiError("Could not sign out. Please try again.", response.status);
}

export async function importGuestProgress(apiBaseUrl: string, token: string, collectionKey: string) {
  return parseResponse<{ importedVisitCount: number; importedTrailCount: number; visitedIds: string[]; visits: Visit[]; completedTrailIds: string[] }>(
    await fetch(`${apiBaseUrl}/api/account/import-guest`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Collection-Key": collectionKey } }),
  );
}

export async function resetAccountProgress(apiBaseUrl: string, token: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/account/progress`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    let message = "Could not reset your progress. Please try again.";
    try { message = (await response.json() as { detail?: string }).detail ?? message; } catch { /* use friendly fallback */ }
    throw new ApiError(message, response.status);
  }
}
