import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostHog } from "posthog-js";

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "web", isNativePlatform: () => false } }));
vi.mock("./apiPointer", () => ({ apiEnvironment: () => "main" }));

import { parseRemoteAnalytics, resetProductAnalyticsForTests, setProductAnalyticsAccount, startProductAnalytics } from "./productAnalytics";
import { loadInstallationId, resetRequestContextForTests } from "./requestContext";

const KEY = "phc_testProjectKey1234567890";
const INSTALLATION = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
const ACCOUNT = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";

function fakePosthog(state: { identified?: string } = {}) {
  const sdk = {
    init: vi.fn(),
    register: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    get_property: vi.fn((name: string) => (name === "$user_state" && state.identified ? "identified" : "anonymous")),
    get_distinct_id: vi.fn(() => state.identified ?? INSTALLATION),
  };
  return { sdk, load: vi.fn(async () => ({ default: sdk as unknown as PostHog })) };
}

describe("product analytics", () => {
  beforeEach(async () => {
    resetProductAnalyticsForTests();
    resetRequestContextForTests();
    vi.stubGlobal("window", {});
    vi.stubGlobal("__APP_VERSION__", "0.1.0");
    vi.stubGlobal("__APP_BUILD__", "abc1234");
    await loadInstallationId({ getInstallationId: async () => INSTALLATION });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the server's analytics block and rejects bad hosts or keys", () => {
    expect(parseRemoteAnalytics({ posthogKey: KEY, posthogHost: "https://us.i.posthog.com" })).toEqual({ key: KEY, host: "https://us.i.posthog.com" });
    expect(parseRemoteAnalytics({ posthogKey: KEY })).toEqual({ key: KEY, host: "https://us.i.posthog.com" });
    expect(parseRemoteAnalytics({ posthogKey: KEY, posthogHost: "http://insecure.example" })).toBeNull();
    expect(parseRemoteAnalytics({ posthogKey: "x" })).toBeNull();
    expect(parseRemoteAnalytics(null)).toBeNull();
  });

  it("loads nothing without a key", async () => {
    const { load } = fakePosthog();
    await startProductAnalytics(null, load);
    expect(load).not.toHaveBeenCalled();
  });

  it("starts once with identified-only profiles, autocapture and the installation as the anonymous ID", async () => {
    const { sdk, load } = fakePosthog();
    await startProductAnalytics({ key: KEY, host: "https://us.i.posthog.com" }, load);
    await startProductAnalytics({ key: "phc_otherKey1234567890", host: "https://eu.i.posthog.com" }, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledWith(KEY, expect.objectContaining({
      api_host: "https://us.i.posthog.com",
      person_profiles: "identified_only",
      autocapture: true,
      bootstrap: { distinctID: INSTALLATION },
    }));
    expect(sdk.register).toHaveBeenCalledWith(expect.objectContaining({ environment: "production", app_version: "0.1.0", bundle_id: "abc1234" }));
  });

  it("identifies after sign-in and resets after sign-out, including a sign-in before the SDK loaded", async () => {
    const { sdk, load } = fakePosthog();
    setProductAnalyticsAccount(ACCOUNT);
    await startProductAnalytics({ key: KEY, host: "https://us.i.posthog.com" }, load);
    expect(sdk.identify).toHaveBeenCalledWith(ACCOUNT);
    setProductAnalyticsAccount(ACCOUNT);
    expect(sdk.identify).toHaveBeenCalledTimes(1);
    setProductAnalyticsAccount(null);
    expect(sdk.reset).toHaveBeenCalledTimes(1);
  });

  it("drops an identity left from an earlier launch when this one is signed out, but not while sign-in is unresolved", async () => {
    const { sdk, load } = fakePosthog({ identified: ACCOUNT });
    await startProductAnalytics({ key: KEY, host: "https://us.i.posthog.com" }, load);
    expect(sdk.reset).not.toHaveBeenCalled();
    setProductAnalyticsAccount(null);
    expect(sdk.reset).toHaveBeenCalledTimes(1);
  });

  it("a failing SDK load leaves the app unaffected", async () => {
    await expect(startProductAnalytics({ key: KEY, host: "https://us.i.posthog.com" }, async () => { throw new Error("offline"); })).resolves.toBeUndefined();
    expect(() => setProductAnalyticsAccount(ACCOUNT)).not.toThrow();
  });
});
