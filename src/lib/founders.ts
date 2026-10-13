import { accountApiUrl, fetchAccountApi, fetchAuthenticated } from "./accounts/authClient";
import { parseBadgeUnlocks, parseVisit, type BadgeUnlock, type VisitResult } from "./game/client";
import type { LngLat } from "./geo";

/**
 * Client for founding parks (issue #126): scan the device position for park outlines that
 * contain it, found one with an approved photo, and read a park's founder and visit counts.
 * Everything is online only. Photo data is never logged or kept beyond the request.
 */

/** The one-time bonus a founder earns; the server's answer wins when it sends one. */
export const FOUNDER_POINTS = 24;
/** The server refuses positions less precise than this. */
export const MAX_FOUND_ACCURACY_M = 100;
/** A scan position older than this is replaced by a fresh fix before the photo check. */
export const FRESH_FIX_MS = 30_000;

export type OsmRef = { type: "way" | "relation"; id: number };
export type DeviceFix = { point: LngLat; accuracy: number; at: number };

/** A park outline from OpenStreetMap that contains the scanned position. */
export type ContainingPark = OsmRef & {
  name: string | null;
  kind: string;
  areaM2: number;
  geometry: { type: "MultiPolygon"; coordinates: LngLat[][][] };
  /** Set when this outline is already a Parkdex park. */
  inCatalogue: { parkId: string; name: string } | null;
  /** Set when that Parkdex park already has a founder; it cannot be founded again. The handle is null for a founder without one. */
  founder: { handle: string | null } | null;
  hasCover: boolean;
};

export type FoundTarget = { osm: OsmRef } | { parkId: string };
export type FoundPhoto = { mime: "image/jpeg"; base64: string; width: number; height: number };
export type FoundRequest = { attemptId: string; position: { lat: number; lng: number; accuracyM: number }; target: FoundTarget; photo: FoundPhoto };

export type PhotoFlag = { code: string; message: string };
export type FoundResult =
  | { outcome: "founded"; park: { id: string; name: string }; coverUrl: string | null; visit: VisitResult | null; founderPoints: number; newBadges?: BadgeUnlock[] }
  | {
    outcome: "rejected" | "unsure";
    flags: PhotoFlag[];
    /** Until when a manual review can use this attempt; null when the photo is not kept or the server has no reviews. */
    reviewableUntil: string | null;
  };

export type ParkSummary = {
  parkId: string;
  founder: { handle: string | null; foundedAt: string | null } | null;
  coverUrl: string | null;
  visits: { total: number; last30Days: number; mine: number | null };
};

export type FounderErrorCode =
  | "offline"
  | "unauthenticated"
  | "handle_required"
  | "already_founded"
  | "not_inside"
  | "location_imprecise"
  | "rate_limited"
  | "park_not_found"
  | "invalid_request"
  /** A manual review of this park's photo is already waiting. */
  | "review_pending"
  /** The daily limit on manual reviews. */
  | "review_rate_limited"
  /** The photo is no longer kept, or this attempt cannot be reviewed. */
  | "review_unavailable"
  /** Any other refusal the server explains itself, such as an unnamed park. */
  | "refused"
  | "unavailable";

export class FounderError extends Error {
  constructor(readonly code: FounderErrorCode, readonly status: number, message: string, readonly founder: string | null = null) {
    super(message);
    this.name = "FounderError";
  }

  /** The same attempt can be sent again: nothing was decided. */
  get retryable(): boolean {
    return this.code === "offline" || this.code === "unavailable";
  }
}

/** The app's own wording for each refusal; the server's message wins for most 4xx answers. */
export const MESSAGES: Record<FounderErrorCode, string> = {
  offline: "You need a connection to become a founder.",
  unauthenticated: "Sign in again to become a founder.",
  handle_required: "Pick a handle before you become a founder.",
  already_founded: "This park already has a founder.",
  not_inside: "You need to be inside the park to become its founder.",
  location_imprecise: "Your location is not precise enough. Step into the open and try again.",
  rate_limited: "You've tried a lot of photos. Wait a little and try again.",
  park_not_found: "That park isn't on the map any more.",
  invalid_request: "Parkdex couldn't use that request. Update the app and try again.",
  review_pending: "Your photo for this park is already waiting for review.",
  review_rate_limited: "You've asked for 3 reviews today. Try again tomorrow.",
  review_unavailable: "This photo can't be sent for review any more. Retake it to try again.",
  refused: "You can't become this park's founder right now.",
  unavailable: "Try again in a moment.",
};

