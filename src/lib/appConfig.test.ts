import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: false,
  build: "42",
  storage: new Map<string, string>(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mocks.native,
    getPlatform: () => (mocks.native ? "android" : "web"),
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    getInfo: async () => ({ build: mocks.build, version: "1.0.0", id: "app.parkdex", name: "Parkdex" }),
    addListener: async () => ({ remove: async () => undefined }),
  },
}));

import { FEATURE_FLAGS } from "../../worker/appConfig";
import { activeAppConfig, checkInAppConfig, currentUpdateStatus, FEATURE_FLAG_DEFAULTS, initAppConfig, parseRemoteAppConfig, subscribeUpdateStatus } from "./appConfig";
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
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mocks.storage.get(key) ?? null,
    setItem: (key: string, value: string) => void mocks.storage.set(key, value),
  });
});

afterEach(() => {
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
