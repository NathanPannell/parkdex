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
  contentFetch: vi.fn(async () => new Response("native photo")),
  nativeCalls: [] as Array<{ input: RequestInfo | URL; init?: RequestInit; fetcher?: typeof fetch }>,
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => mocks.native } }));
vi.mock("../content/transport", () => ({
  contentFetch: mocks.contentFetch,
  getContentApiOrigin: () => mocks.contentOrigin,
  getContentConnectivity: mocks.getConnectivity,
  subscribeContentConnectivity: mocks.subscribeConnectivity,
}));
vi.mock("./nativeIdentity", () => ({
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
  vi.stubGlobal("fetch", vi.fn(async () => new Response("web photo")));
});

describe("private photo Wi-Fi transport", () => {
  it("routes only native private-photo GETs through the content transport", async () => {
    const auth = await import("./authClient");
    const photoUrl = `${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`;

    await auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}/photo`, { method: "GET" }, ACCOUNT_ID);
    await auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}`, { method: "GET" }, ACCOUNT_ID);
    await auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}/photo`, { method: "PUT" }, ACCOUNT_ID);

    expect(mocks.nativeCalls).toHaveLength(3);
    expect(mocks.nativeCalls[0]).toMatchObject({ input: photoUrl, fetcher: mocks.contentFetch });
    expect(new Headers(mocks.nativeCalls[0].init?.headers).get("X-Kip-Account-ID")).toBe(ACCOUNT_ID);
    expect(mocks.nativeCalls[1].fetcher).toBeUndefined();
    expect(mocks.nativeCalls[2].fetcher).toBeUndefined();
  });

  it("rejects native photo transport when account and content API origins differ", async () => {
    vi.stubEnv("VITE_CONTENT_API_URL", "https://other-preview.vercel.app/api/content/current");
    mocks.contentOrigin = "https://other-preview.vercel.app";
    const auth = await import("./authClient");

    await expect(auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}/photo`, { method: "GET" }, ACCOUNT_ID))
      .rejects.toThrow("matching account and content API origins");
    expect(mocks.nativeCalls).toHaveLength(0);
  });

  it("blocks browser private-photo downloads when Wi-Fi is unknown or unavailable", async () => {
    mocks.native = false;
    mocks.connectivity = { connected: true, wifi: false };
    const auth = await import("./authClient");

    await expect(auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}/photo`, { method: "GET" }, ACCOUNT_ID))
      .rejects.toMatchObject({ name: "WifiUnavailableError" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects browser private-photo bodies above the server byte limit", async () => {
    mocks.native = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(2_621_441), {
      headers: { "content-type": "image/png" },
    })));
    const auth = await import("./authClient");

    await expect(auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}/photo`, { method: "GET" }, ACCOUNT_ID))
      .rejects.toThrow("exceeds its byte limit");
    expect(mocks.removeConnectivityListener).toHaveBeenCalledTimes(1);
  });

  it("keeps browser cookie auth and aborts a photo fetch when Wi-Fi is lost", async () => {
    mocks.native = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    }), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const auth = await import("./authClient");
    const pending = auth.fetchAuthenticated(`/api/claims/${CLAIM_ID}/photo`, { method: "GET" }, ACCOUNT_ID);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [photoUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(photoUrl)).toBe(`${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`);
    expect(requestInit).toMatchObject({
      credentials: "include",
      redirect: "error",
    });
    expect(requestInit?.signal).toBeDefined();
    // The helper reads the response body before returning, so its Wi-Fi listener is still active here.
    mocks.connectivityHandler?.({ connected: true, wifi: false });

    await expect(pending).rejects.toMatchObject({ name: "WifiUnavailableError" });
    expect(mocks.removeConnectivityListener).toHaveBeenCalledTimes(1);
  });
});
