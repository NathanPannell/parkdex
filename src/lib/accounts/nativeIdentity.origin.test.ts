import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  native: true,
  plugin: {
    getGoogleIdToken: vi.fn(),
    setSession: vi.fn(),
    getSession: vi.fn(),
    clearSession: vi.fn(),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => nativeMocks.native ? "android" : "web",
    isNativePlatform: () => nativeMocks.native,
    isPluginAvailable: () => true,
  },
  registerPlugin: () => nativeMocks.plugin,
}));

import {
  NativeSessionOriginMismatchError,
  nativeAuthFetch,
  persistNativeSession,
  readNativeSession,
} from "./nativeIdentity";

describe("native session API-origin binding", () => {
  beforeEach(() => {
    nativeMocks.native = true;
    nativeMocks.plugin.getSession.mockReset();
    nativeMocks.plugin.setSession.mockReset();
    nativeMocks.plugin.clearSession.mockReset();
    vi.stubEnv("VITE_CONTENT_ENV", "staging");
    vi.stubEnv("VITE_ACCOUNT_API_URL", "");
    vi.stubEnv("VITE_APP_URL", "https://parkdex-kip-staging.vercel.app");
    vi.stubEnv("VITE_PREVIEW_API_ORIGIN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the same trimmed URL precedence when binding a new native session", async () => {
    nativeMocks.plugin.setSession.mockResolvedValue(undefined);

    await persistNativeSession({ sessionToken: "scoped-session", expiresAt: Date.now() + 60_000 });

    expect(nativeMocks.plugin.setSession).toHaveBeenCalledWith(expect.objectContaining({
      token: "scoped-session",
      apiOrigin: "https://parkdex-kip-staging.vercel.app",
    }));
  });

  it("allows the issuer origin and preserves the stored session when the app changes environment", async () => {
    const stagingSession = {
      token: "staging-bearer",
      expiresAt: Date.now() + 60_000,
      apiOrigin: "https://parkdex-kip-staging.vercel.app",
    };
    nativeMocks.plugin.getSession.mockResolvedValue(stagingSession);

    await expect(readNativeSession()).resolves.toEqual(stagingSession);
    vi.stubEnv("VITE_CONTENT_ENV", "main");
    vi.stubEnv("VITE_APP_URL", "https://web.parkdex.app");
    await expect(readNativeSession()).rejects.toBeInstanceOf(NativeSessionOriginMismatchError);
    expect(nativeMocks.plugin.clearSession).not.toHaveBeenCalled();
  });

  it("never sends preview A credentials to preview B", async () => {
    const previewA = "https://parkdex-kip-preview-a.vercel.app";
    const previewB = "https://parkdex-kip-preview-b.vercel.app";
    vi.stubEnv("VITE_CONTENT_ENV", "preview");
    vi.stubEnv("VITE_PREVIEW_API_ORIGIN", previewB);
    vi.stubEnv("VITE_ACCOUNT_API_URL", previewB);
    nativeMocks.plugin.getSession.mockResolvedValue({ token: "preview-a-bearer", expiresAt: Date.now() + 60_000, apiOrigin: previewA });
    const fetcher = vi.fn();

    await expect(nativeAuthFetch(`${previewB}/api/auth/me`, {}, fetcher)).rejects.toBeInstanceOf(NativeSessionOriginMismatchError);
    expect(nativeMocks.plugin.clearSession).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a persistent native migration-required signal offline and never sends a bearer", async () => {
    nativeMocks.plugin.getSession.mockResolvedValue({ requiresReauth: true });
    const fetcher = vi.fn();

    await expect(nativeAuthFetch("https://parkdex-kip-staging.vercel.app/api/auth/me", {}, fetcher)).rejects.toBeInstanceOf(NativeSessionOriginMismatchError);
    await expect(readNativeSession()).rejects.toBeInstanceOf(NativeSessionOriginMismatchError);
    expect(nativeMocks.plugin.getSession).toHaveBeenCalledTimes(2);
    expect(nativeMocks.plugin.clearSession).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
