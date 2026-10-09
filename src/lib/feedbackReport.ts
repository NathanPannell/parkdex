import { Capacitor } from "@capacitor/core";
import type { Park } from "./parks";
import type { FeedbackOrigin, Screen } from "./store";
import { createFeedbackDraftGeneration, getFeedbackSubmissionAttempt } from "./feedbackDraft";
import { resolveUserDataApiOrigin } from "./userDataDestination";
import { apiEnvironment, apiUrl } from "./apiPointer";
import { requestContextHeaders } from "./requestContext";

export type FeedbackKind = "bug" | "idea" | "general";

export const FEEDBACK_KINDS: { id: FeedbackKind; label: string; icon: "bug" | "bulb" | "chat"; prompt: string }[] = [
  { id: "bug", label: "Bug", icon: "bug", prompt: "What happened, and what did you expect?" },
  { id: "idea", label: "Feature idea", icon: "bulb", prompt: "What would make Parkdex better for you?" },
  { id: "general", label: "General", icon: "chat", prompt: "Tell us anything: what you liked, what felt off." },
];

export type FeedbackDraft = { kind: FeedbackKind; message: string; contact: boolean; email: string };
export type FeedbackDraftSession = { draft: FeedbackDraft; generation: string };

export type FeedbackContext = {
  version: string;
  build: string;
  platform: string;
  screen: string;
  parkId: string | null;
  parkName: string | null;
};

export type FeedbackAppVersion = Pick<FeedbackContext, "version" | "build">;

export type FeedbackReport = FeedbackDraft & { screenshot: string | null; context: FeedbackContext };

export type FeedbackNotificationState = "sent" | "pending" | "sending" | "ambiguous" | "failed" | "disabled";
export type FeedbackSubmitResult = {
  id: string;
  notification?: {
    operator?: FeedbackNotificationState;
    receipt?: FeedbackNotificationState;
  };
};

const SCREEN_LABEL: Record<Screen, string> = {
  splash: "Splash",
  onboarding: "Onboarding",
  map: "Map",
  collection: "Badge collection",
  camera: "Camera",
  claim: "Claim",
  share: "Share",
  account: "Account & backup",
  settings: "Settings",
  downloads: "Manage downloads",
  plant: "Plant flag",
  parks: "Your parks",
  leaderboard: "Leaderboard",
};

// Only coarse app state: precise location, photos and logs are never collected automatically.
export function feedbackContext(origin: FeedbackOrigin, park?: Park, appVersion?: FeedbackAppVersion): FeedbackContext {
  return {
    version: appVersion?.version ?? __APP_VERSION__,
    build: appVersion?.build ?? __APP_BUILD__,
    platform: Capacitor.getPlatform(),
    screen: SCREEN_LABEL[origin.screen],
    parkId: park?.id ?? null,
    parkName: park?.name ?? null,
  };
}

const DRAFT_KEY = "parkdex-feedback-draft";
const DRAFT_GENERATION_KEY = "parkdex-feedback-generation";
export const EMPTY_DRAFT: FeedbackDraft = { kind: "bug", message: "", contact: false, email: "" };

// The text draft stays in localStorage. Attachments and retry identity use IndexedDB.
export function loadDraftSession(): FeedbackDraftSession {
  try {
    const generationKey = localStorage.getItem(DRAFT_GENERATION_KEY);
    const stored = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as Record<string, unknown> | null;
    if (stored && stored.draft && typeof stored.draft === "object" && typeof stored.generation === "string") {
      if (generationKey && generationKey !== stored.generation) return { draft: EMPTY_DRAFT, generation: generationKey };
      localStorage.setItem(DRAFT_GENERATION_KEY, stored.generation);
      return { draft: { ...EMPTY_DRAFT, ...(stored.draft as Partial<FeedbackDraft>) }, generation: stored.generation };
    }

    const generation = generationKey ?? createFeedbackDraftGeneration();
    localStorage.setItem(DRAFT_GENERATION_KEY, generation);
    if (stored && typeof stored === "object" && "kind" in stored) {
      return { draft: { ...EMPTY_DRAFT, ...(stored as Partial<FeedbackDraft>) }, generation };
    }
    return { draft: EMPTY_DRAFT, generation };
  } catch {
    return { draft: EMPTY_DRAFT, generation: createFeedbackDraftGeneration() };
  }
}

