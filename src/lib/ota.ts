import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type { BundleInfo, CapacitorUpdaterPlugin } from "@capgo/capacitor-updater";

/**
 * Over-the-air web bundles on Android (`@capgo/capacitor-updater`, self-hosted at `/api/updates`).
 *
 * The plugin checks and downloads in the background ("onlyDownload"). This module applies a
 * downloaded bundle at the next cold start, or on return after a long time in the background,
 * so the page never reloads while the camera, sign-in or share sheet has the app backgrounded.
 * Web builds never load the plugin.
 */

type Updater = Pick<CapacitorUpdaterPlugin, "current" | "list" | "set" | "notifyAppReady" | "addListener">;
type BundleSummary = Pick<BundleInfo, "id" | "version" | "status">;

const PENDING_KEY = "parkdex.ota.pending-bundle";
/** Long enough that a camera or sign-in round trip has finished. */
const LONG_BACKGROUND_MS = 30 * 60_000;
const APPLY_TIMEOUT_MS = 5_000;
const BUILTIN = "builtin";

// The plugin is a Capacitor proxy that answers every property, including `then`, so it is kept
// inside a plain object: resolving a promise with the proxy itself would call `proxy.then()`.
let updater: Promise<{ plugin: Updater } | null> | null = null;
let current: BundleSummary | null = null;

function loadUpdater(): Promise<{ plugin: Updater } | null> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("CapacitorUpdater")) return Promise.resolve(null);
  updater ??= import("@capgo/capacitor-updater").then((module) => ({ plugin: module.CapacitorUpdater as Updater })).catch(() => null);
  return updater;
}

function readPending(): string | null {
  try {
    return globalThis.localStorage?.getItem(PENDING_KEY) ?? null;
  } catch {
    return null;
  }
}

function writePending(id: string | null): void {
  try {
    if (id) globalThis.localStorage?.setItem(PENDING_KEY, id);
    else globalThis.localStorage?.removeItem(PENDING_KEY);
  } catch {
    // Without storage a downloaded bundle waits for the plugin to offer it again.
  }
}

/** Which downloaded bundle to switch to now, if any. Error or missing bundles are dropped. */
export function bundleToApply(pendingId: string | null, currentId: string | null, bundles: BundleSummary[]): string | null {
  if (!pendingId || pendingId === BUILTIN || pendingId === currentId) return null;
  const bundle = bundles.find((candidate) => candidate.id === pendingId);
  return bundle && (bundle.status === "pending" || bundle.status === "success") ? bundle.id : null;
}

async function applyPending(plugin: Updater): Promise<void> {
  const pendingId = readPending();
  if (!pendingId) return;
  const { bundles } = await plugin.list();
  const id = bundleToApply(pendingId, current?.id ?? null, bundles);
  // Clear first: a bundle that fails to start is rolled back by the plugin and marked as error.
  writePending(null);
  if (!id) return;
  // `set` reloads the web view into the new bundle; the timeout only guards a reload that never comes.
  await Promise.race([plugin.set({ id }), new Promise((resolve) => setTimeout(resolve, APPLY_TIMEOUT_MS))]);
}

/** Runs before the first render. Never throws; on the web it does nothing. */
export async function startOverTheAirUpdates(plugin?: Updater | null): Promise<void> {
  try {
    const active = plugin === undefined ? (await loadUpdater())?.plugin : plugin;
    if (!active) return;
    current = (await active.current()).bundle;
    await applyPending(active);
    await active.addListener("updateAvailable", (event) => writePending(event.bundle.id));
    let backgroundedAt: number | null = null;
    await App.addListener("pause", () => { backgroundedAt = Date.now(); });
    await App.addListener("resume", () => {
      const away = backgroundedAt === null ? 0 : Date.now() - backgroundedAt;
      backgroundedAt = null;
      if (away >= LONG_BACKGROUND_MS) void applyPending(active).catch(() => undefined);
    });
  } catch {
    // Updates are optional; the built-in or current bundle keeps working.
  }
}

/**
 * Tell the plugin this bundle started. Called once the app shell has rendered, so a bundle that
 * cannot render is rolled back, and a good one is never rolled back by the 15 s timeout.
 */
export function notifyOverTheAirReady(): void {
  void loadUpdater().then((loaded) => loaded?.plugin.notifyAppReady()).catch(() => undefined);
}

/** True when this page runs a downloaded bundle rather than the one inside the APK. */
export function isOverTheAirBundle(): boolean {
  return current !== null && current.id !== BUILTIN;
}

/** A short label for bug reports, such as `1234567-aaaaaaaa`, or null for the built-in bundle. */
export function overTheAirBundleLabel(): string | null {
  return isOverTheAirBundle() ? current!.version : null;
}

/** Test hook: forget module state between tests. */
export function resetOverTheAirForTests(): void {
  updater = null;
  current = null;
}
