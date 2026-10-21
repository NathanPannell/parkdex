import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_VERSION_HEADER,
  BUNDLE_ID_HEADER,
  INSTALLATION_HEADER,
  loadInstallationId,
  requestContextHeaders,
  resetRequestContextForTests,
  setNativeBuild,
  setRequestBundleId,
  withRequestContext,
} from "./requestContext";

const INSTALLATION = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";

describe("request context headers", () => {
  beforeEach(() => {
    resetRequestContextForTests();
    vi.stubGlobal("__APP_VERSION__", "0.1.0");
    vi.stubGlobal("__APP_BUILD__", "abc1234");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends version and bundle before the installation is known, then the installation too", async () => {
    expect(requestContextHeaders()).toEqual({ [APP_VERSION_HEADER]: "0.1.0", [BUNDLE_ID_HEADER]: "abc1234" });
    await loadInstallationId({ getInstallationId: async () => INSTALLATION.toUpperCase() });
    expect(requestContextHeaders()[INSTALLATION_HEADER]).toBe(INSTALLATION);
  });

  it("adds the native build to the version and prefers an updater's bundle", () => {
    setNativeBuild(42);
    setRequestBundleId("ota-2026-10-07.1");
    expect(requestContextHeaders()).toMatchObject({ [APP_VERSION_HEADER]: "0.1.0+42", [BUNDLE_ID_HEADER]: "ota-2026-10-07.1" });
    setRequestBundleId("not valid!");
    expect(requestContextHeaders()[BUNDLE_ID_HEADER]).toBe("abc1234");
  });

  it("never sends malformed values and survives a storage failure", async () => {
    vi.stubGlobal("__APP_VERSION__", "1.0 beta");
    await loadInstallationId({
      getInstallationId: async () => {
        throw new Error("no IndexedDB");
      },
    });
    expect(requestContextHeaders()).toEqual({ [BUNDLE_ID_HEADER]: "abc1234" });
  });

  it("does not replace headers the caller already set", () => {
    const headers = withRequestContext(new Headers({ [APP_VERSION_HEADER]: "custom" }));
    expect(headers.get(APP_VERSION_HEADER)).toBe("custom");
    expect(headers.get(BUNDLE_ID_HEADER)).toBe("abc1234");
  });
});
