import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { bakedApiPointer, setApiPointerOverride, type ApiPointer } from "./apiPointer";
import { setContentChannelOverride, type ContentChannel } from "./contentChannel";
import { getNativePackageInstallInfo } from "./native";
import { setRankProgressionEnabled } from "./progression";
import { KIP_PRODUCTION_ORIGIN } from "./userDataDestination";
import { bakedAnalyticsConfig, parseRemoteAnalytics, startProductAnalytics, type ProductAnalyticsConfig } from "./productAnalytics";
import { loadInstallationId, requestContextHeaders, setNativeBuild } from "./requestContext";

/**
 * Remote per-build configuration. Every build checks in with the production API
 * (`/api/app-config`) to learn which server it talks to (its API pointer) and which features
 * are on. A fresh answer is saved and takes effect on the next launch, so nothing switches
 * mid-session. Update prompts apply as soon as they are known. Offline or before the first
 * check-in, the build uses its own defaults below.
 */

/** Every remotely controlled feature this build reads, and its built-in default. */
export const FEATURE_FLAG_DEFAULTS = Object.freeze({
  rankProgression: false,
  parkProposals: true,
  /** Crew flags (#170, #171): the protected hour, crew codes and joining. Off until the operator turns it on. */
  crews: false,
  /** Friends by QR code and the weekly friends board (#64). Off until the operator turns it on. */
  friends: false,
  /** Crew flags (#170, #171): the protected hour, crew codes and joining. Off until the operator turns it on. */
  crews: false,
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
  /** The server this build should use; null keeps the one it was built for. */
  apiPointer: ApiPointer | null;
  contentChannel: ContentChannel | null;
  flags: FeatureFlags;
  /** Every flag the server sent, including ones this build does not read yet. */
  remoteFlags: Record<string, boolean>;
  update: UpdateStatus;
  /** PostHog settings from the server; null keeps analytics off unless the build has its own key. */
  analytics: ProductAnalyticsConfig | null;
  /** When this configuration was fetched; null for built-in defaults. */
  fetchedAt: string | null;
};

type RemoteAppConfig = {
  schema: "parkdex.app-config/v1";
  platform: AppPlatform;
  build: number;
  apiPointer: ApiPointer | null;
  contentChannel: ContentChannel | null;
  flags: Record<string, boolean>;
  update: UpdateStatus;
  analytics: ProductAnalyticsConfig | null;
};

const CACHE_KEY = "parkdex.app-config.v1";
/** The server applied at the last launch, so a change can sign the player out of the old one first. */
const APPLIED_SERVER_KEY = "parkdex.api-pointer.applied";
const FLAG_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const CHECK_IN_TIMEOUT_MS = 8_000;
const BUILD_INFO_TIMEOUT_MS = 1_500;
// Long enough for the IndexedDB read on a warm start, short enough not to delay first paint.
const INSTALLATION_WAIT_MS = 250;

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

/** Update prompts apply as soon as they are known, unlike the pointer and flags. */
export function currentUpdateStatus(): UpdateStatus {
  return updateStatus;
}

export function subscribeUpdateStatus(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

function defaults(info: { platform: AppPlatform; build: number }): AppConfig {
  return { ...info, apiPointer: null, contentChannel: null, flags: { ...FEATURE_FLAG_DEFAULTS }, remoteFlags: {}, update: "none", analytics: null, fetchedAt: null };
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
  // Older servers only send a content channel, which then decides the pointer too.
  const pointer = "apiPointer" in body ? body.apiPointer ?? null : channel === "main" ? "production" : channel;
  if (pointer !== null && pointer !== "production" && pointer !== "staging") return null;
  const flags: Record<string, boolean> = {};
  if (typeof body.flags === "object" && body.flags !== null && !Array.isArray(body.flags)) {
    for (const [key, flag] of Object.entries(body.flags as Record<string, unknown>)) {
      if (FLAG_NAME.test(key) && typeof flag === "boolean") flags[key] = flag;
    }
  }
  // Older servers omit `update`; anything unrecognised never blocks the app.
  const update: UpdateStatus = body.update === "required" || body.update === "available" ? body.update : "none";
  return {
    schema: "parkdex.app-config/v1",
    platform: expected.platform,
    build: expected.build,
    apiPointer: pointer as ApiPointer | null,
    contentChannel: channel,
    flags,
    update,
    // Older servers send no analytics block, which keeps the app's analytics off.
    analytics: parseRemoteAnalytics(body.analytics),
  };
}

function toAppConfig(remote: RemoteAppConfig, fetchedAt: string): AppConfig {
  const flags = { ...FEATURE_FLAG_DEFAULTS } as FeatureFlags;
  for (const key of Object.keys(FEATURE_FLAG_DEFAULTS) as FeatureFlag[]) {
    if (typeof remote.flags[key] === "boolean") flags[key] = remote.flags[key];
  }
  return {
    platform: remote.platform,
    build: remote.build,
    apiPointer: remote.apiPointer,
    contentChannel: remote.contentChannel,
    flags,
    remoteFlags: { ...remote.flags },
    update: remote.update,
    analytics: remote.analytics,
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

/**
 * Accounts belong to one server. When the pointer moves this build to the other server, sign
 * the player out locally first so the old session is never sent to the new one. Progress saved
 * on the device is kept.
 */
async function signOutIfServerChanged(server: ApiPointer): Promise<void> {
  let previous: string | null;
  try {
    previous = globalThis.localStorage?.getItem(APPLIED_SERVER_KEY) ?? null;
  } catch {
    return;
  }
  if (previous !== null && previous !== server) {
    try {
      const { clearLocalNativeSession } = await import("./accounts/authClient");
      await clearLocalNativeSession();
    } catch {
      // A session the new server rejects is treated as signed out anyway.
    }
  }
  try {
    globalThis.localStorage?.setItem(APPLIED_SERVER_KEY, server);
  } catch {
    // Without storage there is no previous server to compare against.
  }
}

/** Wait for work up to a limit without leaving a timer behind. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise((resolve) => { timeout = setTimeout(resolve, ms); })]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Apply the saved configuration for this build before the app renders. Never throws. */
export async function initAppConfig(): Promise<AppConfig> {
  const installation = loadInstallationId();
  buildInfo = await readBuildInfo();
  setNativeBuild(buildInfo?.platform === "android" ? buildInfo.build : null);
  const defaultsInfo = buildInfo ?? { platform: "android" as const, build: 0 };
  active = buildInfo ? readCache(buildInfo) ?? defaults(buildInfo) : defaults(defaultsInfo);
  // Only native production and staging builds switch servers; web pages always use their own host.
  const baked = bakedApiPointer();
  const pointer = buildInfo?.platform === "android" && baked && active.apiPointer && active.apiPointer !== baked
    ? active.apiPointer
    : null;
  if (buildInfo?.platform === "android" && baked) await signOutIfServerChanged(pointer ?? baked);
  setApiPointerOverride(pointer);
  setContentChannelOverride(pointer === "production" ? "main" : pointer === "staging" ? "staging" : null);
  setRankProgressionEnabled(active.flags.rankProgression);
  setUpdateStatus(active.platform === "android" ? active.update : "none");
  await settleWithin(installation, INSTALLATION_WAIT_MS);
  void startProductAnalytics(active.analytics ?? bakedAnalyticsConfig());
  return active;
}

export function activeAppConfig(): AppConfig {
  return active;
}

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return active.flags[flag];
}

/** Any flag the server sent, for features newer than the list above. */
export function remoteFlag(name: string): boolean | undefined {
  return active.remoteFlags[name];
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
    setNativeBuild(recovered.platform === "android" ? recovered.build : null);
    // A late device-info recovery may update build identity and the update gate only.
    active = { ...active, platform: recovered.platform, build: recovered.build };
    const cached = readCache(recovered);
    if (cached && recovered.platform === "android") setUpdateStatus(cached.update);
  }
  const currentBuildInfo = buildInfo;
  const url = new URL("/api/app-config", origin);
  url.searchParams.set("platform", currentBuildInfo.platform);
  url.searchParams.set("build", String(currentBuildInfo.build));
  // The server applies the update rules of the environment this build was made for.
  const baked = bakedApiPointer();
  if (baked) url.searchParams.set("env", baked);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_IN_TIMEOUT_MS);
  try {
    // Labels go only to the page's own host: a cross-origin check-in (native builds ask
    // production) would need a CORS preflight that servers older than these labels reject.
    const sameOrigin = typeof location !== "undefined" && location.origin === origin;
    const headers = sameOrigin ? requestContextHeaders() : undefined;
    const response = await fetcher(url.href, { credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal, headers });
    if (!response.ok) return null;
    const remote = parseRemoteAppConfig(await response.json(), currentBuildInfo);
    if (!remote) return null;
    const fetchedAt = new Date().toISOString();
    writeCache(remote, fetchedAt);
    if (currentBuildInfo.platform === "android") setUpdateStatus(remote.update);
    // Analytics may start as soon as a key is known; it never switches servers mid-session.
    if (remote.analytics) void startProductAnalytics(remote.analytics);
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
