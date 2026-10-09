import type { FeedbackStore } from "./store.js";
import type { EmailAudience } from "./validation.js";

/**
 * Email delivery for saved feedback. Shared by the public submit route and the separately
 * deployed operator dashboard, which retries deliveries against the same rows.
 */

export interface DeliveryEnvironment {
  RESEND_API_KEY?: string;
  EMAIL_MODE?: "resend" | "disabled" | string;
}

export interface DeliveryDependencies {
  fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  now?(): number;
  uuid?(): string;
}

export type DeliveryResult = { audience: EmailAudience; status: string; error?: string };

const RESEND_URL = "https://api.resend.com/emails";
const RESPONSE_TIMEOUT_MS = 8_000;

async function readProviderMessageId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("id" in body)) return null;
    const id = (body as { id?: unknown }).id;
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function markEmailFailure(
  store: FeedbackStore,
  reportId: string,
  audience: EmailAudience,
  leaseToken: string,
  state: "failed" | "ambiguous",
  message: string,
): Promise<boolean> {
  try {
    await store.finishEmail(reportId, audience, leaseToken, state, message);
    return true;
  } catch {
    // A still-leased row is recovered safely by the next explicit retry.
    return false;
  }
}

export async function sendEmail(
  store: FeedbackStore,
  env: DeliveryEnvironment,
  dependencies: DeliveryDependencies,
  reportId: string,
  audience: EmailAudience,
  confirmAmbiguousAfter24h: boolean,
  onlyIfPending = false,
): Promise<DeliveryResult> {
  const before = await store.getEmailDelivery(reportId, audience);
  if (!before) return { audience, status: "skipped" };
  if (before.status === "sent" || before.status === "disabled") return { audience, status: "skipped" };
  if (onlyIfPending && before.status !== "pending") return { audience, status: "skipped" };
  if (env.EMAIL_MODE === "disabled") {
    await store.markEmailDisabled(reportId, audience);
    return { audience, status: "disabled" };
  }
  if (before.lastError === "Email template could not be rendered.") {
    return { audience, status: "failed", error: "Email template could not be rendered; this saved message cannot be retried." };
  }

  const leaseToken = dependencies.uuid?.() ?? crypto.randomUUID();
  const claim = await store.claimEmail(reportId, audience, leaseToken, confirmAmbiguousAfter24h);
  if (claim.status !== "claimed") {
    const now = dependencies.now?.() ?? Date.now();
    if (claim.status === "ambiguous" && before.lastAttemptAt && now - Date.parse(before.lastAttemptAt) >= 24 * 60 * 60 * 1000 && !confirmAmbiguousAfter24h) {
      return { audience, status: "requires_confirmation", error: "Provider outcome is unknown; confirm before retrying after 24 hours." };
    }
    return { audience, status: "skipped" };
  }
  const email = claim.email;
  if (!env.RESEND_API_KEY) {
    const persisted = await markEmailFailure(store, reportId, audience, leaseToken, "failed", "Email provider is not configured.");
    return { audience, status: persisted ? "failed" : "ambiguous", error: "Email provider is not configured." };
  }
  if (!email.recipient || !email.payload.from || email.payload.to.length === 0) {
    const persisted = await markEmailFailure(store, reportId, audience, leaseToken, "failed", "Email recipient or sender is not configured.");
    return { audience, status: persisted ? "failed" : "ambiguous", error: "Email recipient or sender is not configured." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);
  try {
    const response = await (dependencies.fetch ?? fetch)(RESEND_URL, {
      method: "POST",
      // The operator dashboard sends retries from the Vercel Edge runtime, which rejects
      // redirect: "error". A redirect comes back as a 3xx response and is recorded as a refusal.
      redirect: "manual",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": email.idempotencyKey,
      },
      body: JSON.stringify(email.payload),
      signal: controller.signal,
    });
    if (response.ok) {
      const providerMessageId = await readProviderMessageId(response);
      try {
        await store.finishEmail(reportId, audience, leaseToken, "sent", null, providerMessageId);
        return { audience, status: "sent" };
      } catch {
        return { audience, status: "ambiguous", error: "Provider accepted the message, but its saved status is pending recovery." };
      }
    }
    const ambiguous = response.status === 408 || response.status === 409 || response.status >= 500;
    const message = ambiguous
      ? `Email provider returned HTTP ${response.status}; delivery outcome is uncertain.`
      : `Email provider rejected the message (HTTP ${response.status}).`;
    const persisted = await markEmailFailure(store, reportId, audience, leaseToken, ambiguous ? "ambiguous" : "failed", message);
    return { audience, status: ambiguous || !persisted ? "ambiguous" : "failed", error: message };
  } catch {
    const message = "Email delivery outcome is uncertain after a network failure.";
    await markEmailFailure(store, reportId, audience, leaseToken, "ambiguous", message);
    return { audience, status: "ambiguous", error: message };
  } finally {
    clearTimeout(timeout);
  }
}
