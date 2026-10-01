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

import { FEATURE_FLAGS } from "../../worker/appConfig";
import { activeAppConfig, checkInAppConfig, currentUpdateStatus, FEATURE_FLAG_DEFAULTS, initAppConfig, parseRemoteAppConfig, startAppConfigCheckIns, subscribeUpdateStatus } from "./appConfig";
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
    expect(isRankProgressionEnabled()).toBe(true);
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
      config: answer({ build: 0, contentChannel: "main", flags: { rankProgression: false } }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
    }));

    const initial = await initAppConfig();
    expect(initial).toMatchObject({ platform: "android", build: 0, contentChannel: null, fetchedAt: null });
    expect(initial.flags.rankProgression).toBe(true);
    const fetcher = respond(answer({ contentChannel: "main", flags: { rankProgression: false }, update: "available" }));
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
    expect(activeAppConfig()).toMatchObject({ build: 42, contentChannel: null, flags: { rankProgression: true } });
    expect(JSON.parse(mocks.storage.get("parkdex.app-config.v1") ?? "null").config.build).toBe(42);

    await initAppConfig();
    expect(activeAppConfig()).toMatchObject({ build: 42, contentChannel: "main", flags: { rankProgression: false } });
    expect(contentChannelOverride()).toBe("main");
  });

  it.each([
    { cacheBuild: 42, expectedUpdate: "required" },
    { cacheBuild: 41, expectedUpdate: "none" },
  ])("uses only the recovered build's cached update gate while offline (cache build $cacheBuild)", async ({ cacheBuild, expectedUpdate }) => {
    mocks.getInfo.mockRejectedValue(new Error("App plugin unavailable"));
    mocks.getNativePackageInstallInfo.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mocks.storage.set("parkdex.app-config.v1", JSON.stringify({
      config: answer({ build: cacheBuild, contentChannel: "main", flags: { rankProgression: false }, update: "required" }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
    }));

    const initial = await initAppConfig();
    expect(initial).toMatchObject({ build: 0, contentChannel: null, fetchedAt: null, flags: { rankProgression: true } });
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
    expect(activeAppConfig()).toMatchObject({ build: 42, contentChannel: null, flags: { rankProgression: true } });
    expect(JSON.parse(mocks.storage.get("parkdex.app-config.v1") ?? "null").config.build).toBe(cacheBuild);
  });

  it("applies a saved check-in on the next launch, not mid-session", async () => {
    await initAppConfig();
    const fetcher = respond(answer({ contentChannel: "main", flags: { rankProgression: false } }));
    const fresh = await checkInAppConfig(fetcher);
    expect(fresh?.flags.rankProgression).toBe(false);
    expect(String(vi.mocked(fetcher).mock.calls[0][0])).toBe("https://web.parkdex.app/api/app-config?platform=android&build=42");
    expect(isRankProgressionEnabled()).toBe(true);

    await initAppConfig();
    expect(activeAppConfig().flags.rankProgression).toBe(false);
    expect(isRankProgressionEnabled()).toBe(false);
    // This test build is a staging build, so a main answer is a switch.
    expect(contentChannelOverride()).toBe("main");
  });

  it("ignores a saved answer for a different build", async () => {
    await initAppConfig();
    await checkInAppConfig(respond(answer({ flags: { rankProgression: false } })));
    mocks.build = "43";
    await initAppConfig();
    expect(activeAppConfig().fetchedAt).toBeNull();
    expect(isRankProgressionEnabled()).toBe(true);
  });

  it("keeps the previous answer when the server fails or answers badly", async () => {
    await initAppConfig();
    expect(await checkInAppConfig(respond({ error: "down" }, 503))).toBeNull();
    expect(await checkInAppConfig(respond(answer({ build: 7 })))).toBeNull();
    expect(await checkInAppConfig(vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBeNull();
    expect(mocks.storage.size).toBe(0);
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

  it("drops unknown flags and channels", () => {
    expect(parseRemoteAppConfig(answer({ contentChannel: "production" }), { platform: "android", build: 42 })).toBeNull();
    expect(parseRemoteAppConfig(answer({ flags: { rankProgression: true, other: true } }), { platform: "android", build: 42 })?.flags)
      .toEqual({ rankProgression: true });
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
