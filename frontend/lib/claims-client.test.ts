import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClaimRequest,
  loadVisitPhotoRequest,
  recommendClaimRequest,
  removeVisitPhotoRequest,
  uploadVisitPhotoRequest,
} from "./claims-client";

const API = "https://api.example.test";
const guest = { kind: "guest" as const, collectionKey: "guest-owner" };
const account = { kind: "account" as const, token: "account-owner" };

afterEach(() => vi.unstubAllGlobals());

describe("claims client", () => {
  it("sends native location samples for a guest owner", async () => {
    const response = { status: "recommended", recommendationToken: "signed", expiresAt: "2026-09-09T00:01:00Z", candidate: { placeId: "park", matchKind: "exact", distanceMeters: 0 } };
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    const location = { latitude: 49, longitude: -125, accuracyMeters: 8, capturedAtEpochMs: 1_789_000_000_000 };

    await expect(recommendClaimRequest(API, guest, { location })).resolves.toEqual(response);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/api/claim-recommendations`);
    expect(new Headers(init.headers).get("X-Collection-Key")).toBe("guest-owner");
    expect(JSON.parse(String(init.body))).toEqual({ location });
  });

  it("creates claims with bearer identity and the expected candidate", async () => {
    const response = { placeId: "park", visited: true, visitedCount: 1, visitedAt: "2026-09-09T00:00:00Z", claim: { claimedAt: "2026-09-09T00:00:00Z", capturedAt: "2026-09-09T00:00:00Z", coordinates: { latitude: 49, longitude: -125 }, accuracyMeters: 8, boundaryVersion: "v1", matchKind: "exact", distanceMeters: 0, hasPhoto: false } };
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createClaimRequest(API, account, { recommendationToken: "signed", expectedPlaceId: "park" })).resolves.toEqual(response);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer account-owner");
    expect(JSON.parse(String(init.body))).toEqual({ recommendationToken: "signed", expectedPlaceId: "park" });
  });

  it("keeps private photo bytes behind owner-authenticated requests", async () => {
    const photo = new File(["photo"], "visit.jpg", { type: "image/jpeg" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(photo, { headers: { "Content-Type": "image/jpeg" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadVisitPhotoRequest(API, guest, "park/id", photo);
    const upload = fetchMock.mock.calls[0][1] as RequestInit;
    expect(upload.method).toBe("PUT");
    expect(upload.body).toBeInstanceOf(FormData);
    expect(new Headers(upload.headers).get("X-Collection-Key")).toBe("guest-owner");
    await expect(loadVisitPhotoRequest(API, guest, "park/id")).resolves.toBeInstanceOf(Blob);
    await removeVisitPhotoRequest(API, guest, "park/id");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(Array(3).fill(`${API}/api/visits/park%2Fid/photo`));
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
  });
});
