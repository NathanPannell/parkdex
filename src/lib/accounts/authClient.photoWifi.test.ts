import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: true,
  contentOrigin: "https://parkdex-kip-staging.vercel.app" as string | null,
  connectivity: { connected: true, wifi: true },
  getConnectivity: vi.fn(async () => mocks.connectivity),
  connectivityHandler: null as ((connectivity: { connected: boolean; wifi: boolean }) => void) | null,
  removeConnectivityListener: vi.fn(),
  subscribeConnectivity: vi.fn((listener: (connectivity: { connected: boolean; wifi: boolean }) => void) => {
    mocks.connectivityHandler = listener;
    listener(mocks.connectivity);
    return mocks.removeConnectivityListener;
  }),
  contentFetch: vi.fn(async () => new Response("public content")),
  nativeCalls: [] as Array<{ input: RequestInfo | URL; init?: RequestInit; fetcher?: typeof fetch }>,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native, getPlatform: () => "android" },
  registerPlugin: () => ({ accountRequest: vi.fn(), abort: vi.fn() }),
}));
vi.mock("../content/transport", () => ({
  contentFetch: mocks.contentFetch,
  getContentApiOrigin: () => mocks.contentOrigin,
  getContentConnectivity: mocks.getConnectivity,
  subscribeContentConnectivity: mocks.subscribeConnectivity,
  nativeAccountBackupRequest: vi.fn(),
  abortNativeAccountBackupRequest: vi.fn(),
}));
vi.mock("./nativeIdentity", () => ({
  isApprovedKipOrigin: () => true,
  KIP_STAGING_ORIGIN: "https://staging.web.parkdex.app",
  nativeAuthFetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit, fetcher?: typeof fetch) => {
    mocks.nativeCalls.push({ input, init, fetcher });
    return new Response("native response");
  }),
  persistNativeSession: vi.fn(),
}));

const CLAIM_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const API_ORIGIN = "https://parkdex-kip-staging.vercel.app";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  mocks.native = true;
  mocks.contentOrigin = API_ORIGIN;
  mocks.connectivity = { connected: true, wifi: true };
  mocks.getConnectivity.mockImplementation(async () => mocks.connectivity);
  mocks.connectivityHandler = null;
  mocks.removeConnectivityListener.mockClear();
  mocks.subscribeConnectivity.mockClear();
  mocks.contentFetch.mockClear();
  mocks.nativeCalls = [];
  vi.stubEnv("VITE_ACCOUNT_API_URL", API_ORIGIN);
  vi.stubEnv("VITE_CONTENT_API_URL", `${API_ORIGIN}/api/content/current`);
  vi.stubGlobal("location", { origin: API_ORIGIN });
  vi.stubGlobal("document", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("web response")),
  );
});

describe("account backup Wi-Fi routing", () => {
  it("routes only exact claim and private-photo endpoints through the dedicated native transport", async () => {
    const auth = await import("./authClient");
    const backup = await import("./accountBackupTransport");

    await auth.fetchAuthenticated("/api/claims?cursor=revision_1", { method: "GET" }, ACCOUNT_ID);
    await auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}`, { method: "PUT", body: "{}" }, ACCOUNT_ID);
    await auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}/photo`, { method: "GET" }, ACCOUNT_ID);
    await auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}/photo`, { method: "PUT", body: new Blob(["photo"]) }, ACCOUNT_ID);

    expect(mocks.nativeCalls).toHaveLength(4);
    expect(mocks.nativeCalls.every((call) => call.fetcher !== undefined && call.fetcher !== mocks.contentFetch)).toBe(true);
    expect(backup.accountBackupFetch).toBeTypeOf("function");
    expect(mocks.nativeCalls.every((call) => new Headers(call.init?.headers).get("X-Kip-Account-ID") === ACCOUNT_ID)).toBe(true);
    expect(mocks.contentFetch).not.toHaveBeenCalled();
  });

  it("blocks invalid routes, methods, and origins without falling back to the generic authenticated fetch", async () => {
    const auth = await import("./authClient");

    await expect(auth.fetchAuthenticated("/api/claims", { method: "PUT", body: "{}" }, ACCOUNT_ID)).rejects.toThrow();
    await expect(auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}`, { method: "GET" }, ACCOUNT_ID)).rejects.toThrow();
    await expect(auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}/photo/extra`, { method: "PUT", body: "x" }, ACCOUNT_ID)).rejects.toThrow();
    await expect(auth.fetchAuthenticated(`https://attacker.example/api/claims/${CLAIM_ID}/photo`, { method: "GET" }, ACCOUNT_ID)).rejects.toThrow(
      "configured HTTPS account API",
    );

    expect(mocks.nativeCalls).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("leaves ordinary sign-in and account requests on their normal any-network transport", async () => {
    const auth = await import("./authClient");

    await auth.fetchAuthenticated("/api/auth/me", { method: "GET" }, ACCOUNT_ID);

    expect(mocks.nativeCalls).toHaveLength(1);
    expect(mocks.nativeCalls[0].fetcher).toBeUndefined();
    expect(mocks.contentFetch).not.toHaveBeenCalled();
  });

  it("keeps same-origin cookie credentials and CSRF scope on browser backup writes", async () => {
    mocks.native = false;
    vi.stubGlobal("document", {
      cookie: "kip_account_csrf=csrf-token",
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("saved", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const auth = await import("./authClient");

    await auth.fetchAuthenticated(
      `/api/claims/${CLAIM_ID}/photo`,
      {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: new Blob(["photo"], { type: "image/png" }),
      },
      ACCOUNT_ID,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`);
    expect(init).toMatchObject({ method: "PUT", credentials: "include", redirect: "error" });
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Kip-Account-ID")).toBe(ACCOUNT_ID);
    expect(headers.get("X-CSRF-Token")).toBe("csrf-token");
    expect(headers.get("Content-Type")).toBe("image/png");
  });
});
