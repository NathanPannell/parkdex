import type { ApiPointer, AppConfigPlatform, AppConfigStore, BuildConfigInput, BuildConfigRecord, UpdateRules } from "../../../worker/appConfig.js";
import { APP_BUNDLE_POINTER_SCHEMA, bundleUrlFor, type AppBundleChannel } from "../../../worker/appUpdates.js";
import { FakeBundleCloud, MemoryOtaHistory } from "./fakeCloud.js";
import type { OtaAction } from "./history.js";
import { bundleVersion, CDN_ORIGIN, pointerKey } from "./ota.js";
import { createCloudflareR2 } from "./r2.js";
import type { AppDependencies } from "./routes.js";

/** In-memory build config store for tests and the local demo server. Never used by a deployment. */

export class MemoryAppConfigStore implements AppConfigStore {
  readonly rows = new Map<string, BuildConfigRecord>();

  async resolve(platform: AppConfigPlatform, build: number) {
    return [...this.rows.values()].filter((row) => row.platform === platform && (row.build === build || row.build === 0));
  }

  async list() {
    return [...this.rows.values()].sort((a, b) => a.platform.localeCompare(b.platform) || b.build - a.build);
  }

  async upsert(platform: AppConfigPlatform, build: number, input: BuildConfigInput) {
    const record = { platform, build, ...input, updatedAt: new Date().toISOString() };
    this.rows.set(`${platform}:${build}`, record);
    return record;
  }

  async remove(platform: AppConfigPlatform, build: number) {
    return this.rows.delete(`${platform}:${build}`);
  }

  readonly rules = new Map<ApiPointer, UpdateRules>();

  async updateRules(environment: ApiPointer) {
    return this.rules.get(environment) ?? { environment, minimumBuild: null, latestBuild: null, updatedAt: null };
  }

  async listUpdateRules() {
    return Promise.all((["production", "staging"] as const).map((environment) => this.updateRules(environment)));
  }

  async setUpdateRules(environment: ApiPointer, minimumBuild: number | null, latestBuild: number | null) {
    const rules = { environment, minimumBuild, latestBuild, updatedAt: new Date().toISOString() };
    this.rules.set(environment, rules);
    return rules;
  }
}

/** Fictional build rows so the section can be explored without a database. */
export function demoApp(): AppDependencies {
  const builds = new MemoryAppConfigStore();
  void builds.upsert("android", 0, {
    label: "Default",
    apiPointer: "production",
    flags: { mapDownloads: false },
    notes: "Applies to every Android build without its own row.",
  });
  // Build 12 still carries a retired flag, as older rows in production do.
  void builds.upsert("android", 12, { label: "1.4 closed test", apiPointer: "staging", flags: { parkProposals: true, mapDownloads: true }, notes: "" });
  void builds.setUpdateRules("production", 9, 11);
  void builds.setUpdateRules("staging", null, 12);
  return { appConfigStore: () => builds, ...demoOta(process.env.OPERATOR_DEMO_OTA === "empty") };
}

/** Credentials the fake Cloudflare API accepts. They only ever reach FakeBundleCloud. */
export const FAKE_CLOUDFLARE = { CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: "c".repeat(32) };

const hours = (count: number) => new Date(Date.now() - count * 3_600_000).toISOString();

/**
 * Over-the-air sample state. By default both channels are live with a short history. With
 * OPERATOR_DEMO_OTA=empty it matches production before the first publish: no bundles, and a CDN
 * worker that predates app-bundles/.
 */
export function demoOta(empty = false): AppDependencies {
  const cloud = new FakeBundleCloud();
  const history = new MemoryOtaHistory();
  if (empty) {
    cloud.servesAppBundles = false;
  } else {
    const bundles = [
      { sha256: "3f9c".repeat(16), commit: "a41c2e09b7d35f6e8c1a2b3c4d5e6f708192a3b4", size: 11_955_431, uploaded: hours(400), min: 12, max: 12 },
      { sha256: "8d21".repeat(16), commit: "0b68799d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b", size: 12_031_118, uploaded: hours(150), min: 12, max: 13 },
      { sha256: "c7e4".repeat(16), commit: "e5d03187a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4", size: 12_104_966, uploaded: hours(20), min: 13, max: 14 },
    ];
    for (const bundle of bundles) cloud.put(`app-bundles/${bundle.sha256}.zip`, new Uint8Array(bundle.size), bundle.uploaded);
    let generation: Record<AppBundleChannel, number> = { staging: 0, production: 0 };
    const previous: Record<AppBundleChannel, string | null> = { staging: null, production: null };
    const publish = (channel: AppBundleChannel, index: number, at: number, action: OtaAction, source: "script" | "dashboard", note: string) => {
      const bundle = bundles[index];
      generation = { ...generation, [channel]: generation[channel] + 1 };
      const pointer = {
        schema: APP_BUNDLE_POINTER_SCHEMA,
        channel,
        generation: generation[channel],
        version: bundleVersion(bundle.commit, bundle.sha256),
        bundleUrl: bundleUrlFor(CDN_ORIGIN, bundle.sha256),
        sha256: bundle.sha256,
        byteSize: bundle.size,
        minimumNativeBuild: bundle.min,
        maximumNativeBuild: bundle.max,
        sourceCommit: bundle.commit,
        publishedAt: hours(at),
      };
      cloud.put(pointerKey(channel), `${JSON.stringify(pointer, null, 2)}\n`, hours(at));
      void history.record(
        {
          channel,
          generation: pointer.generation,
          previousGeneration: pointer.generation - 1,
          action,
          source,
          sha256: bundle.sha256,
          previousSha256: previous[channel],
          version: pointer.version,
          byteSize: bundle.size,
          minimumNativeBuild: bundle.min,
          maximumNativeBuild: bundle.max,
          sourceCommit: bundle.commit,
          outcome: "confirmed",
          note,
          publishedAt: hours(at),
        },
        hours(at),
      );
      previous[channel] = bundle.sha256;
    };
    publish("staging", 0, 399, "publish", "script", "First over-the-air bundle");
    publish("staging", 1, 149, "publish", "script", "Map first paint fix");
    publish("production", 1, 100, "promote", "dashboard", "Checked on staging for two days");
    publish("staging", 2, 19, "publish", "script", "Founders card layout");
  }
  return {
    otaFetch: cloud.fetch,
    otaHistoryStore: () => history,
    otaR2: (env) => createCloudflareR2({ ...env, ...FAKE_CLOUDFLARE }, cloud.fetch),
  };
}
