import {
  APP_BUNDLE_CHANNELS,
  APP_BUNDLE_ORIGIN,
  APP_BUNDLE_POINTER_SCHEMA,
  bundleUrlFor,
  decideUpdate,
  pointerUrlFor,
  validatePointer,
  type AppBundleChannel,
  type AppBundlePointer,
} from "../../../worker/appUpdates.js";
import { HttpError } from "../http.js";
import type { KnownBundle, OtaAction, OtaHistoryStore, OtaOutcome, OtaPublish } from "./history.js";
import { bareEtag, cacheBusted, failureText, noCacheHeaders, timedFetch, type Fetcher, type R2Client, type R2ObjectInfo } from "./r2.js";

/**
 * Over-the-air updates: what each channel's pointer says, the bundles in R2, and moving a
 * channel to a bundle that is already there (roll back, or promote staging to production).
 *
 * Cloudflare's REST object PUT has no conditional header, so a move is guarded by hand: read
 * the pointer from R2 and require the operator's expected generation (and ETag), check the
 * bundle exists and the native build range is safe, read once more just before writing
 * generation + 1, then read back through R2 and through the CDN. A readback that shows another
 * pointer means two writers raced; it is reported and recorded, never hidden.
 */

export const CDN_ORIGIN = APP_BUNDLE_ORIGIN;
export const POINTER_CACHE_CONTROL = "public, max-age=60, s-maxage=60";
/** The host each channel's builds post their update checks to (docs/ota-updates.md). */
export const UPDATE_ENDPOINTS: Record<AppBundleChannel, string> = {
  staging: "https://staging.web.parkdex.app/api/updates",
  production: "https://web.parkdex.app/api/updates",
};
const SHA256 = /^[a-f0-9]{64}$/;
const BUNDLE_KEY = /^app-bundles\/([a-f0-9]{64})\.zip$/;
const MAX_BUILD = 2_100_000_000;
const NOTE_MAX = 300;

export const pointerKey = (channel: AppBundleChannel) => `app-bundles/channels/${channel}/current.json`;
export const bundleKey = (sha256: string) => `app-bundles/${sha256}.zip`;

export function isChannel(value: unknown): value is AppBundleChannel {
  return typeof value === "string" && (APP_BUNDLE_CHANNELS as readonly string[]).includes(value);
}

export function parseChannel(value: unknown): AppBundleChannel {
  if (!isChannel(value)) throw new HttpError(400, "invalid_channel", "Choose the staging or production channel.");
  return value;
}

export function parseNativeBuild(value: unknown, label: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,10}$/.test(text) || Number(text) < 1 || Number(text) > MAX_BUILD)
    throw new HttpError(400, "invalid_build", `${label} must be a whole native version code.`);
  return Number(text);
}

/** The bundle version the publisher derives from its commit and hash (scripts/publish-app-bundle.mjs). */
export function bundleVersion(sourceCommit: string, sha256: string): string {
  const source = /^[a-f0-9]{7,40}$/i.test(sourceCommit) ? sourceCommit.slice(0, 7).toLowerCase() : "local";
  return `${source}-${sha256.slice(0, 8)}`;
}

export type ChannelState =
  /** The CDN serves a valid pointer. */
  | "live"
  /** Nothing published yet: R2 has no pointer (or R2 is not readable and the CDN says 404). */
  | "none"
  /** R2 has a pointer but the CDN does not serve it, usually because the worker predates app-bundles. */
  | "not_served"
  /** A pointer exists but fails validation, so the endpoint answers 503 and no device sees it. */
  | "invalid"
  | "unavailable";

export interface ChannelView {
  channel: AppBundleChannel;
  state: ChannelState;
  pointer: AppBundlePointer | null;
  /** The pointer's ETag on the CDN, as the publish script expects it (quoted). */
  etag: string | null;
  /** The R2 copy, which moves are guarded against. Null when Cloudflare is not configured. */
  r2: { generation: number | null; etag: string | null } | null;
  detail: string;
}

export interface BundleView {
  sha256: string;
  byteSize: number;
  uploadedAt: string | null;
  version: string | null;
  sourceCommit: string | null;
  /** The oldest native build the bundle is known to need, from history or a live pointer. */
  minimumNativeBuild: number | null;
  maximumNativeBuild: number | null;
  /** Channels whose pointer names this bundle right now. */
  liveOn: AppBundleChannel[];
}

