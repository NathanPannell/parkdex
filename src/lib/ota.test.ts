import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: true,
  storage: new Map<string, string>(),
  appListeners: new Map<string, () => void>(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mocks.native,
    isPluginAvailable: () => mocks.native,
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: () => void) => {
      mocks.appListeners.set(event, listener);
      return { remove: async () => undefined };
    }),
  },
}));

import { bundleToApply, isOverTheAirBundle, overTheAirBundleLabel, resetOverTheAirForTests, startOverTheAirUpdates } from "./ota";

type Bundle = { id: string; version: string; status: "success" | "error" | "pending" | "downloading" | "deleted" | "deleting"; downloaded: string; checksum: string };

function bundle(id: string, status: Bundle["status"] = "pending"): Bundle {
  return { id, version: id === "builtin" ? "builtin" : `v-${id}`, status, downloaded: "", checksum: "" };
}

function fakeUpdater(current: Bundle, bundles: Bundle[]) {
  let updateAvailable: ((event: { bundle: Bundle }) => void) | null = null;
  const plugin = {
    current: vi.fn(async () => ({ bundle: current, native: "1.0.0" })),
    list: vi.fn(async () => ({ bundles })),
    set: vi.fn(async () => undefined),
    notifyAppReady: vi.fn(async () => ({ bundle: current })),
    addListener: vi.fn(async (event: string, listener: (event: { bundle: Bundle }) => void) => {
      if (event === "updateAvailable") updateAvailable = listener;
      return { remove: async () => undefined };
    }),
    emitUpdateAvailable: (next: Bundle) => updateAvailable?.({ bundle: next }),
  };
  return plugin;
}

beforeEach(() => {
  mocks.native = true;
  mocks.storage.clear();
  mocks.appListeners.clear();
  resetOverTheAirForTests();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mocks.storage.get(key) ?? null,
    setItem: (key: string, value: string) => void mocks.storage.set(key, value),
    removeItem: (key: string) => void mocks.storage.delete(key),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("over-the-air bundle choice", () => {
  it("applies only a downloaded bundle that is not already running", () => {
    expect(bundleToApply("b1", "builtin", [bundle("b1", "pending")])).toBe("b1");
    expect(bundleToApply("b1", "builtin", [bundle("b1", "success")])).toBe("b1");
    expect(bundleToApply("b1", "b1", [bundle("b1", "success")])).toBeNull();
    expect(bundleToApply(null, "builtin", [bundle("b1")])).toBeNull();
    expect(bundleToApply("builtin", "b1", [bundle("builtin", "success")])).toBeNull();
  });

  it("drops bundles that failed, are still downloading, or were deleted", () => {
    for (const status of ["error", "downloading", "deleted", "deleting"] as const) {
      expect(bundleToApply("b1", "builtin", [bundle("b1", status)])).toBeNull();
    }
    expect(bundleToApply("gone", "builtin", [bundle("b1")])).toBeNull();
  });
});

describe("startup", () => {
  it("remembers a downloaded bundle and switches to it on the next cold start", async () => {
    const first = fakeUpdater(bundle("builtin", "success"), [bundle("b1")]);
    await startOverTheAirUpdates(first as never);
    expect(first.set).not.toHaveBeenCalled();
    expect(isOverTheAirBundle()).toBe(false);
    first.emitUpdateAvailable(bundle("b1"));

    resetOverTheAirForTests();
    const second = fakeUpdater(bundle("builtin", "success"), [bundle("b1")]);
    await startOverTheAirUpdates(second as never);
    expect(second.set).toHaveBeenCalledWith({ id: "b1" });
    expect(mocks.storage.size).toBe(0);
  });

  it("reports the running bundle once the new bundle has started", async () => {
    mocks.storage.set("parkdex.ota.pending-bundle", "b1");
    const plugin = fakeUpdater(bundle("b1", "pending"), [bundle("b1")]);
    await startOverTheAirUpdates(plugin as never);
    expect(plugin.set).not.toHaveBeenCalled();
    expect(isOverTheAirBundle()).toBe(true);
    expect(overTheAirBundleLabel()).toBe("v-b1");
    expect(mocks.storage.size).toBe(0);
  });

  it("never switches to a bundle that failed to start", async () => {
    mocks.storage.set("parkdex.ota.pending-bundle", "b1");
    const plugin = fakeUpdater(bundle("builtin", "success"), [bundle("b1", "error")]);
    await startOverTheAirUpdates(plugin as never);
    expect(plugin.set).not.toHaveBeenCalled();
    expect(mocks.storage.size).toBe(0);
  });

  it("does not reload on a short trip to the camera, but does after a long time away", async () => {
    vi.useFakeTimers();
    const plugin = fakeUpdater(bundle("builtin", "success"), [bundle("b1")]);
    await startOverTheAirUpdates(plugin as never);
    plugin.emitUpdateAvailable(bundle("b1"));

    mocks.appListeners.get("pause")!();
    vi.advanceTimersByTime(60_000);
    mocks.appListeners.get("resume")!();
    await vi.runOnlyPendingTimersAsync();
    expect(plugin.set).not.toHaveBeenCalled();

    mocks.appListeners.get("pause")!();
    vi.advanceTimersByTime(31 * 60_000);
    mocks.appListeners.get("resume")!();
    await vi.waitFor(() => expect(plugin.set).toHaveBeenCalledWith({ id: "b1" }));
  });

  it("does nothing on the web", async () => {
    mocks.native = false;
    await startOverTheAirUpdates();
    expect(isOverTheAirBundle()).toBe(false);
    expect(mocks.appListeners.size).toBe(0);
  });

  it("never throws when the plugin fails", async () => {
    const plugin = fakeUpdater(bundle("builtin", "success"), []);
    plugin.current.mockRejectedValue(new Error("bridge down"));
    await expect(startOverTheAirUpdates(plugin as never)).resolves.toBeUndefined();
  });
});
