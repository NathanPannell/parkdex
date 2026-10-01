export type ReportStatus = "new" | "reviewing" | "planned" | "closed";
export type ReportKind = "bug" | "idea" | "general";
export type EmailAudience = "operator" | "receipt";

export type EmailDelivery = {
  audience: EmailAudience;
  status: string;
  attempts: number;
  lastAttemptAt: string | null;
  sentAt: string | null;
  lastError: string | null;
  canRetry: boolean;
  requiresConfirmation: boolean;
};

export type FeedbackReport = {
  id: string;
  kind: ReportKind;
  message: string;
  email: string | null;
  contact: boolean;
  context: { version?: string; build?: string; platform?: string; screen?: string; parkId?: string | null; parkName?: string | null };
  createdAt: string;
  status: ReportStatus;
  hasScreenshot: boolean;
  emails: EmailDelivery[];
};

export type FeedbackPage = { reports: FeedbackReport[]; nextCursor: string | null };

export type LngLat = [number, number];
export type ProposalStatus = "new" | "reviewing" | "accepted" | "declined";
export type Proposal = {
  id: string;
  name: string;
  note: string;
  point: LngLat;
  outline: LngLat[] | null;
  context: Record<string, string>;
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
};

export type Platform = "android" | "web";
export type Channel = "staging" | "main";
export type BuildConfig = {
  platform: Platform;
  build: number;
  label: string;
  contentChannel: Channel | null;
  flags: Record<string, boolean>;
  minimumBuild: number | null;
  latestBuild: number | null;
  notes: string;
  updatedAt: string;
};

export type Health = { ok: boolean; environment: string; emailMode: "resend" | "disabled" };

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function fallbackMessage(status: number): string {
  if (status === 401 || status === 403) return "Your Vercel sign-in has expired. Reload the page to sign in again.";
  if (status === 404) return "That item could not be found. It may have been removed.";
  if (status >= 500) return "The dashboard service is temporarily unavailable.";
  return "The request could not be completed.";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let message = fallbackMessage(response.status);
    try {
      const body = await response.json() as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string" && body.error.message.trim()) message = body.error.message.slice(0, 240);
    } catch {
      // Vercel's own sign-in and error pages are HTML; keep the friendly fallback.
    }
    throw new ApiError(response.status, message);
  }
  return await response.json() as T;
}

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