export interface CdnPointerRead {
  status: number;
  pointer: AppBundlePointer | null;
  valid: boolean;
  etag: string | null;
  cache: string | null;
  /** Why the read failed before an HTTP answer, or which status it got instead of a pointer. */
  error: string | null;
}

/**
 * Reads a pointer through the CDN. With fresh = true it sends a Range header, which the content
 * worker answers from R2 without its 60 second cache, so a readback sees the write at once. The
 * query parameter and no-cache headers keep any cache in front of the worker out of the way.
 */
export async function readCdnPointer(fetcher: Fetcher, channel: AppBundleChannel, fresh = false): Promise<CdnPointerRead> {
  let response: Response;
  try {
    response = await timedFetch(fetcher, cacheBusted(pointerUrlFor(CDN_ORIGIN, channel)), {
      method: "GET",
      headers: noCacheHeaders(fresh ? { range: "bytes=0-" } : {}),
    });
  } catch (error) {
    return { status: 0, pointer: null, valid: false, etag: null, cache: null, error: failureText(error) };
  }
  const result = { status: response.status, etag: response.headers.get("etag"), cache: response.headers.get("x-content-cache"), error: null };
  if (response.status !== 200 && response.status !== 206)
    return { ...result, pointer: null, valid: false, error: response.status === 404 ? null : `The CDN answered HTTP ${response.status}.` };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    /* reported as invalid below */
  }
  const pointer = validatePointer(parsed, channel, CDN_ORIGIN);
  return { ...result, pointer: pointer ?? (parsed as AppBundlePointer | null), valid: Boolean(pointer) };
}

function parseStoredPointer(text: string | null, channel: AppBundleChannel): { pointer: AppBundlePointer | null; valid: boolean } {
  if (text === null) return { pointer: null, valid: true };
  try {
    const parsed = JSON.parse(text) as unknown;
    const pointer = validatePointer(parsed, channel, CDN_ORIGIN);
    return { pointer: pointer ?? (parsed as AppBundlePointer), valid: Boolean(pointer) };
  } catch {
    return { pointer: null, valid: false };
  }
}

export interface WorkerProbe {
  /** Whether the CDN worker routes app-bundles/ paths at all. Null when the probe failed. */
  serves: boolean | null;
  method: "bundle" | "allow-header" | "none";
  detail: string;
}

/**
 * Tells "the CDN worker does not serve app-bundles yet" apart from "no pointer yet". Both answer
 * a pointer GET with the same 404, so: when R2 holds a bundle, HEAD it through the CDN (a 404 then
 * means the worker does not route the path). With no bundle to try, send a POST to the pointer
 * path: a worker that routes it as a channel pointer answers 405 with Allow: GET, HEAD, while an
 * older worker treats it as an unknown path and answers Allow: GET, HEAD, OPTIONS.
 */
export async function probeCdnWorker(fetcher: Fetcher, knownBundle: string | null): Promise<WorkerProbe> {
  try {
    if (knownBundle) {
      const head = await timedFetch(fetcher, cacheBusted(bundleUrlFor(CDN_ORIGIN, knownBundle)), { method: "HEAD", headers: noCacheHeaders() });
      if (head.status === 200) return { serves: true, method: "bundle", detail: `The CDN serves app-bundles/${knownBundle.slice(0, 12)}...zip.` };
      if (head.status === 404)
        return {
          serves: false,
          method: "bundle",
          detail: `R2 has app-bundles/${knownBundle.slice(0, 12)}...zip but the CDN answers 404, so the worker does not route app-bundles/ yet.`,
        };
    }
    const probe = await timedFetch(fetcher, cacheBusted(pointerUrlFor(CDN_ORIGIN, "staging")), { method: "POST", headers: noCacheHeaders() });
    const allow = (probe.headers.get("allow") ?? "").replace(/\s+/g, "").toUpperCase();
    if (probe.status === 405 && allow === "GET,HEAD")
      return { serves: true, method: "allow-header", detail: "The CDN worker routes app-bundles/ pointer paths." };
    if (probe.status === 405 && allow.includes("OPTIONS"))
      return { serves: false, method: "allow-header", detail: "The CDN worker treats app-bundles/ as an unknown path, so it predates over-the-air updates." };
    return { serves: null, method: "allow-header", detail: `The CDN answered the probe with HTTP ${probe.status}; it could not be classified.` };
  } catch (error) {
    return { serves: null, method: "none", detail: `The CDN probe failed: ${failureText(error)}` };
  }
}

