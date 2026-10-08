import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => "web"),
  },
  network: {
    getStatus: vi.fn(async () => ({ connected: true, connectionType: "wifi" })),
  },
  native: {
    getWifiStatus: vi.fn(async () => ({ wifi: true })),
    request: vi.fn(async (): Promise<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      bodyBase64: string;
      url: string;
    }> => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/octet-stream", etag: "\"content-v1\"" },
      bodyBase64: "AQID",
      url: "https://kip-assets.parkdex.app/releases/v1/map/island/000.bin",
    })),
    abort: vi.fn(async () => undefined),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: mocks.capacitor,
  registerPlugin: () => mocks.native,
}));

vi.mock("@capacitor/network", () => ({ Network: mocks.network }));

import { setContentChannelOverride } from "../contentChannel";
import { contentFetch, getContentApiOrigin, getContentConnectivity, isContentDownloadAvailable, isContentWifiAvailable, subscribeContentConnectivity } from "./transport";

const API_URL = "https://staging.web.parkdex.app/api/content/current";
const CDN_URL = "https://kip-assets.parkdex.app/releases/v1/map/island/000.bin";
const ART_URL = "https://kip-assets.parkdex.app/releases/v1/art/badges/scenes/park.webp";
const browserConnection = new EventTarget() as EventTarget & { type?: string; effectiveType?: string };
const browserWindow = new EventTarget();

function setBrowserNetwork(options: { online?: boolean; type?: string; effectiveType?: string; connectionApi?: boolean } = {}) {
  browserConnection.type = options.type;
  browserConnection.effectiveType = options.effectiveType;
  const navigatorStub: { onLine: boolean; connection?: typeof browserConnection } = { onLine: options.online ?? true };
  if (options.connectionApi !== false) navigatorStub.connection = browserConnection;
  vi.stubGlobal("navigator", navigatorStub);
}

