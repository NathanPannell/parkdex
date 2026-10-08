import { InteractionOutbox } from "./interactions/outbox";

/**
 * Labels the app sends on every API call so the server can attribute its database reads and
 * writes: the installation, the app version and the web bundle that is running. They are
 * analytics labels only; the server validates them and never uses them for access decisions.
 */

export const INSTALLATION_HEADER = "X-Kip-Installation-Id";
export const APP_VERSION_HEADER = "X-Kip-App-Version";
export const BUNDLE_ID_HEADER = "X-Kip-Bundle-Id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_VERSION = /^[A-Za-z0-9.+_-]{1,64}$/;
const BUNDLE_ID = /^[A-Za-z0-9._-]{1,80}$/;

let installationId: string | null = null;
let installationLoad: Promise<string | null> | null = null;
let nativeBuild: number | null = null;
let bundleOverride: string | null = null;

/** Read (or create) the installation ID once; later calls reuse the same answer. */
export function loadInstallationId(outbox: Pick<InteractionOutbox, "getInstallationId"> = new InteractionOutbox()): Promise<string | null> {
  installationLoad ??= outbox.getInstallationId()
    .then((value) => {
      installationId = UUID.test(value) ? value.toLowerCase() : null;
      return installationId;
    })
    .catch(() => null);
  return installationLoad;
}

export function currentInstallationId(): string | null {
  return installationId;
}

/** The Android version code, once known, so versions read like `0.1.0+42`. */
export function setNativeBuild(build: number | null): void {
  nativeBuild = build !== null && Number.isSafeInteger(build) && build > 0 ? build : null;
}

/** An over-the-air updater can report the bundle it loaded; otherwise the build's own revision. */
export function setRequestBundleId(value: string | null): void {
  bundleOverride = value !== null && BUNDLE_ID.test(value) ? value : null;
}

export function appVersionLabel(): string | null {
  const base = typeof __APP_VERSION__ === "undefined" ? null : __APP_VERSION__;
  if (!base) return null;
  const value = nativeBuild ? `${base}+${nativeBuild}` : base;
  return APP_VERSION.test(value) ? value : null;
}

export function bundleIdLabel(): string | null {
  if (bundleOverride) return bundleOverride;
  const build = typeof __APP_BUILD__ === "undefined" ? null : __APP_BUILD__;
  return build && BUNDLE_ID.test(build) ? build : null;
}

export function requestContextHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (installationId) headers[INSTALLATION_HEADER] = installationId;
  const version = appVersionLabel();
  if (version) headers[APP_VERSION_HEADER] = version;
  const bundle = bundleIdLabel();
  if (bundle) headers[BUNDLE_ID_HEADER] = bundle;
  return headers;
}

/** Add the labels to a request's headers without replacing any the caller set. */
export function withRequestContext(headers: Headers): Headers {
  for (const [name, value] of Object.entries(requestContextHeaders())) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

/** Test hook: forget the cached installation and build labels. */
export function resetRequestContextForTests(): void {
  installationId = null;
  installationLoad = null;
  nativeBuild = null;
  bundleOverride = null;
}
