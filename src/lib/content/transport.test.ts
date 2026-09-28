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

import { contentFetch, getContentApiOrigin, isContentWifiAvailable } from "./transport";

const API_URL = "https://parkdex-kip-staging.vercel.app/api/content/current";
const CDN_URL = "https://kip-assets.parkdex.app/releases/v1/map/island/000.bin";

describe("content transport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("web-body", { status: 200 })));
    mocks.capacitor.isNativePlatform.mockReturnValue(false);
    mocks.capacitor.getPlatform.mockReturnValue("web");
    vi.stubEnv("VITE_CONTENT_ENV", "staging");
    vi.stubEnv("VITE_CONTENT_API_URL", "");
    mocks.network.getStatus.mockResolvedValue({ connected: true, connectionType: "wifi" });
    mocks.native.getWifiStatus.mockResolvedValue({ wifi: true });
    mocks.native.request.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/octet-stream", etag: "\"content-v1\"" },
      bodyBase64: "AQID",
      url: CDN_URL,
    });
    mocks.native.abort.mockResolvedValue(undefined);
  });

  it("requires affirmative Wi-Fi before using browser fetch", async () => {
    mocks.network.getStatus.mockResolvedValue({ connected: true, connectionType: "unknown" });

    await expect(contentFetch(API_URL)).rejects.toMatchObject({ name: "WifiUnavailableError" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await isContentWifiAvailable()).toBe(false);
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

  it("uses the Android plugin and returns response metadata and binary bytes", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.capacitor.getPlatform.mockReturnValue("android");

    const response = await contentFetch(CDN_URL, { headers: { Range: "bytes=0-3" } });

    expect(mocks.native.request).toHaveBeenCalledWith(expect.objectContaining({
      url: CDN_URL,
      method: "GET",
      approvedApiOrigin: "https://parkdex-kip-staging.vercel.app",
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

    expect(await isContentWifiAvailable()).toBe(false);
    await expect(contentFetch(API_URL)).rejects.toThrow("unavailable on this native platform");
    expect(mocks.native.request).not.toHaveBeenCalled();
  });
});
