import { afterEach, describe, expect, it, vi } from "vitest";
import { completeGoogleAuthorization, confirmPasswordReset, requestPasswordReset } from "./account";

const API = "https://api.example.test";

afterEach(() => vi.unstubAllGlobals());

describe("account security requests", () => {
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

});