// Server codes that map onto ours; anything else falls back on the HTTP status.
const CODE_ALIASES: Record<string, FounderErrorCode> = {
  unauthenticated: "unauthenticated",
  authentication_required: "unauthenticated",
  handle_required: "handle_required",
  already_founded: "already_founded",
  not_inside: "not_inside",
  outside_park: "not_inside",
  not_in_park: "not_inside",
  location_outside: "not_inside",
  location_imprecise: "location_imprecise",
  location_inaccurate: "location_imprecise",
  inaccurate_location: "location_imprecise",
  rate_limited: "rate_limited",
  rate_limited_osm: "rate_limited",
  rate_limited_founders: "rate_limited",
  rate_limited_founding: "rate_limited",
  park_not_found: "park_not_found",
  invalid_request: "invalid_request",
  invalid_location: "invalid_request",
  unavailable: "unavailable",
  moderation_unavailable: "unavailable",
  photo_check_unavailable: "unavailable",
  service_unavailable: "unavailable",
  osm_unavailable: "unavailable",
  review_pending: "review_pending",
  rate_limited_review: "review_rate_limited",
  review_unavailable: "review_unavailable",
  photo_expired: "review_unavailable",
  not_reviewable: "review_unavailable",
  attempt_not_found: "review_unavailable",
};

const OUTCOMES = new Set(["founded", "rejected", "unsure"]);
const SCAN_TIMEOUT_MS = 20_000;
// The photo check can take several seconds before the park is published.
const FOUND_TIMEOUT_MS = 45_000;
const SUMMARY_TIMEOUT_MS = 10_000;
const REVIEW_TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function handleOf(value: unknown): string | null {
  const row = record(value);
  return text(row?.handle) ?? text(value);
}

// ------------------------------------------------------------------ parsing

function parseListed(value: unknown): ContainingPark["inCatalogue"] {
  const listed = record(value);
  const parkId = text(listed?.parkId);
  const name = text(listed?.name);
  return parkId && name ? { parkId, name } : null;
}

export function parseContainingPark(value: unknown): ContainingPark | null {
  const item = record(value);
  if (!item || (item.type !== "way" && item.type !== "relation") || typeof item.id !== "number" || !Number.isSafeInteger(item.id)) return null;
  const geometry = record(item.geometry);
  if (!geometry || geometry.type !== "MultiPolygon" || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length) return null;
  const inCatalogue = parseListed(item.inCatalogue);
  // The founder may sit on the outline or on its catalogue match.
  const founderValue = item.founder ?? record(item.inCatalogue)?.founder ?? null;
  return {
    type: item.type,
    id: item.id,
    name: text(item.name),
    kind: typeof item.kind === "string" ? item.kind : "",
    areaM2: typeof item.areaM2 === "number" && Number.isFinite(item.areaM2) ? item.areaM2 : 0,
    geometry: geometry as ContainingPark["geometry"],
    inCatalogue,
    founder: inCatalogue && founderValue ? { handle: handleOf(founderValue) } : null,
    hasCover: item.hasCover === true || record(item.inCatalogue)?.hasCover === true,
  };
}

export function parseScan(body: unknown): ContainingPark[] {
  const parks = record(body)?.parks;
  if (!Array.isArray(parks)) return [];
  return parks.map(parseContainingPark).filter((park): park is ContainingPark => park !== null);
}

function parseFlags(value: unknown): PhotoFlag[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    const code = text(row?.code) ?? text(item);
    if (!code) return [];
    const message = text(row?.message);
    return [{ code, message: message && message.length <= 240 ? message : flagMessage(code) }];
  });
}

export function parseFoundResult(body: unknown): FoundResult {
  const row = record(body);
  const outcome = row?.outcome;
  if (!row || typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
    throw new FounderError("unavailable", 200, "Parkdex sent an answer this version cannot read.");
  }
  if (outcome === "rejected" || outcome === "unsure") {
    const until = typeof row.reviewableUntil === "string" && Number.isFinite(Date.parse(row.reviewableUntil)) ? row.reviewableUntil : null;
    return { outcome, flags: parseFlags(row.flags), reviewableUntil: until };
  }
  const park = record(row.park);
  const id = text(park?.id) ?? text(park?.parkId);
  if (!id) throw new FounderError("unavailable", 200, "Parkdex sent an answer this version cannot read.");
  let visit: VisitResult | null = null;
  // The visit has the shape of POST /api/game/visits, with or without its `visit` wrapper.
  const rawVisit = record(row.visit);
  if (rawVisit) {
    try { visit = parseVisit(record(rawVisit.visit) ? rawVisit : { visit: rawVisit }); }
    catch { visit = null; }
  }
  return {
    outcome: "founded",
    park: { id, name: text(park?.name) ?? "this park" },
    coverUrl: text(row.coverUrl),
    visit,
    founderPoints: typeof row.founderPoints === "number" && Number.isFinite(row.founderPoints) ? Math.max(0, Math.round(row.founderPoints)) : FOUNDER_POINTS,
    // The badges the founding unlocked (additive, #175).
    ...(Array.isArray(row.newBadges) ? { newBadges: parseBadgeUnlocks(row.newBadges) } : {}),
  };
}

