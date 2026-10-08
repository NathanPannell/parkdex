import type { PostHog } from "posthog-js";
import { Capacitor } from "@capacitor/core";
import { apiEnvironment } from "./apiPointer";
import { appVersionLabel, bundleIdLabel, currentInstallationId, loadInstallationId } from "./requestContext";

/**
 * Optional PostHog product analytics in the app. The SDK is only downloaded and started when a
 * public project key is known, from the server's app config (switchable without a new build)
 * or, failing that, from VITE_POSTHOG_PROJECT_KEY. Without a key nothing loads and nothing is sent.
 */

export type ProductAnalyticsConfig = { key: string; host: string };

const DEFAULT_HOST = "https://us.i.posthog.com";
const KEY = /^[A-Za-z0-9_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let client: PostHog | null = null;
let starting: Promise<void> | null = null;
// The latest sign-in state, applied once the SDK loads; undefined until sign-in has resolved.
let wantedAccount: string | null | undefined;
let identifiedAccount: string | null = null;

function validHost(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_HOST;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

function config(key: unknown, host: unknown): ProductAnalyticsConfig | null {
  if (typeof key !== "string" || !KEY.test(key.trim())) return null;
  const origin = validHost(host);
  return origin ? { key: key.trim(), host: origin } : null;
}

/** The `analytics` block of an app config response, or null when it is absent or malformed. */
export function parseRemoteAnalytics(value: unknown): ProductAnalyticsConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return config(body.posthogKey, body.posthogHost);
}

export function bakedAnalyticsConfig(): ProductAnalyticsConfig | null {
  return config(import.meta.env.VITE_POSTHOG_PROJECT_KEY, import.meta.env.VITE_POSTHOG_HOST);
}

/** PostHog speaks of production; content and API pointers call it `main`. */
function environmentLabel(): string {
  const value = apiEnvironment();
  return value === "main" ? "production" : value ?? "development";
}

function applyIdentity(): void {
  if (!client || wantedAccount === undefined || wantedAccount === identifiedAccount) return;
  if (wantedAccount) client.identify(wantedAccount);
  else client.reset();
  identifiedAccount = wantedAccount;
}

/** A persisted identity from an earlier signed-in launch is dropped if this launch is signed out. */
function adoptPersistedIdentity(posthog: PostHog): void {
  identifiedAccount = posthog.get_property("$user_state") === "identified" ? posthog.get_distinct_id() : null;
}

/** Start the SDK once. Later calls, including with another key, keep the running instance. */
export function startProductAnalytics(settings: ProductAnalyticsConfig | null, load: () => Promise<{ default: PostHog }> = () => import("posthog-js")): Promise<void> {
  if (!settings || typeof window === "undefined") return Promise.resolve();
  starting ??= (async () => {
    try {
      const installationId = currentInstallationId() ?? await loadInstallationId();
      const { default: posthog } = await load();
      posthog.init(settings.key, {
        api_host: settings.host,
        person_profiles: "identified_only",
        autocapture: true,
        capture_pageview: true,
        // The installation ID links anonymous app events to the server's events for the same device.
        bootstrap: installationId ? { distinctID: installationId } : undefined,
        session_recording: { maskAllInputs: true },
      });
      posthog.register({
        environment: environmentLabel(),
        app_version: appVersionLabel(),
        bundle_id: bundleIdLabel(),
        installation_id: installationId,
        platform: Capacitor.getPlatform(),
        source: "app",
      });
      client = posthog;
      adoptPersistedIdentity(posthog);
      applyIdentity();
    } catch {
      // Analytics must never affect the app; a failed load simply leaves it off.
    }
  })();
  return starting;
}

/** Identify by account ID after sign-in, and reset to anonymous after sign-out. */
export function setProductAnalyticsAccount(accountId: string | null): void {
  wantedAccount = accountId && UUID.test(accountId) ? accountId.toLowerCase() : null;
  try {
    applyIdentity();
  } catch {
    // Identity updates are best effort.
  }
}

/** Test hook: forget the running instance. */
export function resetProductAnalyticsForTests(): void {
  client = null;
  starting = null;
  wantedAccount = undefined;
  identifiedAccount = null;
}
