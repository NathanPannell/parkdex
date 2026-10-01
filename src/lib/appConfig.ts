import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { setContentChannelOverride, type ContentChannel } from "./contentChannel";
import { getNativePackageInstallInfo } from "./native";
import { setRankProgressionEnabled } from "./progression";
import { KIP_PRODUCTION_ORIGIN } from "./userDataDestination";

/**
 * Remote per-build configuration. Every build checks in with the production API
 * (`/api/app-config`) to learn which content database it reads and which features are on.
 * A fresh answer is saved and takes effect on the next launch, so nothing switches mid-session.
 * Offline or before the first check-in, the build uses its own defaults below.
 */

/** Every remotely controlled feature and its built-in default. Keep in step with `worker/appConfig.ts`. */
export const FEATURE_FLAG_DEFAULTS = Object.freeze({
  rankProgression: true,
  parkProposals: true,
});
export type FeatureFlag = keyof typeof FEATURE_FLAG_DEFAULTS;
export type FeatureFlags = Record<FeatureFlag, boolean>;
export type AppPlatform = "android" | "web";
/** Whether this build must, or could, update from the store. */
export type UpdateStatus = "required" | "available" | "none";

export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=app.parkdex";

export type AppConfig = {
  platform: AppPlatform;
  build: number;
  contentChannel: ContentChannel | null;
  flags: FeatureFlags;
  update: UpdateStatus;
  /** When this configuration was fetched; null for built-in defaults. */
  fetchedAt: string | null;
};

type RemoteAppConfig = {
  schema: "parkdex.app-config/v1";
  platform: AppPlatform;
  build: number;
  contentChannel: ContentChannel | null;
  flags: Partial<FeatureFlags>;
  update: UpdateStatus;
};

const CACHE_KEY = "parkdex.app-config.v1";
const CHECK_IN_TIMEOUT_MS = 8_000;
const BUILD_INFO_TIMEOUT_MS = 1_500;

type BuildInfo = { platform: AppPlatform; build: number };

let buildInfo: BuildInfo | null = { platform: "web", build: 0 };
let active: AppConfig = defaults({ platform: "web", build: 0 });
let updateStatus: UpdateStatus = "none";
const updateListeners = new Set<() => void>();

function setUpdateStatus(next: UpdateStatus): void {
  if (next === updateStatus) return;
  updateStatus = next;
  for (const listener of updateListeners) listener();
}

/** Update prompts apply as soon as they are known, unlike content and flags. */
export function currentUpdateStatus(): UpdateStatus {
  return updateStatus;
}

export function subscribeUpdateStatus(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

function defaults(info: { platform: AppPlatform; build: number }): AppConfig {
  return { ...info, contentChannel: null, flags: { ...FEATURE_FLAG_DEFAULTS }, update: "none", fetchedAt: null };
}

/** The content database this build was made for. */
export function bakedContentChannel(): ContentChannel {
  return import.meta.env.VITE_CONTENT_ENV === "main" ? "main" : "staging";
}

export function parseRemoteAppConfig(value: unknown, expected: { platform: AppPlatform; build: number }): RemoteAppConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.schema !== "parkdex.app-config/v1" || body.platform !== expected.platform || body.build !== expected.build) return null;
  const channel = body.contentChannel ?? null;
  if (channel !== null && channel !== "staging" && channel !== "main") return null;
  const flags: Partial<FeatureFlags> = {};
  if (typeof body.flags === "object" && body.flags !== null && !Array.isArray(body.flags)) {
    for (const key of Object.keys(FEATURE_FLAG_DEFAULTS) as FeatureFlag[]) {
      const flag = (body.flags as Record<string, unknown>)[key];
      if (typeof flag === "boolean") flags[key] = flag;
    }
  }
  // Older servers omit `update`; anything unrecognised never blocks the app.
  const update: UpdateStatus = body.update === "required" || body.update === "available" ? body.update : "none";
  return { schema: "parkdex.app-config/v1", platform: expected.platform, build: expected.build, contentChannel: channel, flags, update };
}

function toAppConfig(remote: RemoteAppConfig, fetchedAt: string): AppConfig {
  return {
    platform: remote.platform,
    build: remote.build,
    contentChannel: remote.contentChannel,
    flags: { ...FEATURE_FLAG_DEFAULTS, ...remote.flags },
    update: remote.update,
    fetchedAt,
  };
}

