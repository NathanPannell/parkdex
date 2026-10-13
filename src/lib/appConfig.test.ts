import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: false,
  build: "42",
  storage: new Map<string, string>(),
  getInfo: vi.fn(async () => ({ build: mocks.build, version: "1.0.0", id: "app.parkdex", name: "Parkdex" })),
  getNativePackageInstallInfo: vi.fn(async () => null as {
    packageName: string;
    firstInstallTime: number;
    lastUpdateTime: number;
    versionCode: number;
  } | null),
  resumeListener: null as (() => void) | null,
  clearLocalNativeSession: vi.fn(async () => undefined),
  addListener: vi.fn(async (_event: string, listener: () => void) => {
    mocks.resumeListener = listener;
    return { remove: async () => undefined };
  }),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mocks.native,
    getPlatform: () => (mocks.native ? "android" : "web"),
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    getInfo: mocks.getInfo,
    addListener: mocks.addListener,
  },
}));

vi.mock("./native", () => ({ getNativePackageInstallInfo: mocks.getNativePackageInstallInfo }));
vi.mock("./accounts/authClient", () => ({ clearLocalNativeSession: mocks.clearLocalNativeSession }));

import { FEATURE_FLAGS } from "../../worker/appConfig";
import { activeAppConfig, checkInAppConfig, currentUpdateStatus, FEATURE_FLAG_DEFAULTS, initAppConfig, parseRemoteAppConfig, remoteFlag, startAppConfigCheckIns, subscribeUpdateStatus } from "./appConfig";
import { apiEnvironment, apiPointerOverride } from "./apiPointer";
import { contentChannelOverride } from "./contentChannel";
import { getParkRarityEligibility, getRarityProgress, isRankProgressionEnabled, setRankProgressionEnabled } from "./progression";

function answer(overrides: Record<string, unknown> = {}) {
  return { schema: "parkdex.app-config/v1", platform: "android", build: 42, contentChannel: null, flags: {}, source: "none", ...overrides };
}

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

beforeEach(() => {
  mocks.native = true;
  mocks.build = "42";
  mocks.storage.clear();
  mocks.getInfo.mockReset();
  mocks.getInfo.mockImplementation(async () => ({ build: mocks.build, version: "1.0.0", id: "app.parkdex", name: "Parkdex" }));
  mocks.getNativePackageInstallInfo.mockReset();
  mocks.getNativePackageInstallInfo.mockResolvedValue(null);
  mocks.resumeListener = null;
  mocks.addListener.mockClear();
  mocks.clearLocalNativeSession.mockClear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mocks.storage.get(key) ?? null,
    setItem: (key: string, value: string) => void mocks.storage.set(key, value),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setRankProgressionEnabled(true);
});

