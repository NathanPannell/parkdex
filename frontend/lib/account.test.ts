import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, authenticate, completeGoogleAuthorization, confirmPasswordReset, deleteAccount, requestPasswordReset } from "./account";

const API = "https://api.example.test";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("account security requests", () => {
  it("turns transport failures into recovery guidance while preserving API validation", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(authenticate(API, "login", "ranger@example.test", "invalid")).rejects.toThrow("You are offline. Reconnect to log in.");
    vi.stubGlobal("navigator", { onLine: true });
    await expect(authenticate(API, "login", "ranger@example.test", "invalid")).rejects.toThrow("Check your connection and try again.");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Email or password is incorrect." }), { status: 401 })));
    await expect(authenticate(API, "login", "ranger@example.test", "invalid")).rejects.toBeInstanceOf(ApiError);
  });

  it("keeps password reset requests enumeration-safe and accepts no-content responses", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(null, { status: 202 })));
    vi.stubGlobal("fetch", fetchMock);
    await requestPasswordReset(API, "ranger@example.test");
    expect(fetchMock).toHaveBeenCalledWith(`${API}/api/auth/password-reset/request`, expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ email: "ranger@example.test" });
  });

  it("sends reset tokens only in the confirmation body", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);
    await confirmPasswordReset(API, "single-use-token", "a sufficiently long password");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("single-use-token");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ token: "single-use-token" });
  });

  it("carries PKCE data through Google callback", async () => {
    const session = { token: "session", expiresAt: "2026-09-09T00:00:00Z", account: { id: "1", email: "ranger@example.test", emailVerified: true }, visitedIds: [], visits: [], completedTrailIds: [] };
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify(session), { status: 200, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await completeGoogleAuthorization(API, "code", "state", "verifier")).toEqual(session);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ code: "code", state: "state", codeVerifier: "verifier" });
  });

  it("sends an explicit, replayable account deletion request", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify({ deleted: true, photoCleanupPending: true }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteAccount(API, "account-token", "request-id")).resolves.toEqual({ deleted: true, photoCleanupPending: true });
    expect(fetchMock).toHaveBeenCalledWith(`${API}/api/account`, expect.objectContaining({ method: "DELETE" }));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer account-token");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ confirm: "DELETE_ACCOUNT", requestId: "request-id" });
  });

  it("does not interpret an unauthorized response as a deletion", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ detail: "Not authorized." }), { status: 401 }))));
    await expect(deleteAccount(API, "stale-token", "request-id")).rejects.toMatchObject({ status: 401 });
  });

  it("requires the server deletion receipt to say deleted", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ deleted: false, photoCleanupPending: false }), { status: 200 }))));
    await expect(deleteAccount(API, "account-token", "request-id")).rejects.toThrow("did not confirm account deletion");
  });

  it("bounds a hung deletion request without losing its retry id", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const pending = deleteAccount(API, "account-token", "stable-request-id");
    const outcome = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
  });

});
