import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClaimRequest,
  createOfflineClaimRequest,
  issueOfflineClaimGrantRequest,
  loadOfflinePlaceBundleRequest,
  loadVisitPhotoRequest,
  recommendClaimRequest,
  removeVisitPhotoRequest,
  uploadVisitPhotoRequest,
  PhotoUploadTimeoutError,
  ClaimRequestTimeoutError,
  CLAIM_REQUEST_TIMEOUT_MS,
  CLAIM_RECOMMENDATION_TIMEOUT_MS,
} from "./claims-client";

const API = "https://api.example.test";
const account = { kind: "account" as const, token: "account-owner" };

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("claims client", () => {
  it("bounds a stalled recommendation before the captured fix becomes stale", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const pending = recommendClaimRequest(API, account, { location: { latitude: 49, longitude: -125, accuracyMeters: 5, capturedAtEpochMs: Date.now() } });
    const failure = expect(pending).rejects.toBeInstanceOf(ClaimRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(CLAIM_RECOMMENDATION_TIMEOUT_MS);
    await failure;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(CLAIM_RECOMMENDATION_TIMEOUT_MS).toBeLessThan(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled response bodies as well as stalled connections", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "Content-Type": "application/json" }), json: () => new Promise(() => undefined) }));
    const failure = expect(issueOfflineClaimGrantRequest(API, account)).rejects.toBeInstanceOf(ClaimRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(CLAIM_REQUEST_TIMEOUT_MS);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a queue request immediately when its owner cancels it", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const ownerCancellation = new AbortController();
    const failure = expect(issueOfflineClaimGrantRequest(API, account, ownerCancellation.signal)).rejects.toMatchObject({ name: "AbortError" });
    ownerCancellation.abort();
    await failure;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("issues an account-bound offline claim grant without sending a client key", async () => {
    const grant = { grantToken: "grant-secret", issuedAt: "2026-09-09T00:00:00Z", expiresAt: "2026-09-10T00:00:00Z", boundaryVersion: "boundary-17" };
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify(grant), { headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(issueOfflineClaimGrantRequest(API, account)).resolves.toEqual(grant);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/api/offline-claim-grants`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer account-owner");
    expect(init.body).toBeUndefined();
  });

  it("loads a public canonical offline bundle without account credentials", async () => {
    const bundle = { place: { id: "park/id", name: "Park", category: "regional", latitude: 49, longitude: -125, region: "Coast", description: "", sourceUrl: "", sourceName: "" }, boundary: null, boundaryVersion: "boundary-17" };
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify(bundle), { headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadOfflinePlaceBundleRequest(API, "park/id")).resolves.toEqual(bundle);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/api/places/park%2Fid/offline-bundle`);
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
  });

  it("creates a queued claim with its stable request ID, grant, location, and account bearer", async () => {
    const response = { placeId: "park", visited: true, visitedCount: 2, visitedAt: "2026-09-09T00:00:00Z", claim: { claimedAt: "2026-09-09T00:00:00Z", capturedAt: "2026-09-08T23:59:55Z", coordinates: { latitude: 49, longitude: -125 }, accuracyMeters: 8, boundaryVersion: "boundary-17", matchKind: "exact", distanceMeters: 0, hasPhoto: false } };
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    const location = { latitude: 49, longitude: -125, accuracyMeters: 8, capturedAtEpochMs: Date.parse("2026-09-08T23:59:55Z") };

    await expect(createOfflineClaimRequest(API, account, { requestId: "request-uuid", grantToken: "grant-secret", expectedPlaceId: "park", location })).resolves.toEqual(response);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/api/offline-claims`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer account-owner");
    expect(JSON.parse(String(init.body))).toEqual({ requestId: "request-uuid", grantToken: "grant-secret", expectedPlaceId: "park", location });
  });

  it("sends a fresh location sample with account authentication", async () => {
    const response = { status: "recommended", recommendationToken: "signed", expiresAt: "2026-09-09T00:01:00Z", candidate: { placeId: "park", matchKind: "exact", distanceMeters: 0 } };
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    const location = { latitude: 49, longitude: -125, accuracyMeters: 8, capturedAtEpochMs: 1_789_000_000_000 };

    await expect(recommendClaimRequest(API, account, { location })).resolves.toEqual(response);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/api/claim-recommendations`);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer account-owner");
    expect(new Headers(init.headers).get("X-Collection-Key")).toBeNull();
    expect(JSON.parse(String(init.body))).toEqual({ location });
  });

  it("creates claims with the expected candidate and bearer identity", async () => {
    const response = { placeId: "park", visited: true, visitedCount: 1, visitedAt: "2026-09-09T00:00:00Z", claim: { claimedAt: "2026-09-09T00:00:00Z", capturedAt: "2026-09-09T00:00:00Z", coordinates: { latitude: 49, longitude: -125 }, accuracyMeters: 8, boundaryVersion: "v1", matchKind: "exact", distanceMeters: 0, hasPhoto: false } };
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createClaimRequest(API, account, { recommendationToken: "signed", expectedPlaceId: "park" })).resolves.toEqual(response);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer account-owner");
    expect(JSON.parse(String(init.body))).toEqual({ recommendationToken: "signed", expectedPlaceId: "park" });
  });

  it("keeps private photo bytes behind authenticated upload/read/delete requests", async () => {
    const photo = new File(["photo"], "visit.jpg", { type: "image/jpeg" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(photo, { headers: { "Content-Type": "image/jpeg" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadVisitPhotoRequest(API, account, "park/id", photo);
    const upload = fetchMock.mock.calls[0][1] as RequestInit;
    expect(upload.method).toBe("PUT");
    expect(upload.body).toBeInstanceOf(FormData);
    expect(new Headers(upload.headers).get("Authorization")).toBe("Bearer account-owner");
    await expect(loadVisitPhotoRequest(API, account, "park/id")).resolves.toBeInstanceOf(Blob);
    await removeVisitPhotoRequest(API, account, "park/id");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(Array(3).fill(`${API}/api/visits/park%2Fid/photo`));
    expect((fetchMock.mock.calls[1][1] as RequestInit).cache).toBe("no-store");
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
  });

  it("surfaces structured API error codes for claim recovery copy", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify({ detail: { code: "claim_recommendation_expired", message: "Recommendation expired" } }), { status: 409, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createClaimRequest(API, account, { recommendationToken: "signed", expectedPlaceId: "park" })).rejects.toMatchObject({ status: 409, code: "claim_recommendation_expired", message: "Recommendation expired" });
  });

  it("aborts a stalled photo upload at the bounded deadline with a safe typed error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = uploadVisitPhotoRequest(API, account, "park", new File(["photo"], "visit.jpg", { type: "image/jpeg" }), 30_000);
    const rejection = expect(pending).rejects.toBeInstanceOf(PhotoUploadTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