export function parseSummary(body: unknown, parkId: string): ParkSummary {
  const row = record(body) ?? {};
  const founder = record(row.founder);
  const visits = record(row.visits) ?? {};
  const mine = visits.mine;
  return {
    parkId: text(row.parkId) ?? parkId,
    founder: row.founder ? { handle: handleOf(row.founder), foundedAt: text(founder?.foundedAt) } : null,
    coverUrl: text(row.coverUrl),
    visits: {
      total: count(visits.total),
      last30Days: count(visits.last30Days),
      mine: typeof mine === "number" && Number.isFinite(mine) ? count(mine) : null,
    },
  };
}

// ------------------------------------------------------------------ helpers

/** The plain reason shown for a photo flag the server did not explain. */
export function flagMessage(code: string): string {
  switch (code) {
    case "people": return "We spotted people. Take one without anyone in it.";
    case "lighting": return "It's too dark or blurry. Find better light and hold still.";
    case "not_park": return "We can't see the park. Point the camera at the park itself.";
    case "inappropriate": return "This photo can't be used. Take a different one.";
    case "not_photo": return "That looks like a screen or a picture with text. Take a photo of the park.";
    case "personal_info": return "We can see licence plates, house numbers or documents. Take one without them.";
    case "unsure": return "We couldn't tell. Try another angle.";
    default: return "This photo didn't pass the check. Try another one.";
  }
}

/** The flags to show for a rejected or unsure check; an unsure check with none asks for another angle. */
export function checkFlags(result: Extract<FoundResult, { outcome: "rejected" | "unsure" }>): PhotoFlag[] {
  if (result.flags.length) return result.flags;
  return [{ code: result.outcome === "unsure" ? "unsure" : "other", message: flagMessage(result.outcome === "unsure" ? "unsure" : "other") }];
}

/** "Founder: @robin", or a plain line when the founder has no handle. */
export function founderLine(handle: string | null): string {
  return handle ? `Founder: @${handle}` : "This park already has a founder";
}

export const parkKey = (park: OsmRef) => `${park.type}/${park.id}`;

export function parkLabel(park: Pick<ContainingPark, "name" | "kind" | "inCatalogue">): string {
  if (park.inCatalogue) return park.inCatalogue.name;
  return park.name ?? (park.kind === "leisure=garden" ? "Unnamed garden" : park.kind === "leisure=nature_reserve" ? "Unnamed nature reserve" : "Unnamed park");
}

export function formatHectares(areaM2: number): string {
  const hectares = areaM2 / 10_000;
  if (hectares < 0.1) return "under 0.1 ha";
  return `${hectares < 10 ? hectares.toFixed(1) : Math.round(hectares)} ha`;
}

/** A park can be founded unless it already has a founder. */
export function canFound(park: ContainingPark): boolean {
  return !park.founder;
}

/**
 * The park picked first when outlines nest, such as a garden inside a park: the largest one
 * with a name, else the largest. Parks that already have a founder are never picked.
 */
export function defaultPark(parks: readonly ContainingPark[]): ContainingPark | null {
  const open = parks.filter(canFound);
  const pool = open.some((park) => park.name || park.inCatalogue) ? open.filter((park) => park.name || park.inCatalogue) : open;
  return pool.reduce<ContainingPark | null>((best, park) => (!best || park.areaM2 > best.areaM2 ? park : best), null);
}

export function targetFor(park: ContainingPark): FoundTarget {
  return park.inCatalogue ? { parkId: park.inCatalogue.parkId } : { osm: { type: park.type, id: park.id } };
}

export function isFreshFix(fix: Pick<DeviceFix, "at"> | null, now = Date.now()): boolean {
  return !!fix && now - fix.at <= FRESH_FIX_MS;
}