export interface ChannelsAndBundles {
  channels: ChannelView[];
  bundles: BundleView[] | null;
  bundlesError: string | null;
  probe: WorkerProbe;
}

function bundleObjects(objects: R2ObjectInfo[]): R2ObjectInfo[] {
  return objects.filter((item) => BUNDLE_KEY.test(item.key));
}

export function describeChannel(view: Omit<ChannelView, "detail">, probe: WorkerProbe, error: string | null = null): string {
  switch (view.state) {
    case "live":
      return `Generation ${view.pointer!.generation}: builds ${view.pointer!.minimumNativeBuild} to ${view.pointer!.maximumNativeBuild} are offered ${view.pointer!.version}.`;
    case "none":
      return probe.serves === false
        ? "No pointer yet, and the CDN worker does not serve app-bundles/ yet. Deploy the worker, then publish a first bundle."
        : "No bundle has been published on this channel. Installed builds keep their built-in code.";
    case "not_served":
      return "R2 has a pointer, but the CDN does not serve it, so the update endpoint answers no_bundle_published. Deploy the CDN worker.";
    case "invalid":
      return "The pointer fails validation, so the update endpoint answers 503 and no device gets an update. Publish a valid pointer with the script.";
    default:
      return `The pointer could not be read through the CDN. ${error ?? "No reason was given."}`;
  }
}

/** Both channels as devices see them, plus the R2 copy and the bundle listing when Cloudflare is set up. */
export async function loadChannelsAndBundles(fetcher: Fetcher, r2: R2Client | null, known: KnownBundle[]): Promise<ChannelsAndBundles> {
  let objects: R2ObjectInfo[] | null = null;
  let bundlesError: string | null = null;
  if (r2) {
    try {
      objects = await r2.list("app-bundles/");
    } catch (error) {
      bundlesError = error instanceof HttpError ? error.message : `The bundle listing failed. ${failureText(error)}`;
    }
  }
  const zips = objects ? bundleObjects(objects) : [];
  const probe = await probeCdnWorker(fetcher, zips[0] ? BUNDLE_KEY.exec(zips[0].key)![1] : null);

  const channels = await Promise.all(
    APP_BUNDLE_CHANNELS.map(async (channel): Promise<ChannelView> => {
      const cdn = await readCdnPointer(fetcher, channel);
      let stored: { pointer: AppBundlePointer | null; valid: boolean; etag: string | null } | null = null;
      let storedError: string | null = null;
      if (r2 && objects) {
        const info = objects.find((item) => item.key === pointerKey(channel)) ?? null;
        try {
          stored = info ? { ...parseStoredPointer(await r2.getText(info.key), channel), etag: info.etag } : { pointer: null, valid: true, etag: null };
        } catch (error) {
          stored = null;
          storedError = error instanceof HttpError ? error.message : failureText(error);
        }
      }
      let state: ChannelState;
      let pointer: AppBundlePointer | null = cdn.pointer;
      if (cdn.status === 200 && cdn.valid) state = "live";
      else if (cdn.status === 200) state = "invalid";
      else if (cdn.status === 404) {
        if (stored?.pointer) {
          state = stored.valid ? "not_served" : "invalid";
          pointer = stored.pointer;
        } else state = "none";
      } else state = "unavailable";
      const base = {
        channel,
        state,
        pointer,
        etag: cdn.etag,
        r2: stored
          ? { generation: stored.pointer ? (Number.isSafeInteger(stored.pointer.generation) ? stored.pointer.generation : null) : 0, etag: stored.etag }
          : null,
      };
      const detail = describeChannel(base, probe, cdn.error);
      return { ...base, detail: storedError ? `${detail} Reading the R2 copy failed: ${storedError}` : detail };
    }),
  );

  let bundles: BundleView[] | null = null;
  if (objects) {
    const bySha = new Map(known.map((item) => [item.sha256, item]));
    bundles = zips
      .map((item) => {
        const sha256 = BUNDLE_KEY.exec(item.key)![1];
        const history = bySha.get(sha256);
        const live = channels.filter((view) => view.pointer?.sha256 === sha256);
        const fromPointers = live.map((view) => view.pointer!).filter((pointer) => Number.isSafeInteger(pointer.minimumNativeBuild));
        const minimum = Math.max(history?.minimumNativeBuild ?? 0, ...fromPointers.map((pointer) => pointer.minimumNativeBuild));
        return {
          sha256,
          byteSize: item.size,
          uploadedAt: item.uploadedAt,
          version: history?.version ?? fromPointers[0]?.version ?? null,
          sourceCommit: history?.sourceCommit ?? fromPointers[0]?.sourceCommit ?? null,
          minimumNativeBuild: minimum > 0 ? minimum : null,
          maximumNativeBuild: history?.maximumNativeBuild ?? fromPointers[0]?.maximumNativeBuild ?? null,
          liveOn: live.map((view) => view.channel),
        };
      })
      .sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""));
  }
  return { channels, bundles, bundlesError, probe };
}