describe("app config", () => {
  it("lists the same feature flags as the server", () => {
    expect(Object.keys(FEATURE_FLAG_DEFAULTS).sort()).toEqual([...FEATURE_FLAGS].sort());
  });

  it("uses built-in defaults before the first check-in", async () => {
    const config = await initAppConfig();
    expect(config).toMatchObject({ platform: "android", build: 42, contentChannel: null, fetchedAt: null });
    expect(isRankProgressionEnabled()).toBe(false);
    expect(contentChannelOverride()).toBeNull();
  });

  it("falls back to package install info when App.getInfo times out", async () => {
    vi.useFakeTimers();
    mocks.getInfo.mockImplementation(() => new Promise(() => undefined));
    mocks.getNativePackageInstallInfo.mockResolvedValue({
      packageName: "app.parkdex", firstInstallTime: 1_790_000_000_000, lastUpdateTime: 1_790_000_000_000, versionCode: 42,
    });

    const initialized = initAppConfig();
    const result = expect(initialized).resolves.toMatchObject({ platform: "android", build: 42 });
    await vi.advanceTimersByTimeAsync(1_500);
    await result;

    expect(mocks.getNativePackageInstallInfo).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to package install info when App.getInfo fails", async () => {
    mocks.getInfo.mockRejectedValue(new Error("App plugin unavailable"));
    mocks.getNativePackageInstallInfo.mockResolvedValue({
      packageName: "app.parkdex", firstInstallTime: 1_790_000_000_000, lastUpdateTime: 1_790_000_000_000, versionCode: 42,
    });

    await expect(initAppConfig()).resolves.toMatchObject({ platform: "android", build: 42 });
    expect(mocks.getNativePackageInstallInfo).toHaveBeenCalledTimes(1);
  });

  it("retries unknown Android build info on resume without checking in or caching build zero", async () => {
    mocks.getInfo.mockRejectedValue(new Error("App plugin unavailable"));
    mocks.getNativePackageInstallInfo.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mocks.storage.set("parkdex.app-config.v1", JSON.stringify({
      config: answer({ build: 0, contentChannel: "main", flags: { rankProgression: true } }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
    }));

    const initial = await initAppConfig();
    expect(initial).toMatchObject({ platform: "android", build: 0, contentChannel: null, fetchedAt: null });
    expect(initial.flags.rankProgression).toBe(false);
    const fetcher = respond(answer({ contentChannel: "main", flags: { rankProgression: true }, update: "available" }));
    vi.stubGlobal("fetch", fetcher);

    startAppConfigCheckIns();
    await vi.waitFor(() => expect(mocks.getNativePackageInstallInfo).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.resumeListener).toBeTypeOf("function"));
    expect(fetcher).not.toHaveBeenCalled();

    mocks.getNativePackageInstallInfo.mockResolvedValue({
      packageName: "app.parkdex", firstInstallTime: 1_790_000_000_000, lastUpdateTime: 1_790_000_000_000, versionCode: 42,
    });
    mocks.resumeListener?.();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    expect(String(vi.mocked(fetcher).mock.calls[0]?.[0])).toContain("platform=android&build=42");
    expect(currentUpdateStatus()).toBe("available");
    expect(activeAppConfig()).toMatchObject({ build: 42, contentChannel: null, flags: { rankProgression: false } });
    expect(JSON.parse(mocks.storage.get("parkdex.app-config.v1") ?? "null").config.build).toBe(42);

    await initAppConfig();
    expect(activeAppConfig()).toMatchObject({ build: 42, contentChannel: "main", flags: { rankProgression: true } });
    expect(contentChannelOverride()).toBe("main");
  });

  it.each([
    { cacheBuild: 42, expectedUpdate: "required" },
    { cacheBuild: 41, expectedUpdate: "none" },
  ])("uses only the recovered build's cached update gate while offline (cache build $cacheBuild)", async ({ cacheBuild, expectedUpdate }) => {
    mocks.getInfo.mockRejectedValue(new Error("App plugin unavailable"));
    mocks.getNativePackageInstallInfo.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mocks.storage.set("parkdex.app-config.v1", JSON.stringify({
      config: answer({ build: cacheBuild, contentChannel: "main", flags: { rankProgression: true }, update: "required" }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
    }));

    const initial = await initAppConfig();
    expect(initial).toMatchObject({ build: 0, contentChannel: null, fetchedAt: null, flags: { rankProgression: false } });
    expect(currentUpdateStatus()).toBe("none");

    const fetcher = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetcher);
    startAppConfigCheckIns();
    await vi.waitFor(() => expect(mocks.getNativePackageInstallInfo).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.resumeListener).toBeTypeOf("function"));

    mocks.getNativePackageInstallInfo.mockResolvedValue({
      packageName: "app.parkdex", firstInstallTime: 1_790_000_000_000, lastUpdateTime: 1_790_000_000_000, versionCode: 42,
    });
    mocks.resumeListener?.();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    expect(currentUpdateStatus()).toBe(expectedUpdate);
    expect(activeAppConfig()).toMatchObject({ build: 42, contentChannel: null, flags: { rankProgression: false } });
    expect(JSON.parse(mocks.storage.get("parkdex.app-config.v1") ?? "null").config.build).toBe(cacheBuild);
  });

  it("applies a saved check-in on the next launch, not mid-session", async () => {
    await initAppConfig();
    const fetcher = respond(answer({ contentChannel: "main", flags: { rankProgression: true } }));
    const fresh = await checkInAppConfig(fetcher);
    expect(fresh?.flags.rankProgression).toBe(true);
    expect(String(vi.mocked(fetcher).mock.calls[0][0])).toBe("https://web.parkdex.app/api/app-config?platform=android&build=42&env=staging");
    expect(isRankProgressionEnabled()).toBe(false);

    await initAppConfig();
    expect(activeAppConfig().flags.rankProgression).toBe(true);
    expect(isRankProgressionEnabled()).toBe(true);
    // This test build is a staging build, so a main answer is a switch.
    expect(contentChannelOverride()).toBe("main");
  });

  it("ignores a saved answer for a different build", async () => {
    await initAppConfig();
    await checkInAppConfig(respond(answer({ flags: { rankProgression: true } })));
    mocks.build = "43";
    await initAppConfig();
    expect(activeAppConfig().fetchedAt).toBeNull();
    expect(isRankProgressionEnabled()).toBe(false);
  });

  it("keeps the previous answer when the server fails or answers badly", async () => {
    await initAppConfig();
    expect(await checkInAppConfig(respond({ error: "down" }, 503))).toBeNull();
    expect(await checkInAppConfig(respond(answer({ build: 7 })))).toBeNull();
    expect(await checkInAppConfig(vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBeNull();
    expect(mocks.storage.has("parkdex.app-config.v1")).toBe(false);
  });

  it("does not switch a web page's content database", async () => {
    mocks.native = false;
    vi.stubGlobal("location", { origin: "https://staging.web.parkdex.app" });
    await initAppConfig();
    await checkInAppConfig(respond({ ...answer({ platform: "web", build: 0, contentChannel: "main" }) }));
    await initAppConfig();
    expect(activeAppConfig().contentChannel).toBe("main");
    expect(contentChannelOverride()).toBeNull();
  });

  it("shows an update prompt as soon as the server asks for one", async () => {
    await initAppConfig();
    expect(currentUpdateStatus()).toBe("none");
    const listener = vi.fn();
    const stop = subscribeUpdateStatus(listener);
    await checkInAppConfig(respond(answer({ update: "required" })));
    expect(currentUpdateStatus()).toBe("required");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    await checkInAppConfig(respond(answer({ update: "available" })));
    expect(currentUpdateStatus()).toBe("available");
    // An answer from an older server without `update` never blocks.
    await checkInAppConfig(respond(answer()));
    expect(currentUpdateStatus()).toBe("none");
  });

  it("remembers a required update across launches", async () => {
    await initAppConfig();
    await checkInAppConfig(respond(answer({ update: "required" })));
    await checkInAppConfig(respond({ error: "offline" }, 503));
    await initAppConfig();
    expect(currentUpdateStatus()).toBe("required");
  });

  it("never prompts a web page to update", async () => {
    mocks.native = false;
    vi.stubGlobal("location", { origin: "https://web.parkdex.app" });
    await initAppConfig();
    await checkInAppConfig(respond(answer({ platform: "web", build: 0, update: "required" })));
    expect(currentUpdateStatus()).toBe("none");
  });

  it("rejects unknown channels and pointers, and keeps every well-formed flag for later builds", async () => {
    expect(parseRemoteAppConfig(answer({ contentChannel: "production" }), { platform: "android", build: 42 })).toBeNull();
    expect(parseRemoteAppConfig(answer({ apiPointer: "main" }), { platform: "android", build: 42 })).toBeNull();
    await initAppConfig();
    const fresh = await checkInAppConfig(respond(answer({ flags: { rankProgression: true, futureThing: true, "bad key": true } })));
    expect(fresh?.flags).toEqual({ rankProgression: true, parkProposals: true, crews: false, friends: false });
    expect(fresh?.remoteFlags).toEqual({ rankProgression: true, futureThing: true });
    await initAppConfig();
    expect(remoteFlag("futureThing")).toBe(true);
    expect(remoteFlag("missing")).toBeUndefined();
  });

  it("switches a native build's whole API to the pointed server on the next launch and signs out of the old one", async () => {
    await initAppConfig();
    expect(apiPointerOverride()).toBeNull();
    expect(apiEnvironment()).not.toBe("main");
    await checkInAppConfig(respond(answer({ apiPointer: "production", contentChannel: "main" })));
    // Nothing changes mid-session.
    expect(apiPointerOverride()).toBeNull();
    expect(mocks.clearLocalNativeSession).not.toHaveBeenCalled();

    await initAppConfig();
    expect(apiPointerOverride()).toBe("production");
    expect(apiEnvironment()).toBe("main");
    expect(contentChannelOverride()).toBe("main");
    expect(mocks.clearLocalNativeSession).toHaveBeenCalledTimes(1);

    // Same server again: no further sign-out.
    await initAppConfig();
    expect(mocks.clearLocalNativeSession).toHaveBeenCalledTimes(1);

    // Pointing back at the build's own server clears the override and signs out once more.
    await checkInAppConfig(respond(answer({ apiPointer: null })));
    await initAppConfig();
    expect(apiPointerOverride()).toBeNull();
    expect(contentChannelOverride()).toBeNull();
    expect(mocks.clearLocalNativeSession).toHaveBeenCalledTimes(2);
  });

  it("reads an older server's content channel as the pointer", () => {
    expect(parseRemoteAppConfig(answer({ contentChannel: "main" }), { platform: "android", build: 42 })?.apiPointer).toBe("production");
    expect(parseRemoteAppConfig(answer({ contentChannel: null }), { platform: "android", build: 42 })?.apiPointer).toBeNull();
  });
});

describe("rank progression flag", () => {
  const legendary = { id: "legend", rarity: "legendary" as const };

  it("locks higher rarities while on", () => {
    expect(getParkRarityEligibility(legendary, getRarityProgress({}, [])).eligible).toBe(false);
  });

  it("opens every rarity while off", () => {
    setRankProgressionEnabled(false);
    const eligibility = getParkRarityEligibility(legendary, getRarityProgress({}, []));
    expect(eligibility).toMatchObject({ eligible: true, reason: "unlocked", remaining: 0 });
  });
});
