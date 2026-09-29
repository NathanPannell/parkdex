import { ApiError, type VisitClaim } from "./account";
import type { BoundaryFeature } from "./boundaries";
import type { Place } from "./places";

/** A fresh location sample sent to the server for a boundary recommendation. */
export type ClaimLocation = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAtEpochMs: number;
};

export type ClaimRecommendationInput = { location: ClaimLocation };

export type ClaimCandidate = {
  placeId: string;
  matchKind: "exact" | "buffer";
  distanceMeters: number;
};

export type ClaimRecommendation =
  | { status: "none" }
  | { status: "recommended"; recommendationToken: string; expiresAt: string; candidate: ClaimCandidate };

export type ClaimConfirmation = {
  placeId: string;
  visited: true;
  visitedCount: number;
  visitedAt: string;
  claim: VisitClaim;
  /** True only for a client-side offline claim that the server has not acknowledged. */
  pendingSync?: boolean;
};

export type OfflineClaimGrant = {
  grantToken: string;
  issuedAt: string;
  expiresAt: string;
  boundaryVersion: string | number;
};

export type OfflinePlaceBundle = {
  place: Place;
  boundary: BoundaryFeature | null;
  boundaryVersion: string | number | null;
};

/** Claims and private photos are account-owned. Guest collection keys are never sent here. */
export type ClaimOwner = { kind: "account"; token: string };

export const PHOTO_UPLOAD_TIMEOUT_MS = 30_000;
export const CLAIM_REQUEST_TIMEOUT_MS = 15_000;
export const CLAIM_RECOMMENDATION_TIMEOUT_MS = 8_000;

export class ClaimRequestTimeoutError extends TypeError {
  readonly code = "claim_request_timeout";

  constructor() {
    super("The visit service took too long to respond. Check your connection and try again.");
    this.name = "ClaimRequestTimeoutError";
  }
}

export class PhotoUploadTimeoutError extends Error {
  readonly code = "photo_upload_timeout";

  constructor(readonly timeoutMs: number) {
    super(`Photo upload paused after ${Math.round(timeoutMs / 1_000)} seconds.`);
    this.name = "PhotoUploadTimeoutError";
  }
}

function ownerHeaders(owner: ClaimOwner): Record<string, string> {
  return { Authorization: `Bearer ${owner.token}` };
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("Content-Type") ?? "";
    return (contentType.includes("json") ? response.json() : response.blob()) as Promise<T>;
  }

  let message = fallback;
  let code: string | undefined;
  try {
    const payload = await response.json() as {
      code?: string;
      detail?: string | { code?: string; message?: string };
    };
    code = payload.code ?? (typeof payload.detail === "object" ? payload.detail.code : undefined);
    message = typeof payload.detail === "string" ? payload.detail : payload.detail?.message ?? fallback;
    if (!code && message === "location_claim_required") code = message;
  } catch {
    // Keep the operation-specific fallback for non-JSON responses.
  }
  throw new ApiError(message, response.status, code);
}

/** Bound the entire response, including its body, so a stalled connection cannot hold a queue lane forever. */
async function claimRequest<T>(url: string, init: RequestInit, fallback: string, timeoutMs = CLAIM_REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  let rejectAborted: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const cancel = () => {
    controller.abort();
    rejectAborted(new DOMException("The visit request was canceled.", "AbortError"));
  };
  if (externalSignal?.aborted) cancel();
  else externalSignal?.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(() => {
    rejectAborted(new ClaimRequestTimeoutError());
    controller.abort();
  }, timeoutMs);
  try {
    const request = controller.signal.aborted
      ? aborted
      : fetch(url, { ...init, signal: controller.signal }).then((response) => parseResponse<T>(response, fallback));
    return await Promise.race([request, aborted]);
  } finally {
    clearTimeout(deadline);
    externalSignal?.removeEventListener("abort", cancel);
  }
}

export async function recommendClaimRequest(
  apiBaseUrl: string,
  owner: ClaimOwner,
  input: ClaimRecommendationInput,
): Promise<ClaimRecommendation> {
  return claimRequest(`${apiBaseUrl}/api/claim-recommendations`, {
    method: "POST",
    headers: { ...ownerHeaders(owner), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, "Could not check your location right now.", CLAIM_RECOMMENDATION_TIMEOUT_MS);
}

export async function createClaimRequest(
  apiBaseUrl: string,
  owner: ClaimOwner,
  input: { recommendationToken: string; expectedPlaceId: string },
): Promise<ClaimConfirmation> {
  return claimRequest(`${apiBaseUrl}/api/claims`, {
    method: "POST",
    headers: { ...ownerHeaders(owner), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, "Could not save this visit right now.");
}

/** A grant is account-bound by the API and stored separately from queued claims. */
export async function issueOfflineClaimGrantRequest(apiBaseUrl: string, owner: ClaimOwner, signal?: AbortSignal): Promise<OfflineClaimGrant> {
  return claimRequest(`${apiBaseUrl}/api/offline-claim-grants`, {
    method: "POST",
    headers: ownerHeaders(owner),
    signal,
  }, "Could not prepare offline visit saving.");
}

/** Public catalogue bundles contain only the canonical boundary used for claims. */
export async function loadOfflinePlaceBundleRequest(apiBaseUrl: string, placeId: string): Promise<OfflinePlaceBundle> {
  return claimRequest(`${apiBaseUrl}/api/places/${encodeURIComponent(placeId)}/offline-bundle`, {
    cache: "no-store",
  }, "Could not load this place's offline boundary.");
}

export async function createOfflineClaimRequest(
  apiBaseUrl: string,
  owner: ClaimOwner,
  input: { requestId: string; grantToken: string; expectedPlaceId: string; location: ClaimLocation },
  signal?: AbortSignal,
): Promise<ClaimConfirmation> {
  return claimRequest(`${apiBaseUrl}/api/offline-claims`, {
    method: "POST",
    headers: { ...ownerHeaders(owner), "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  }, "Could not sync this offline visit.");
}

export async function uploadVisitPhotoRequest(apiBaseUrl: string, owner: ClaimOwner, placeId: string, file: File, timeoutMs = PHOTO_UPLOAD_TIMEOUT_MS): Promise<void> {
  const body = new FormData();
  body.append("photo", file);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await parseResponse<void>(await fetch(`${apiBaseUrl}/api/visits/${encodeURIComponent(placeId)}/photo`, {
      method: "PUT",
      headers: ownerHeaders(owner),
      body,
      signal: controller.signal,
    }), "Could not upload this visit photo.");
  } catch (error) {
    if (controller.signal.aborted) throw new PhotoUploadTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadVisitPhotoRequest(apiBaseUrl: string, owner: ClaimOwner, placeId: string): Promise<Blob> {
  return parseResponse(await fetch(`${apiBaseUrl}/api/visits/${encodeURIComponent(placeId)}/photo`, {
    headers: ownerHeaders(owner),
    cache: "no-store",
  }), "Could not load this visit photo.");
}

export async function removeVisitPhotoRequest(apiBaseUrl: string, owner: ClaimOwner, placeId: string): Promise<void> {
  await parseResponse<void>(await fetch(`${apiBaseUrl}/api/visits/${encodeURIComponent(placeId)}/photo`, {
    method: "DELETE",
    headers: ownerHeaders(owner),
  }), "Could not remove this visit photo.");
}