export interface MoveRequest {
  channel: AppBundleChannel;
  sha256: string;
  expectedGeneration: number;
  expectedEtag: string | null;
  minimumNativeBuild: number;
  maximumNativeBuild: number;
  note: string;
}

export function validateMove(value: unknown): MoveRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "invalid_request", "Invalid move request.");
  const input = value as Record<string, unknown>;
  const allowed = ["channel", "sha256", "expectedGeneration", "expectedEtag", "minimumNativeBuild", "maximumNativeBuild", "note"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpError(400, "invalid_request", "Invalid move request.");
  const channel = parseChannel(input.channel);
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) throw new HttpError(400, "invalid_bundle", "Choose a bundle by its SHA-256.");
  if (!Number.isSafeInteger(input.expectedGeneration) || (input.expectedGeneration as number) < 0)
    throw new HttpError(400, "invalid_generation", "Send the generation you saw (0 when nothing is published).");
  const expectedEtag =
    input.expectedEtag === undefined || input.expectedEtag === null
      ? null
      : typeof input.expectedEtag === "string" && input.expectedEtag.length <= 200
        ? input.expectedEtag
        : undefined;
  if (expectedEtag === undefined) throw new HttpError(400, "invalid_etag", "Invalid expected ETag.");
  const minimumNativeBuild = parseNativeBuild(input.minimumNativeBuild, "Minimum native build");
  const maximumNativeBuild = parseNativeBuild(input.maximumNativeBuild, "Maximum native build");
  if (minimumNativeBuild > maximumNativeBuild) throw new HttpError(400, "invalid_build", "The minimum native build cannot be above the maximum.");
  const note = input.note === undefined ? "" : typeof input.note === "string" ? input.note.trim() : null;
  if (note === null || note.length > NOTE_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note))
    throw new HttpError(400, "invalid_note", `Keep the note to ${NOTE_MAX} characters of plain text.`);
  return { channel, sha256: input.sha256, expectedGeneration: input.expectedGeneration as number, expectedEtag, minimumNativeBuild, maximumNativeBuild, note };
}

export interface MoveResult {
  outcome: OtaOutcome;
  pointer: AppBundlePointer;
  previous: AppBundlePointer | null;
  action: OtaAction;
  publish: OtaPublish | null;
  /** Plain words for the toast and the history row. */
  message: string;
}

async function readStored(r2: R2Client, channel: AppBundleChannel): Promise<{ pointer: AppBundlePointer | null; generation: number }> {
  const text = await r2.getText(pointerKey(channel));
  if (text === null) return { pointer: null, generation: 0 };
  const { pointer, valid } = parseStoredPointer(text, channel);
  if (!valid || !pointer) {
    throw new HttpError(
      409,
      "pointer_invalid",
      `The ${channel} pointer in R2 is not a valid channel pointer. Repair it with scripts/publish-app-bundle.mjs before moving it from here.`,
    );
  }
  return { pointer, generation: pointer.generation };
}

function generationMoved(channel: AppBundleChannel, expected: number, actual: number): HttpError {
  return new HttpError(
    409,
    "generation_moved",
    `The ${channel} pointer is at generation ${actual}, not ${expected}. Someone published meanwhile; reload to see it, then decide again.`,
  );
}