describe("content transport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("web-body", { status: 200 })));
    vi.stubGlobal("window", browserWindow);
    setBrowserNetwork({ online: true, type: "wifi", effectiveType: "4g" });
    mocks.capacitor.isNativePlatform.mockReturnValue(false);
    mocks.capacitor.getPlatform.mockReturnValue("web");
    vi.stubEnv("VITE_CONTENT_ENV", "staging");
    vi.stubEnv("VITE_CONTENT_API_URL", "");
    mocks.network.getStatus.mockClear();
    mocks.network.getStatus.mockResolvedValue({ connected: true, connectionType: "wifi" });
    mocks.native.getWifiStatus.mockClear();
    mocks.native.getWifiStatus.mockResolvedValue({ wifi: true });
    mocks.native.request.mockClear();
    mocks.native.request.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/octet-stream", etag: "\"content-v1\"" },
      bodyBase64: "AQID",
      url: CDN_URL,
    });
    mocks.native.abort.mockClear();
    mocks.native.abort.mockResolvedValue(undefined);
  });

  it.each([
    { name: "a browser without Network Information API", options: { connectionApi: false } },
    { name: "an unknown browser network type", options: { type: "unknown", effectiveType: "4g" } },
    { name: "a cellular browser connection", options: { type: "cellular", effectiveType: "4g" } },
  ])("allows content sync on $name while preserving an unknown Wi-Fi signal", async ({ options }) => {
    setBrowserNetwork({ online: true, ...options });
    mocks.network.getStatus.mockResolvedValue({ connected: true, connectionType: "unknown" });

    await expect(getContentConnectivity()).resolves.toEqual({ connected: true, wifi: false, contentDownloadAllowed: true });
    await expect(isContentWifiAvailable()).resolves.toBe(false);
    await expect(contentFetch(API_URL)).resolves.toMatchObject({ status: 200 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.network.getStatus).not.toHaveBeenCalled();
  });

  it("allows any online browser network, reports actual Wi-Fi, and pauses while offline", async () => {
    setBrowserNetwork({ online: true, type: "cellular", effectiveType: "4g" });
    await expect(getContentConnectivity()).resolves.toEqual({ connected: true, wifi: false, contentDownloadAllowed: true });
    await expect(isContentWifiAvailable()).resolves.toBe(false);
    await expect(isContentDownloadAvailable()).resolves.toBe(true);

    setBrowserNetwork({ online: false, type: "wifi" });
    await expect(getContentConnectivity()).resolves.toEqual({ connected: false, wifi: false, contentDownloadAllowed: false });
    await expect(isContentDownloadAvailable()).resolves.toBe(false);
    await expect(contentFetch(API_URL)).rejects.toMatchObject({ name: "ContentOfflineError" });

    setBrowserNetwork({ online: true, type: "wifi" });
    await expect(getContentConnectivity()).resolves.toEqual({ connected: true, wifi: true, contentDownloadAllowed: true });
  });

  it("subscribes to online and offline changes without requiring Network Information API", () => {
    setBrowserNetwork({ online: true, connectionApi: false });
    const listener = vi.fn();
    const stop = subscribeContentConnectivity(listener);
    expect(listener).toHaveBeenLastCalledWith({ connected: true, wifi: false, contentDownloadAllowed: true });

    setBrowserNetwork({ online: false, connectionApi: false });
    browserWindow.dispatchEvent(new Event("offline"));
    expect(listener).toHaveBeenLastCalledWith({ connected: false, wifi: false, contentDownloadAllowed: false });

    setBrowserNetwork({ online: true, connectionApi: false });
    browserWindow.dispatchEvent(new Event("online"));
    expect(listener).toHaveBeenLastCalledWith({ connected: true, wifi: false, contentDownloadAllowed: true });
    stop();
  });

  it("subscribes to physical network type changes when the browser exposes them", () => {
    setBrowserNetwork({ online: true, type: "wifi" });
    const listener = vi.fn();
    const stop = subscribeContentConnectivity(listener);
    expect(listener).toHaveBeenLastCalledWith({ connected: true, wifi: true, contentDownloadAllowed: true });

    browserConnection.type = "cellular";
    browserConnection.dispatchEvent(new Event("change"));
    expect(listener).toHaveBeenLastCalledWith({ connected: true, wifi: false, contentDownloadAllowed: true });

    setBrowserNetwork({ online: false, type: "wifi" });
    browserWindow.dispatchEvent(new Event("offline"));
    expect(listener).toHaveBeenLastCalledWith({ connected: false, wifi: false, contentDownloadAllowed: false });
    stop();
  });

  it("uses explicit API configuration and fails closed for an unconfigured native main build", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");
    vi.stubEnv("VITE_CONTENT_ENV", "main");

    expect(getContentApiOrigin()).toBeNull();
    await expect(contentFetch(API_URL)).rejects.toThrow("not configured for this environment");
    expect(mocks.native.request).not.toHaveBeenCalled();

    const productionApiUrl = "https://parkdex-kip.vercel.app/api/content/current";
    vi.stubEnv("VITE_CONTENT_API_URL", productionApiUrl);
    expect(getContentApiOrigin()).toBe("https://parkdex-kip.vercel.app");
    await contentFetch(productionApiUrl);
    expect(mocks.native.request).toHaveBeenCalledWith(expect.objectContaining({
      approvedApiOrigin: "https://parkdex-kip.vercel.app",
    }));
  });

  it("reads the remotely selected content database's host", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");
    try {
      setContentChannelOverride("main");
      expect(getContentApiOrigin()).toBe("https://web.parkdex.app");
      await contentFetch("https://web.parkdex.app/api/content/current");
      expect(mocks.native.request).toHaveBeenCalledWith(expect.objectContaining({ approvedApiOrigin: "https://web.parkdex.app" }));
      setContentChannelOverride("staging");
      vi.stubEnv("VITE_CONTENT_ENV", "main");
      expect(getContentApiOrigin()).toBe("https://staging.web.parkdex.app");
    } finally {
      setContentChannelOverride(null);
    }
  });

  it("resolves a deployed browser main build to its same-origin content API", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_CONTENT_ENV", "main");
    vi.stubGlobal("location", { href: "https://web.parkdex.app/" });

    expect(getContentApiOrigin()).toBe("https://web.parkdex.app");
  });

  it("delegates browser requests with redirects and credentials disabled", async () => {
    const response = await contentFetch(API_URL, { headers: { "If-None-Match": "v1" } });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("web-body");
    expect(globalThis.fetch).toHaveBeenCalledWith(new URL(API_URL), expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      headers: expect.any(Headers),
    }));
  });

  it("continues browser content when physical Wi-Fi is unknown or changes to cellular", async () => {
    setBrowserNetwork({ online: true, type: "wifi" });
    let releaseBody!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { releaseBody = resolve; });
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        streamController = controller;
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        releaseBody();
      },
    }), { headers: { "content-type": "application/octet-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = contentFetch(ART_URL);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await bodyStarted;
    browserConnection.type = "cellular";
    browserConnection.dispatchEvent(new Event("change"));
    streamController?.enqueue(new Uint8Array([1]));
    streamController?.close();

    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it("aborts browser content when the browser goes offline during a streaming response", async () => {
    setBrowserNetwork({ online: true, type: "wifi" });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    }), { headers: { "content-type": "application/octet-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = contentFetch(CDN_URL);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    setBrowserNetwork({ online: false, type: "wifi" });
    browserWindow.dispatchEvent(new Event("offline"));

    await expect(pending).rejects.toMatchObject({ name: "ContentOfflineError" });
  });

  it("bounds buffered browser content responses to four MiB", async () => {
    setBrowserNetwork({ online: true, type: "wifi" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1))));

    await expect(contentFetch(CDN_URL)).rejects.toThrow("exceeds its byte limit");
  });

  it.each([
    "http://parkdex-kip-staging.vercel.app/api/content/current",
    "https://parkdex-kip-staging.vercel.app.attacker.example/api/content/current",
    "https://parkdex-kip-a1b2c3d4e-unrelated.vercel.app/api/content/current",
    "https://attacker.example/content.json",
    "https://user@parkdex-kip-staging.vercel.app/api/content/current",
  ])("rejects unapproved URL %s", async (url) => {
    await expect(contentFetch(url)).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects non-content methods and request bodies", async () => {
    await expect(contentFetch(API_URL, { method: "POST", body: "payload" })).rejects.toThrow("only permits GET and HEAD");
    await expect(contentFetch(API_URL, { method: "GET", body: "payload" })).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("allows bodyless requests when the Request body getter is missing", async () => {
    const NativeRequest = globalThis.Request;
    class FirefoxRequest extends NativeRequest {}
    Object.defineProperty(FirefoxRequest.prototype, "body", { configurable: true, get: () => undefined });
    vi.stubGlobal("Request", FirefoxRequest);

    await expect(contentFetch(API_URL)).resolves.toMatchObject({ status: 200 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the Android plugin and returns response metadata and binary bytes", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");

    const response = await contentFetch(CDN_URL, { headers: { Range: "bytes=0-3" } });

    expect(mocks.native.request).toHaveBeenCalledWith(expect.objectContaining({
      url: CDN_URL,
      method: "GET",
      approvedApiOrigin: "https://staging.web.parkdex.app",
      approvedCdnOrigin: "https://kip-assets.parkdex.app",
      maxResponseBytes: 4 * 1024 * 1024,
      headers: { range: "bytes=0-3" },
    }));
    expect(response.url).toBe(CDN_URL);
    expect(response.headers.get("etag")).toBe("\"content-v1\"");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("preserves 304 metadata without constructing a response body", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");
    mocks.native.request.mockResolvedValue({
      status: 304,
      statusText: "Not Modified",
      headers: { etag: "\"content-v1\"" },
      bodyBase64: "",
      url: API_URL,
    });

    const response = await contentFetch(API_URL, { headers: { "If-None-Match": "\"content-v1\"" } });

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe("\"content-v1\"");
    expect(await response.arrayBuffer()).toHaveProperty("byteLength", 0);
  });

  it("rejects native redirects", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");
    mocks.native.request.mockResolvedValue({
      status: 302,
      statusText: "Found",
      headers: { location: "https://attacker.example/" },
      bodyBase64: "",
      url: CDN_URL,
    });

    await expect(contentFetch(CDN_URL)).rejects.toThrow("redirects are not permitted");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("aborts the native request when the fetch signal aborts", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");
    mocks.native.request.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = contentFetch(CDN_URL, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.native.abort).toHaveBeenCalledWith({ requestId: expect.any(String) });
  });

  it("rejects an oversized native bridge body", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");
    mocks.native.request.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      bodyBase64: "A".repeat(6 * 1024 * 1024),
      url: CDN_URL,
    });

    await expect(contentFetch(CDN_URL)).rejects.toThrow("exceeds its byte limit");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not fall back to browser fetch after a native request fails", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");
    mocks.native.request.mockRejectedValue(new Error("Wi-Fi connection lost"));

    await expect(contentFetch(CDN_URL)).rejects.toThrow("Wi-Fi connection lost");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not report Wi-Fi on unsupported native platforms", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("ios");

    expect(await getContentConnectivity()).toEqual({ connected: false, wifi: false, contentDownloadAllowed: false });
    expect(await isContentWifiAvailable()).toBe(false);
    await expect(contentFetch(API_URL)).rejects.toThrow("unavailable on this native platform");
    expect(mocks.native.request).not.toHaveBeenCalled();
  });

  it("allows Android essential content on cellular without reporting Wi-Fi", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");
    mocks.network.getStatus.mockResolvedValue({ connected: true, connectionType: "cellular" });
    mocks.native.getWifiStatus.mockResolvedValue({ wifi: false });

    await expect(getContentConnectivity()).resolves.toEqual({ connected: true, wifi: false, contentDownloadAllowed: true });
    await expect(isContentDownloadAvailable()).resolves.toBe(true);
    await expect(contentFetch(API_URL)).resolves.toMatchObject({ status: 200 });
    await expect(contentFetch(ART_URL)).resolves.toMatchObject({ status: 200 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("times out a stalled browser response so content recovery can retry", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      }))));
      const pending = contentFetch(ART_URL);
      const result = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(60_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { type: "cellular" },
    { connectionApi: false },
  ])("defers detailed maps without confirmed Wi-Fi while downloading art", async (network) => {
    setBrowserNetwork({ online: true, ...network });
    await expect(contentFetch(CDN_URL)).rejects.toMatchObject({ name: "WifiUnavailableError" });
    await expect(contentFetch(CDN_URL.replace("map/island/", "map%2Fisland%2F"))).rejects.toMatchObject({ name: "WifiUnavailableError" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await expect(contentFetch(ART_URL)).resolves.toMatchObject({ status: 200 });
  });

  it("lets nearby map detail use cellular when the request allows any network", async () => {
    setBrowserNetwork({ online: true, type: "cellular" });
    await expect(contentFetch(CDN_URL, { anyNetwork: true })).resolves.toMatchObject({ status: 200 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes the any-network allowance to the Android plugin only when requested", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");
    await contentFetch(CDN_URL);
    await contentFetch(CDN_URL, { anyNetwork: true });
    expect(mocks.native.request).toHaveBeenNthCalledWith(1, expect.objectContaining({ anyNetwork: false }));
    expect(mocks.native.request).toHaveBeenNthCalledWith(2, expect.objectContaining({ anyNetwork: true }));
  });

  it("aborts detailed map streaming when Wi-Fi changes to cellular", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const pending = contentFetch(CDN_URL);
    const result = expect(pending).rejects.toMatchObject({ name: "WifiUnavailableError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    browserConnection.type = "cellular";
    browserConnection.dispatchEvent(new Event("change"));
    await result;
  });

  it("labels content API requests for analytics but leaves CDN requests untouched", async () => {
    vi.stubGlobal("__APP_BUILD__", "abc1234");
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await contentFetch(API_URL);
    await contentFetch(CDN_URL, { anyNetwork: true });
    const [apiInit, cdnInit] = fetcher.mock.calls.map((call) => (call as unknown as [URL, RequestInit])[1]);
    expect(new Headers(apiInit.headers).get("X-Kip-Bundle-Id")).toBe("abc1234");
    expect(new Headers(cdnInit.headers).get("X-Kip-Bundle-Id")).toBeNull();
  });
});
