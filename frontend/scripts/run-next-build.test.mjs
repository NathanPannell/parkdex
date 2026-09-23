import { describe, expect, it } from "vitest";

import { shouldRestoreScopedAssets } from "./run-next-build.mjs";

describe("scoped Next build cleanup", () => {
  it("restores canonical and ordinary staging builds", () => {
    expect(shouldRestoreScopedAssets({}, "canonical")).toBe(true);
    expect(shouldRestoreScopedAssets({}, "staging")).toBe(true);
    expect(shouldRestoreScopedAssets({ PARKDEX_KEEP_SCOPED_ASSETS: "0" }, "staging")).toBe(true);
  });

  it("keeps only explicit staging assets for the disposable Vercel build", () => {
    expect(shouldRestoreScopedAssets({ PARKDEX_KEEP_SCOPED_ASSETS: "1" }, "staging")).toBe(false);
    expect(shouldRestoreScopedAssets({ PARKDEX_KEEP_SCOPED_ASSETS: " 1 " }, "staging")).toBe(false);
    expect(shouldRestoreScopedAssets({ PARKDEX_KEEP_SCOPED_ASSETS: "1" }, "canonical")).toBe(true);
  });
});