/** A cover photo address on the API origin, usable as an image source in every build. */
export function coverImageUrl(coverUrl: string | null | undefined): string | null {
  if (!coverUrl) return null;
  try {
    const url = new URL(coverUrl, accountApiUrl("/"));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export type FoundStepKind = "locating" | "scanning" | "results" | "problem" | "camera" | "checking" | "rejected" | "retry" | "taken" | "review_sent" | "founded";

/**
 * Where back (the Android button or Escape) goes from each founding step. The photo review
 * inside the camera steps back to the camera itself, before this applies. While a manual
 * review request is on its way, back waits for its answer like the photo check does.
 */
export function foundBackAction(step: FoundStepKind, sendingReview = false): "close" | "results" | "stay" {
  if (sendingReview) return "stay";
  switch (step) {
    case "camera":
    case "rejected":
    case "retry":
      return "results";
    // The photo is with the server; leaving now would hide its answer.
    case "checking":
      return "stay";
    default:
      return "close";
  }
}

// ------------------------------------------------------------------ manual review

/** Asking for a manual review from the rejected or unsure screen. */
export type ReviewState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "failed"; message: string; canRetry: boolean };

/** Why a review request failed, and whether pressing the button again could help. */
export function reviewProblem(error: unknown): { message: string; canRetry: boolean } {
  if (!(error instanceof FounderError)) return { message: "Couldn't send it. Try again in a moment.", canRetry: true };
  switch (error.code) {
    case "offline": return { message: "You need a connection to ask for a review.", canRetry: true };
    case "unavailable": return { message: "Couldn't send it. Try again in a moment.", canRetry: true };
    case "already_founded": return { message: error.founder ? `@${error.founder} became the founder first.` : "Someone else became the founder first.", canRetry: false };
    case "review_pending": return { message: MESSAGES.review_pending, canRetry: false };
    case "review_rate_limited":
    case "rate_limited": return { message: MESSAGES.review_rate_limited, canRetry: false };
    case "review_unavailable": return { message: MESSAGES.review_unavailable, canRetry: false };
    case "park_not_found": return { message: MESSAGES.park_not_found, canRetry: false };
    case "unauthenticated": return { message: "Sign in again to ask for a review.", canRetry: false };
    case "handle_required": return { message: "Pick a handle before you ask for a review.", canRetry: false };
    default: return { message: "This photo can't be sent for review. Retake it to try again.", canRetry: false };
  }
}

/**
 * The "Ask for a manual review" button: offered only while the server keeps the photo for a
 * review, and hidden once a failure is final.
 */
export function reviewButton(review: ReviewState, reviewable = true): { visible: boolean; disabled: boolean; label: string } {
  if (!reviewable || (review.kind === "failed" && !review.canRetry)) return { visible: false, disabled: true, label: REVIEW_LABEL };
  if (review.kind === "sending") return { visible: true, disabled: true, label: "Sending…" };
  return { visible: true, disabled: false, label: REVIEW_LABEL };
}

export const REVIEW_LABEL = "Ask for a manual review";
export const REVIEW_HINT = "We'll look at your photo and let you know. You can still retake it.";

// ------------------------------------------------------------------ requests

type Sender = (path: string, init: RequestInit) => Promise<Response>;

async function errorFrom(response: Response): Promise<FounderError> {
  let body: Record<string, unknown> = {};
  try { body = record(await response.json()) ?? {}; } catch { /* Empty or non-JSON answer. */ }
  const nested = record(body.error);
  const raw = [body.code, nested?.code, body.error].find((value) => typeof value === "string") as string | undefined;
  const status = response.status;
  const code: FounderErrorCode = (raw && Object.hasOwn(CODE_ALIASES, raw) ? CODE_ALIASES[raw] : undefined)
    ?? (status === 401 || status === 403 ? "unauthenticated"
      : status === 429 ? "rate_limited"
        : status === 404 ? "park_not_found"
          : status >= 500 ? "unavailable"
            : status === 409 || status === 413 || status === 422 ? "refused"
              : "invalid_request");
  // The server writes player-facing messages for refusals; keep ours for sign-in and outages.
  const serverMessage = text(body.message) ?? text(nested?.message);
  // A taken park names its founder in the message ("...: @robin.") when no field carries it.
  const founder = handleOf(body.founder) ?? handleOf(nested?.founder) ?? text(body.founderHandle)
    ?? (code === "already_founded" ? serverMessage?.match(/@([a-z0-9_]{3,20})/)?.[1] ?? null : null);
  const useServer = serverMessage && serverMessage.length <= 200 && status >= 400 && status < 500 && code !== "unauthenticated" && code !== "invalid_request";
  return new FounderError(code, status, useServer ? serverMessage : MESSAGES[code], founder);
}

async function send(sender: Sender, path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    return await sender(path, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new FounderError("offline", 0, controller.signal.aborted ? "That took too long. Check your connection and try again." : MESSAGES.offline);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

const anyone: Sender = (path, init) => fetchAccountApi(path, init);
const asAccount = (accountId: string): Sender => (path, init) => fetchAuthenticated(path, init, accountId);

/** `GET /api/osm/parks`: only the park outlines that contain this position. */
export async function scanParks(fix: Pick<DeviceFix, "point" | "accuracy">, signal?: AbortSignal): Promise<ContainingPark[]> {
  const query = new URLSearchParams({
    lat: fix.point[1].toFixed(6),
    lng: fix.point[0].toFixed(6),
    accuracy: String(Math.max(1, Math.round(fix.accuracy))),
  });
  const response = await send(anyone, `/api/osm/parks?${query}`, {}, SCAN_TIMEOUT_MS, signal);
  if (!response.ok) throw await errorFrom(response);
  return parseScan(await response.json().catch(() => null));
}

/**
 * `POST /api/parks/found`. Retrying with the same attempt ID never founds twice. A rejected
 * or unsure photo is an answer, not an error; outages and refusals throw a FounderError.
 */
export async function foundPark(accountId: string, request: FoundRequest): Promise<FoundResult> {
  const response = await send(asAccount(accountId), "/api/parks/found", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }, FOUND_TIMEOUT_MS);
  if (response.ok) return parseFoundResult(await response.json().catch(() => null));
  // Some refusals still carry a photo verdict; read it before treating the reply as an error.
  const copy = response.clone();
  const body = await copy.json().catch(() => null) as Record<string, unknown> | null;
  if (body && (body.outcome === "rejected" || body.outcome === "unsure")) return parseFoundResult(body);
  throw await errorFrom(response);
}

/** `GET /api/parks/:parkId/summary`, with the player's own count when signed in. */
export async function fetchParkSummary(parkId: string, accountId: string | null, signal?: AbortSignal): Promise<ParkSummary> {
  const path = `/api/parks/${encodeURIComponent(parkId)}/summary`;
  let response = await send(accountId ? asAccount(accountId) : anyone, path, {}, SUMMARY_TIMEOUT_MS, signal);
  // A stale session should not hide the public counts.
  if (accountId && (response.status === 401 || response.status === 403)) response = await send(anyone, path, {}, SUMMARY_TIMEOUT_MS, signal);
  if (!response.ok) throw await errorFrom(response);
  return parseSummary(await response.json().catch(() => null), parkId);
}

export type ReviewStatus = "pending" | "approved" | "rejected" | "superseded";
const REVIEW_STATUSES = new Set<ReviewStatus>(["pending", "approved", "rejected", "superseded"]);

/**
 * `POST /api/parks/found/review`: ask for a person to look at a rejected or unsure photo. The
 * server reuses the photo it kept for that attempt, so nothing is uploaded again. Sending the
 * same attempt again answers with the same request and its current status.
 */
export async function requestFoundingReview(accountId: string, attemptId: string): Promise<{ status: ReviewStatus; requestId: string }> {
  const response = await send(asAccount(accountId), "/api/parks/found/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attemptId }),
  }, REVIEW_TIMEOUT_MS);
  if (!response.ok) throw await errorFrom(response);
  const body = record(await response.json().catch(() => null));
  const requestId = text(body?.requestId);
  if (!requestId) throw new FounderError("unavailable", response.status, "Parkdex sent an answer this version cannot read.");
  const status = REVIEW_STATUSES.has(body?.status as ReviewStatus) ? body?.status as ReviewStatus : "pending";
  return { status, requestId };
}

/** `POST /api/parks/found/review/seen`: these review decisions were shown to the player. */
export async function markFoundingReviewsSeen(accountId: string, requestIds: readonly string[]): Promise<void> {
  if (!requestIds.length) return;
  const response = await send(asAccount(accountId), "/api/parks/found/review/seen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestIds }),
  }, SUMMARY_TIMEOUT_MS);
  if (!response.ok) throw await errorFrom(response);
}
