import { describe, expect, it } from "vitest";
import { onboardingMatchesInstall, packageInstallIdentity } from "./onboardingIdentity";

const installed = {
  packageName: "app.parkdex",
  firstInstallTime: 1_790_000_000_000,
  lastUpdateTime: 1_790_000_000_000,
  versionCode: 12,
};

describe("onboarding install identity", () => {
  it("serializes package install, update, and version details", () => {
    expect(packageInstallIdentity(installed)).toBe("app.parkdex:1790000000000:1790000000000:12");
  });

  it("rejects incomplete native package information", () => {
    expect(packageInstallIdentity({ ...installed, lastUpdateTime: Number.NaN })).toBeNull();
    expect(packageInstallIdentity({ ...installed, packageName: "app/parkdex" })).toBeNull();
  });

  it("reuses onboarding completion on the same build and install", () => {
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: "source-sha", packageInstallIdentity: packageInstallIdentity(installed) },
        { buildId: "source-sha", packageInstallIdentity: packageInstallIdentity(installed), native: true },
      ),
    ).toBe(true);
  });

  it("replays after a source build changes", () => {
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: "old-source-sha", packageInstallIdentity: packageInstallIdentity(installed) },
        { buildId: "new-source-sha", packageInstallIdentity: packageInstallIdentity(installed), native: true },
      ),
    ).toBe(false);
  });

  it("keeps onboarding when an over-the-air bundle changes the source build", () => {
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: "builtin-source-sha", packageInstallIdentity: packageInstallIdentity(installed) },
        { buildId: "ota-source-sha", packageInstallIdentity: packageInstallIdentity(installed), native: true, overTheAir: true },
      ),
    ).toBe(true);
  });

  it("still replays after an over-the-air bundle when the package was updated or reinstalled", () => {
    const afterUpdate = packageInstallIdentity({ ...installed, lastUpdateTime: installed.lastUpdateTime + 1000, versionCode: 13 });
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: "builtin-source-sha", packageInstallIdentity: packageInstallIdentity(installed) },
        { buildId: "ota-source-sha", packageInstallIdentity: afterUpdate, native: true, overTheAir: true },
      ),
    ).toBe(false);
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: "builtin-source-sha", packageInstallIdentity: packageInstallIdentity(installed) },
        { buildId: "ota-source-sha", packageInstallIdentity: null, native: true, overTheAir: true },
      ),
    ).toBe(false);
  });

  it("replays after an Android package update built from the same SHA", () => {
    const beforeUpdate = packageInstallIdentity(installed);
    const afterUpdate = packageInstallIdentity({ ...installed, lastUpdateTime: installed.lastUpdateTime + 1000, versionCode: 13 });
    expect(beforeUpdate).not.toBe(afterUpdate);
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: "same-source-sha", packageInstallIdentity: beforeUpdate },
        { buildId: "same-source-sha", packageInstallIdentity: afterUpdate, native: true },
      ),
    ).toBe(false);
  });

  it("replays after reinstalling the same build and package version", () => {
    const beforeReinstall = packageInstallIdentity(installed);
    const afterReinstall = packageInstallIdentity({
      ...installed,
      firstInstallTime: installed.firstInstallTime + 5000,
      lastUpdateTime: installed.firstInstallTime + 5000,
    });
    expect(beforeReinstall).not.toBe(afterReinstall);
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: "same-source-sha", packageInstallIdentity: beforeReinstall },
        { buildId: "same-source-sha", packageInstallIdentity: afterReinstall, native: true },
      ),
    ).toBe(false);
  });

  it("replays when native installation details are unavailable", () => {
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: "source-sha", packageInstallIdentity: null },
        { buildId: "source-sha", packageInstallIdentity: null, native: true },
      ),
    ).toBe(false);
  });

  it("keeps web onboarding across deploys, which change the build on every release", () => {
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: "old-source-sha", packageInstallIdentity: null },
        { buildId: "new-source-sha", packageInstallIdentity: null, native: false },
      ),
    ).toBe(true);
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: null, packageInstallIdentity: null },
        { buildId: "new-source-sha", packageInstallIdentity: null, native: false },
      ),
    ).toBe(true);
    expect(
      onboardingMatchesInstall(
        { onboarded: false, buildId: "source-sha", packageInstallIdentity: null },
        { buildId: "source-sha", packageInstallIdentity: null, native: false },
      ),
    ).toBe(false);
  });

  it("allows web onboarding completion to persist without a native package identity", () => {
    expect(
      onboardingMatchesInstall(
        { onboarded: true, buildId: "source-sha", packageInstallIdentity: null },
        { buildId: "source-sha", packageInstallIdentity: null, native: false },
      ),
    ).toBe(true);
  });
});
