/**
 * Self-hosted update endpoint for `@capgo/capacitor-updater` (over-the-air web bundles).
 *
 * The plugin posts its device info to `POST /api/updates`. We read the channel pointer from the
 * public asset CDN (`app-bundles/channels/<channel>/current.json`) and answer in the plugin's
 * format: `{ version, url, checksum }` to offer a bundle, or `{ kind: "up_to_date", ... }`.
 *
 * Safety rules: a build only ever sees its own channel's pointer, never a bundle outside the
 * pointer's native build range, and never a pointer that fails validation.
 */

export const APP_BUNDLE_ORIGIN = "https://kip-assets.parkdex.app";
export const APP_BUNDLE_CHANNELS = ["staging", "production"] as const;
export type AppBundleChannel = (typeof APP_BUNDLE_CHANNELS)[number];
export const APP_BUNDLE_POINTER_SCHEMA = "parkdex.app-bundle-channel/v1";

/** The Play package and the sideloaded debug package beside it. */
const APP_IDS = new Set(["app.parkdex", "app.parkdex.debug"]);
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BUILD = 2_100_000_000;
const MAX_BODY_BYTES = 8 * 1024;
const POINTER_TIMEOUT_MS = 5_000;

export interface AppBundlePointer {
  schema: typeof APP_BUNDLE_POINTER_SCHEMA;
  channel: AppBundleChannel;
  generation: number;
  version: string;
  bundleUrl: string;
  sha256: string;
  byteSize: number;
  minimumNativeBuild: number;
  maximumNativeBuild: number;
  sourceCommit: string;
  publishedAt: string;
}

export interface UpdateCheck {
  appId: string;
  channel: AppBundleChannel;
  nativeBuild: number;
  currentVersion: string;
}

export type UpdateAnswer =
  | { status: 200; body: { version: string; url: string; checksum: string } }
  | { status: number; body: { kind: "up_to_date" | "failed"; error: string; message: string } };

export interface AppUpdateHandlers {
  json(data: unknown, status?: number): Response;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Origin that serves bundles and pointers. Only local QA overrides the CDN. */
  origin?: string;
}

function upToDate(error: string, message: string): UpdateAnswer {
  return { status: 200, body: { kind: "up_to_date", error, message } };
}

function failed(status: number, error: string, message: string): UpdateAnswer {
  return { status, body: { kind: "failed", error, message } };
}

function isChannel(value: unknown): value is AppBundleChannel {
  return typeof value === "string" && (APP_BUNDLE_CHANNELS as readonly string[]).includes(value);
}

function wholeBuild(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,10}$/.test(text)) return null;
  const build = Number(text);
  return build >= 1 && build <= MAX_BUILD ? build : null;
}

/** Reads only the fields the decision needs; the device ID and OS details are never kept. */
export function parseUpdateCheck(body: unknown): UpdateCheck | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (input.platform !== "android") return null;
  if (typeof input.app_id !== "string" || !APP_IDS.has(input.app_id)) return null;
  if (!isChannel(input.defaultChannel)) return null;
  const nativeBuild = wholeBuild(input.version_code);
  if (nativeBuild === null) return null;
  const currentVersion = typeof input.version_name === "string" ? input.version_name.trim() : "";
  if (currentVersion.length === 0 || currentVersion.length > 128) return null;
  return { appId: input.app_id, channel: input.defaultChannel, nativeBuild, currentVersion };
}

export function bundleUrlFor(origin: string, sha256: string): string {
  return `${origin}/app-bundles/${sha256}.zip`;
}

export function pointerUrlFor(origin: string, channel: AppBundleChannel): string {
  return `${origin}/app-bundles/channels/${channel}/current.json`;
}