/**
 * Points `channel` at a bundle that is already in R2. Every refusal happens before the write.
 * After the write the result is recorded in the history whatever the readback found.
 */
export async function movePointer(
  input: MoveRequest,
  deps: { r2: R2Client; fetch: Fetcher; history: OtaHistoryStore | null; now: () => number },
): Promise<MoveResult> {
  const { r2, history } = deps;
  const { channel, sha256 } = input;
  const current = await readStored(r2, channel);
  if (current.generation !== input.expectedGeneration) throw generationMoved(channel, input.expectedGeneration, current.generation);
  if (input.expectedEtag) {
    const info = await r2.stat(pointerKey(channel));
    if (bareEtag(info?.etag) !== bareEtag(input.expectedEtag)) {
      throw new HttpError(
        409,
        "generation_moved",
        `The ${channel} pointer changed since you loaded the page (its ETag is different). Reload, then decide again.`,
      );
    }
  }

  const zip = await r2.stat(bundleKey(sha256));
  if (!zip)
    throw new HttpError(409, "bundle_missing", `R2 has no app-bundles/${sha256.slice(0, 12)}...zip. Upload it with scripts/publish-app-bundle.mjs first.`);

  // A zip does not say which native builds it needs. Use what its publications said.
  const other = APP_BUNDLE_CHANNELS.find((item) => item !== channel)!;
  const otherPointer = await readStored(r2, other)
    .then((value) => value.pointer)
    .catch(() => null);
  const known = history ? ((await history.bundles()).find((item) => item.sha256 === sha256) ?? null) : null;
  const pointers = [current.pointer, otherPointer].filter((pointer): pointer is AppBundlePointer => pointer?.sha256 === sha256);
  if (!known && pointers.length === 0) {
    throw new HttpError(
      409,
      "bundle_unrecorded",
      "This bundle has no publish record, so the dashboard cannot tell which native builds it needs. Publish it with the script and --record.",
    );
  }
  const needs = Math.max(known?.minimumNativeBuild ?? 0, ...pointers.map((pointer) => pointer.minimumNativeBuild));
  if (input.minimumNativeBuild < needs) {
    throw new HttpError(
      409,
      "minimum_too_low",
      `This bundle needs native build ${needs} or newer; builds ${input.minimumNativeBuild} to ${needs - 1} lack the native code it calls.`,
    );
  }
  const sourceCommit = known?.sourceCommit ?? pointers[0].sourceCommit;
  const version = known?.version ?? pointers[0]?.version ?? bundleVersion(sourceCommit, sha256);

  // Promote is staging's live bundle going to production; rollback is a bundle this channel ran before.
  const action: OtaAction =
    current.pointer?.sha256 === sha256
      ? "repoint"
      : channel === "production" && otherPointer?.sha256 === sha256
        ? "promote"
        : known?.channels.includes(channel)
          ? "rollback"
          : "repoint";
  const pointer: AppBundlePointer = {
    schema: APP_BUNDLE_POINTER_SCHEMA,
    channel,
    generation: current.generation + 1,
    version,
    bundleUrl: bundleUrlFor(CDN_ORIGIN, sha256),
    sha256,
    byteSize: zip.size,
    minimumNativeBuild: input.minimumNativeBuild,
    maximumNativeBuild: input.maximumNativeBuild,
    sourceCommit,
    publishedAt: new Date(deps.now()).toISOString(),
  };
  if (!validatePointer(pointer, channel, CDN_ORIGIN))
    throw new HttpError(409, "pointer_invalid", "The new pointer would not pass the update endpoint's checks.");
  const body = `${JSON.stringify(pointer, null, 2)}\n`;

  // The REST API cannot make the PUT conditional, so check once more right before it.
  const last = await readStored(r2, channel);
  if (last.generation !== input.expectedGeneration) throw generationMoved(channel, input.expectedGeneration, last.generation);
  await r2.putJson(pointerKey(channel), body, POINTER_CACHE_CONTROL);

  let outcome: OtaOutcome = "confirmed";
  let message: string;
  let readbackError = "";
  const stored = await r2.getText(pointerKey(channel)).catch((error: unknown) => {
    readbackError = error instanceof HttpError ? error.message : failureText(error);
    return null;
  });
  if (stored !== body) {
    outcome = "conflict";
    const seen = parseStoredPointer(stored, channel).pointer;
    message = seen
      ? `Readback mismatch: R2 now holds generation ${seen.generation} (${seen.version}), not the pointer just written. Another publish raced this one.`
      : `Readback mismatch: R2 did not return the pointer just written.${readbackError ? ` ${readbackError}` : ""}`;
  } else {
    const cdn = await readCdnPointer(deps.fetch, channel, true);
    let headError = "";
    const head = await timedFetch(deps.fetch, cacheBusted(pointer.bundleUrl), { method: "HEAD", headers: noCacheHeaders() })
      .then((response) => response.status)
      .catch((error: unknown) => {
        headError = failureText(error);
        return 0;
      });
    if (!cdn.valid || cdn.pointer?.generation !== pointer.generation || cdn.pointer.sha256 !== sha256) {
      outcome = "cdn_pending";
      message =
        cdn.status === 404
          ? "R2 has the new pointer, but the CDN answers 404 for it. Devices see no bundle until the CDN worker serves app-bundles/."
          : `R2 has the new pointer, but the CDN returned ${cdn.pointer ? `generation ${cdn.pointer.generation}` : (cdn.error ?? `HTTP ${cdn.status}`)}. Check again in a minute.`;
    } else if (head !== 200) {
      outcome = "cdn_pending";
      message =
        head === 0
          ? `The pointer is live, but the bundle zip could not be checked through the CDN: ${headError}`
          : `The pointer is live, but the CDN answered HTTP ${head} for the bundle zip, so downloads would fail.`;
    } else {
      message = `${channel === "production" ? "Production" : "Staging"} now offers ${version} to builds ${pointer.minimumNativeBuild} to ${pointer.maximumNativeBuild} (generation ${pointer.generation}).`;
    }
  }

  let publish: OtaPublish | null = null;
  if (history) {
    publish = await history.record({
      channel,
      generation: pointer.generation,
      previousGeneration: current.generation,
      action,
      source: "dashboard",
      sha256,
      previousSha256: current.pointer?.sha256 ?? null,
      version,
      byteSize: pointer.byteSize,
      minimumNativeBuild: pointer.minimumNativeBuild,
      maximumNativeBuild: pointer.maximumNativeBuild,
      sourceCommit,
      outcome,
      note: input.note,
      publishedAt: pointer.publishedAt,
    });
  }
  return { outcome, pointer, previous: current.pointer, action, publish, message };
}

