export type Account = { id: string; email: string };
export type AccountSession = {
  token: string;
  expiresAt: string;
  account: Account;
  visitedIds: string[];
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
  if (response.ok) return response.json() as Promise<T>;
  let message = "Something went wrong. Please try again.";
  try { message = (await response.json() as { detail?: string }).detail ?? message; } catch { /* use friendly fallback */ }
  throw new ApiError(message, response.status);
}

export async function authenticate(apiBaseUrl: string, mode: "register" | "login", email: string, password: string): Promise<AccountSession> {
  const response = await fetch(`${apiBaseUrl}/api/auth/${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseResponse<AccountSession>(response);
}

export async function loadAccount(apiBaseUrl: string, token: string): Promise<Omit<AccountSession, "token" | "expiresAt">> {
  return parseResponse(await fetch(`${apiBaseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }));
}

export async function logout(apiBaseUrl: string, token: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new ApiError("Could not sign out. Please try again.", response.status);
}

export async function importGuestProgress(apiBaseUrl: string, token: string, collectionKey: string) {
  return parseResponse<{ importedVisitCount: number; importedTrailCount: number; visitedIds: string[]; completedTrailIds: string[] }>(
    await fetch(`${apiBaseUrl}/api/account/import-guest`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Collection-Key": collectionKey } }),
  );
}