export function saveDraft(draft: FeedbackDraft, generation: string): boolean {
  try {
    localStorage.setItem(DRAFT_GENERATION_KEY, generation);
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ draft, generation }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(nextGeneration: string) {
  try {
    // Advance first. A failed removal leaves an old envelope that loadDraftSession ignores.
    localStorage.setItem(DRAFT_GENERATION_KEY, nextGeneration);
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The API origin for feedback and other anonymous reports from this build. */
export function feedbackApiOrigin(): string {
  const native = Capacitor.isNativePlatform();
  const configured = apiUrl(import.meta.env.VITE_FEEDBACK_API_URL);
  const previewOrigin = import.meta.env.VITE_PREVIEW_API_ORIGIN;
  if (native && !configured?.trim() && !(import.meta.env.VITE_CONTENT_ENV === "preview" && previewOrigin?.trim())) {
    throw new Error("Feedback is unavailable in this app build because its feedback service URL is not configured.");
  }
  return resolveUserDataApiOrigin(configured || previewOrigin, {
    native,
    webOrigin: typeof location === "undefined" ? undefined : location.origin,
    allowLoopbackHttp: import.meta.env.DEV,
    environment: apiEnvironment(),
    previewOrigin,
  });
}

async function responseError(response: Response): Promise<Error> {
  if (response.status === 413) return new Error("The feedback service rejected the screenshot as too large. Remove it and try again.");
  if (response.status === 429) return new Error("The feedback service is busy. Your draft is saved on this phone. Try again shortly.");
  if (response.status >= 500) return new Error("The feedback service is temporarily unavailable. Your draft is saved on this phone. Try again shortly.");
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : null;
    if (message && message.length <= 240) return new Error(message);
  } catch {
    // Use the status-specific recovery copy below when there is no JSON error body.
  }
  if (response.status === 400 || response.status === 422) return new Error("Check the report details and try again.");
  return new Error(`The feedback service couldn't save this report (HTTP ${response.status}). Your draft is saved on this phone.`);
}

function isNotificationState(value: unknown): value is FeedbackNotificationState {
  return value === "sent" || value === "pending" || value === "sending" || value === "ambiguous" || value === "failed" || value === "disabled";
}

function parseSavedResult(value: unknown): FeedbackSubmitResult | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.id !== "string" || !body.id.trim()) return null;

  const notificationValue = body.notification;
  if (!notificationValue || typeof notificationValue !== "object") return { id: body.id };
  const notification = notificationValue as Record<string, unknown>;
  return {
    id: body.id,
    notification: {
      ...(isNotificationState(notification.operator) ? { operator: notification.operator } : {}),
      ...(isNotificationState(notification.receipt) ? { receipt: notification.receipt } : {}),
    },
  };
}

// POSTs the exact saved draft. A stable ID makes retries idempotent after a lost response.
export async function submitFeedback(report: FeedbackReport, generation: string): Promise<FeedbackSubmitResult> {
  let baseUrl: string;
  try {
    baseUrl = feedbackApiOrigin();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Feedback is unavailable")) throw error;
    throw new Error("Feedback is unavailable because this app build has an invalid service destination.");
  }

  let attempt: Awaited<ReturnType<typeof getFeedbackSubmissionAttempt>>;
  try {
    attempt = await getFeedbackSubmissionAttempt(report, generation);
  } catch {
    throw new Error("Couldn't prepare a safe retry for this report. Check this device's storage and try again.");
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 40_000);
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...requestContextHeaders() },
        body: JSON.stringify({ ...attempt.report, submissionId: attempt.id }),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new Error("The feedback request timed out. Your draft is saved on this phone. Try again; the retry uses the same submission ID.");
      }
      if (!navigator.onLine) throw new Error("No connection. Your draft is saved on this phone. Reconnect and try again.");
      throw new Error("Couldn't reach the feedback service. Your draft is saved on this phone. Check your connection and try again.");
    }

    if (!response.ok) {
      const error = await responseError(response);
      if (controller.signal.aborted) {
        throw new Error("The feedback request timed out. Your draft is saved on this phone. Try again; the retry uses the same submission ID.");
      }
      throw error;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new Error("The feedback request timed out. Your draft is saved on this phone. Try again; the retry uses the same submission ID.");
      }
      throw new Error("The service response couldn't confirm that your report was saved. Your draft is saved on this phone. Try again.");
    }
    const saved = parseSavedResult(body);
    if (!saved) throw new Error("The service response couldn't confirm that your report was saved. Your draft is saved on this phone. Try again.");
    return saved;
  } finally {
    window.clearTimeout(timeout);
  }
}
