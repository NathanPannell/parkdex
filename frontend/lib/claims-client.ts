import { ApiError, type VisitClaim } from "./account";

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
};

/** Claims and private photos are account-owned. Guest collection keys are never sent here. */
export type ClaimOwner = { kind: "account"; token: string };

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

export async function recommendClaimRequest(
  apiBaseUrl: string,
  owner: ClaimOwner,
  input: ClaimRecommendationInput,
): Promise<ClaimRecommendation> {
  return parseResponse(await fetch(`${apiBaseUrl}/api/claim-recommendations`, {
    method: "POST",
    headers: { ...ownerHeaders(owner), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }), "Could not check your location right now.");
}

export async function createClaimRequest(
  apiBaseUrl: string,
  owner: ClaimOwner,
  input: { recommendationToken: string; expectedPlaceId: string },
): Promise<ClaimConfirmation> {
  return parseResponse(await fetch(`${apiBaseUrl}/api/claims`, {
    method: "POST",
    headers: { ...ownerHeaders(owner), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }), "Could not claim this park right now.");
}

export async function uploadVisitPhotoRequest(apiBaseUrl: string, owner: ClaimOwner, placeId: string, file: File): Promise<void> {
  const body = new FormData();
  body.append("photo", file);
  await parseResponse<void>(await fetch(`${apiBaseUrl}/api/visits/${encodeURIComponent(placeId)}/photo`, {
    method: "PUT",
    headers: ownerHeaders(owner),
    body,
  }), "Could not upload this visit photo.");
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