/** Returns the pointer only when every field is well formed and it belongs to `channel`. */
export function validatePointer(value: unknown, channel: AppBundleChannel, origin = APP_BUNDLE_ORIGIN): AppBundlePointer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const pointer = value as Record<string, unknown>;
  if (pointer.schema !== APP_BUNDLE_POINTER_SCHEMA || pointer.channel !== channel) return null;
  if (!Number.isSafeInteger(pointer.generation) || (pointer.generation as number) < 1) return null;
  if (typeof pointer.version !== "string" || !VERSION.test(pointer.version) || pointer.version === "builtin") return null;
  if (typeof pointer.sha256 !== "string" || !SHA256.test(pointer.sha256)) return null;
  if (pointer.bundleUrl !== bundleUrlFor(origin, pointer.sha256)) return null;
  if (!Number.isSafeInteger(pointer.byteSize) || (pointer.byteSize as number) < 1) return null;
  const minimum = wholeBuild(pointer.minimumNativeBuild);
  const maximum = wholeBuild(pointer.maximumNativeBuild);
  if (minimum === null || maximum === null || minimum > maximum) return null;
  if (typeof pointer.sourceCommit !== "string" || pointer.sourceCommit.length > 64) return null;
  if (typeof pointer.publishedAt !== "string" || Number.isNaN(Date.parse(pointer.publishedAt))) return null;
  return pointer as unknown as AppBundlePointer;
}

/** The whole decision, separate from HTTP so it is easy to test. */
export function decideUpdate(check: UpdateCheck, pointer: AppBundlePointer | null): UpdateAnswer {
  if (!pointer) return upToDate("no_bundle_published", "No bundle is published on this channel.");
  if (check.nativeBuild < pointer.minimumNativeBuild || check.nativeBuild > pointer.maximumNativeBuild) {
    return upToDate("native_build_out_of_range", "The current bundle does not support this app build.");
  }
  if (check.currentVersion === pointer.version) return upToDate("no_new_version_available", "This build already runs the current bundle.");
  return { status: 200, body: { version: pointer.version, url: pointer.bundleUrl, checksum: pointer.sha256 } };
}

async function readBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const text = await request.text();
  if (text.length === 0 || text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readPointer(handlers: AppUpdateHandlers, origin: string, channel: AppBundleChannel): Promise<AppBundlePointer | null | "unavailable"> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POINTER_TIMEOUT_MS);
  try {
    const response = await handlers.fetch(pointerUrlFor(origin, channel), { method: "GET", cache: "no-store", redirect: "error", signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) return "unavailable";
    const pointer = validatePointer(await response.json(), channel, origin);
    // A malformed or foreign pointer is an operator error; never let it reach a device.
    return pointer ?? "unavailable";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
}

/** Routes `POST /api/updates`. Returns null for other paths. */
export async function handleAppUpdateRequest(request: Request, handlers: AppUpdateHandlers): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/updates") return null;
  const origin = (handlers.origin ?? APP_BUNDLE_ORIGIN).replace(/\/+$/, "");
  let answer: UpdateAnswer;
  if (request.method !== "POST") {
    answer = failed(405, "method_not_allowed", "Use POST.");
  } else {
    const check = parseUpdateCheck(await readBody(request));
    if (!check) {
      answer = failed(400, "invalid_request", "The update check is not valid.");
    } else {
      const pointer = await readPointer(handlers, origin, check.channel);
      answer = pointer === "unavailable"
        ? failed(503, "pointer_unavailable", "Updates are temporarily unavailable.")
        : decideUpdate(check, pointer);
    }
  }
  return handlers.json(answer.body, answer.status);
}

/** Only an explicit local QA origin replaces the CDN; anything malformed keeps the CDN. */
export function appBundleOrigin(configured: string | undefined): string {
  const value = configured?.trim();
  if (!value) return APP_BUNDLE_ORIGIN;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if ((url.protocol === "https:" || local) && !url.username && !url.password && url.pathname === "/" && !url.search) return url.origin;
  } catch {
    // Fall through to the CDN.
  }
  return APP_BUNDLE_ORIGIN;
}
