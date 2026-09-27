import { Capacitor } from "@capacitor/core";
import { PARK_BY_ID } from "./parks";
import type { FeedbackOrigin, Screen } from "./store";

export type FeedbackKind = "bug" | "idea" | "general";

export const FEEDBACK_KINDS: { id: FeedbackKind; label: string; icon: "bug" | "bulb" | "chat"; prompt: string }[] = [
  { id: "bug", label: "Bug", icon: "bug", prompt: "What happened, and what did you expect?" },
  { id: "idea", label: "Feature idea", icon: "bulb", prompt: "What would make Parkdex better for you?" },
  { id: "general", label: "General", icon: "chat", prompt: "Tell us anything: what you liked, what felt off." },
];

export type FeedbackDraft = { kind: FeedbackKind; message: string; contact: boolean; email: string };

export type FeedbackContext = { version: string; platform: string; screen: string; parkId: string | null; parkName: string | null };

export type FeedbackReport = FeedbackDraft & { screenshot: string | null; context: FeedbackContext };

const SCREEN_LABEL: Record<Screen, string> = {
  splash: "Splash",
  onboarding: "Onboarding",
  map: "Map",
  collection: "My case",
  camera: "Camera",
  claim: "Claim",
  share: "Share",
};

// Only coarse app state: precise location, photos and logs are never collected automatically.
export function feedbackContext(origin: FeedbackOrigin): FeedbackContext {
  const park = origin.parkId ? PARK_BY_ID.get(origin.parkId) : undefined;
  return {
    version: __APP_VERSION__,
    platform: Capacitor.getPlatform(),
    screen: SCREEN_LABEL[origin.screen],
    parkId: park?.id ?? null,
    parkName: park?.name ?? null,
  };
}

const DRAFT_KEY = "parkdex-feedback-draft";
export const EMPTY_DRAFT: FeedbackDraft = { kind: "bug", message: "", contact: false, email: "" };

// The text draft survives closing the sheet or a failed send; the screenshot stays in memory
// because data URLs can exceed localStorage limits.
export function loadDraft(): FeedbackDraft {
  try {
    return { ...EMPTY_DRAFT, ...JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function saveDraft(draft: FeedbackDraft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Private modes may block storage; the draft still lives in the open sheet.
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

let failNext = false;

// Demo control so testers can see the failure and retry path without a backend.
export function setFeedbackFailure(value: boolean) {
  failNext = value;
}

export function feedbackFailureOn() {
  return failNext;
}

// Placeholder until the backend lands: resolves after a short delay, or rejects when the
// device is offline or the demo failure switch is on.
export async function submitFeedback(_report: FeedbackReport): Promise<{ id: string }> {
  await new Promise((r) => setTimeout(r, 1100));
  if (failNext || !navigator.onLine) throw new Error("Could not reach Parkdex");
  return { id: `FB-${Date.now().toString(36).toUpperCase().slice(-5)}` };
}
