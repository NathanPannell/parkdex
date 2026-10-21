/** The fetch helper every section uses. Section-specific response types live in each section's types.ts. */

export type Health = { ok: boolean; environment: string; canSwitch: boolean; emailMode: "resend" | "disabled" | "unconfigured" };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function fallbackMessage(status: number): string {
  if (status === 401 || status === 403) return "Your Vercel sign-in has expired. Reload the page to sign in again.";
  if (status === 404) return "That item could not be found. It may have been removed.";
  if (status >= 500) return "The dashboard service is temporarily unavailable.";
  return "The request could not be completed.";
}

/** Calls the dashboard API and returns its JSON, or throws an ApiError with a message fit to show. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let message = fallbackMessage(response.status);
    try {
      const body = (await response.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string" && body.error.message.trim()) message = body.error.message.slice(0, 240);
    } catch {
      // Vercel's own sign-in and error pages are HTML; keep the friendly fallback.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
