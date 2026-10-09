import type { ApiPointer, AppConfigPlatform, AppConfigStore, BuildConfigInput, BuildConfigRecord, UpdateRules } from "../../../worker/appConfig.js";
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
  void builds.upsert("android", 0, { label: "Default", apiPointer: "production", flags: { mapDownloads: false }, notes: "Applies to every Android build without its own row." });
  // Build 12 still carries a retired flag, as older rows in production do.
  void builds.upsert("android", 12, { label: "1.4 closed test", apiPointer: "staging", flags: { parkProposals: true, mapDownloads: true }, notes: "" });
  void builds.setUpdateRules("production", 9, 11);
  void builds.setUpdateRules("staging", null, 12);
  return { appConfigStore: () => builds };
}