export interface UpdateCheckResult {
  channel: AppBundleChannel;
  nativeBuild: number;
  endpoint: string;
  status: number;
  answer: unknown;
  /** What the endpoint should say given the pointer the CDN serves now. */
  expected: unknown;
  matches: boolean;
}

/** Posts a sample update check to the channel's live endpoint, as an installed build would. */
export async function checkLiveEndpoint(
  fetcher: Fetcher,
  channel: AppBundleChannel,
  nativeBuild: number,
  currentVersion = "builtin",
): Promise<UpdateCheckResult> {
  const endpoint = UPDATE_ENDPOINTS[channel];
  const body = { platform: "android", app_id: "app.parkdex", defaultChannel: channel, version_code: String(nativeBuild), version_name: currentVersion };
  const cdn = await readCdnPointer(fetcher, channel);
  const expected =
    cdn.status === 404
      ? decideUpdate({ appId: "app.parkdex", channel, nativeBuild, currentVersion }, null).body
      : cdn.valid
        ? decideUpdate({ appId: "app.parkdex", channel, nativeBuild, currentVersion }, cdn.pointer).body
        : { kind: "failed", error: "pointer_unavailable" };
  let status = 0;
  let answer: unknown = null;
  try {
    const response = await timedFetch(fetcher, endpoint, {
      method: "POST",
      headers: noCacheHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    status = response.status;
    const text = await response.text();
    try {
      answer = JSON.parse(text);
    } catch {
      answer = { unreadable: text.slice(0, 200) };
    }
  } catch (error) {
    answer = { error: failureText(error) };
  }
  const pick = (value: unknown) => {
    const record = (value ?? {}) as Record<string, unknown>;
    return JSON.stringify([record.kind ?? null, record.error ?? null, record.version ?? null, record.checksum ?? null]);
  };
  return { channel, nativeBuild, endpoint, status, answer, expected, matches: status > 0 && pick(answer) === pick(expected) };
}