function readCache(info: { platform: AppPlatform; build: number }): AppConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { config?: unknown; fetchedAt?: unknown };
    const remote = parseRemoteAppConfig(cached.config, info);
    // A cached answer for another build (for example before an app update) is ignored.
    return remote && typeof cached.fetchedAt === "string" ? toAppConfig(remote, cached.fetchedAt) : null;
  } catch {
    return null;
  }
}

function writeCache(config: RemoteAppConfig, fetchedAt: string): void {
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify({ config, fetchedAt }));
  } catch {
    // Without storage the build keeps its defaults on every launch.
  }
}

function androidBuildNumber(value: unknown): number | null {
  const build = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(build) && build > 0 ? build : null;
}

async function withBuildInfoTimeout<T>(work: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Android build information timed out")), BUILD_INFO_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readBuildInfo(): Promise<BuildInfo | null> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return { platform: "web", build: 0 };
  try {
    const info = await withBuildInfoTimeout(() => App.getInfo());
    const build = androidBuildNumber(info.build);
    if (build !== null) return { platform: "android", build };
  } catch {
    // The app plugin can be unavailable during startup. Use the package-info plugin next.
  }
  try {
    const info = await withBuildInfoTimeout(() => getNativePackageInstallInfo());
    const build = androidBuildNumber(info?.versionCode);
    if (build !== null) return { platform: "android", build };
  } catch {
    // Without a valid installed version code, avoid requesting Android build zero.
  }
  return null;
}

/** Apply the saved configuration for this build before the app renders. Never throws. */
export async function initAppConfig(): Promise<AppConfig> {
  buildInfo = await readBuildInfo();
  const defaultsInfo = buildInfo ?? { platform: "android" as const, build: 0 };
  active = buildInfo ? readCache(buildInfo) ?? defaults(buildInfo) : defaults(defaultsInfo);
  // Only native builds switch databases; a web deployment always reads its own host's content.
  const override = buildInfo?.platform === "android" && active.contentChannel && active.contentChannel !== bakedContentChannel()
    ? active.contentChannel
    : null;
  setContentChannelOverride(override);
  setRankProgressionEnabled(active.flags.rankProgression);
  setUpdateStatus(active.platform === "android" ? active.update : "none");
  return active;
}

export function activeAppConfig(): AppConfig {
  return active;
}

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return active.flags[flag];
}

/** Where builds check in. Native builds always ask production; web pages ask their own host. */
export function appConfigOrigin(): string | null {
  const configured = import.meta.env.VITE_CONFIG_API_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || (import.meta.env.DEV && url.protocol === "http:")) return url.origin;
    } catch {
      return null;
    }
    return null;
  }
  if (Capacitor.isNativePlatform()) return KIP_PRODUCTION_ORIGIN;
  return typeof location === "undefined" ? null : location.origin;
}

/** Ask the server for this build's configuration and save it for the next launch. */
export async function checkInAppConfig(fetcher: typeof fetch = globalThis.fetch): Promise<AppConfig | null> {
  const origin = appConfigOrigin();
  if (!origin) return null;
  if (!buildInfo) {
    const recovered = await readBuildInfo();
    if (!recovered) return null;
    buildInfo = recovered;
    // A late device-info recovery may update build identity and the update gate only.
    active = { ...active, platform: recovered.platform, build: recovered.build };
    const cached = readCache(recovered);
    if (cached && recovered.platform === "android") setUpdateStatus(cached.update);
  }
  const currentBuildInfo = buildInfo;
  const url = new URL("/api/app-config", origin);
  url.searchParams.set("platform", currentBuildInfo.platform);
  url.searchParams.set("build", String(currentBuildInfo.build));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_IN_TIMEOUT_MS);
  try {
    const response = await fetcher(url.href, { credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
    if (!response.ok) return null;
    const remote = parseRemoteAppConfig(await response.json(), currentBuildInfo);
    if (!remote) return null;
    const fetchedAt = new Date().toISOString();
    writeCache(remote, fetchedAt);
    if (currentBuildInfo.platform === "android") setUpdateStatus(remote.update);
    return toAppConfig(remote, fetchedAt);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Check in now and whenever the app returns to the foreground. */
export function startAppConfigCheckIns(): void {
  void checkInAppConfig();
  if (!Capacitor.isNativePlatform()) return;
  void App.addListener("resume", () => void checkInAppConfig()).catch(() => undefined);
}
