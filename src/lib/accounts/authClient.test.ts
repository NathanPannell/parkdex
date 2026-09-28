import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  native: true,
  activeToken: "old-token",
  responses: [] as Response[],
  calls: [] as { input: RequestInfo | URL; headers: Headers; tokenAtCall: string }[],
  persist: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => nativeMocks.native } }));
vi.mock("../content/transport", () => ({
  contentFetch: vi.fn(),
  getContentApiOrigin: () => "https://parkdex-kip-staging.vercel.app",
  getContentConnectivity: vi.fn(async () => ({ connected: true, wifi: true })),
  subscribeContentConnectivity: vi.fn(() => () => {}),
}));
vi.mock("./nativeIdentity", () => ({
  nativeAuthFetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    nativeMocks.calls.push({ input, headers: new Headers(init?.headers), tokenAtCall: nativeMocks.activeToken });
    const response = nativeMocks.responses.shift();
    if (!response) throw new Error("Missing mocked response.");
    return response;
  }),
  persistNativeSession: nativeMocks.persist,
}));

import { getCurrentAccount, renewSession } from "./authClient";

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("native auth session renewal", () => {
  beforeEach(() => {
    nativeMocks.activeToken = "old-token";
    nativeMocks.responses = [];
    nativeMocks.calls = [];
    nativeMocks.persist.mockClear();
    nativeMocks.persist.mockImplementation(async (session: { sessionToken: string; expiresAt: number | string }) => {
      nativeMocks.activeToken = session.sessionToken;
    });
  });

  it("persists the rotated token before the next authenticated request", async () => {
    const account = { id: "account-a", email: "a@example.test", emailVerified: true, displayName: "A", providers: ["email"] };
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    nativeMocks.responses.push(
      jsonResponse({ renewed: true, sessionToken: "new-token", expiresAt }),
      jsonResponse({ account }),
    );

    await renewSession(account.id);
    expect(nativeMocks.activeToken).toBe("new-token");
    await getCurrentAccount(account.id);

    expect(nativeMocks.persist).toHaveBeenCalledWith({ sessionToken: "new-token", expiresAt });
    expect(nativeMocks.calls).toHaveLength(2);
    expect(nativeMocks.calls[1].headers.get("X-Kip-Account-ID")).toBe(account.id);
    expect(nativeMocks.calls[1].tokenAtCall).toBe("new-token");
  });

  it("treats a not-due renewal as a no-op and keeps the existing session", async () => {
    nativeMocks.responses.push(jsonResponse({ renewed: false, expiresAt: Date.now() + 20 * 24 * 60 * 60 * 1000 }));

    const result = await renewSession("account-a");

    expect(result.renewed).toBe(false);
    expect(nativeMocks.persist).not.toHaveBeenCalled();
    expect(nativeMocks.activeToken).toBe("old-token");
  });
});
