import { catalogueMatch } from "./catalogueMatch.js";
import {
  decidePhoto, FLAG_MESSAGES, UNAVAILABLE_MESSAGE, UNSURE_MESSAGE,
  type PhotoAnswers, type PhotoChecker, type PhotoFlag,
} from "./founderPhoto.js";
import type { FoundedRecord, FoundersStore, FoundResult, KeptAttempt } from "./founders-store.js";
import { apiVisit, visitEvents } from "./game.js";
import { JpegError, stripJpegMetadata } from "./jpeg.js";
import type { OsmClient, OsmFeature, OsmRef, MultiPolygon } from "./osmParks.js";
import { markerPoint, positionInside, validatePosition, type DevicePosition } from "./parkLocation.js";
import { osmParkId, parkFromProposal } from "./parkPublish.js";
import { regionFor, type NearbyPark } from "./proposalReview.js";
import { HttpError, readJsonBody } from "./validation.js";

/**
 * Found a park (#126): `POST /api/parks/found`, the public cover photo and the park summary.
 * A signed-in player with a handle, standing in the park, sends one photo. When the model
 * approves it, one transaction publishes the OpenStreetMap park (or confirms the catalogue
 * park), stores the photo as the cover, records today's visit and awards the founder bonus.
 * A rejected or unsure photo is kept for a day, so the player can ask the operator for a manual
 * review of it (#153, `POST /api/parks/found/review`).
 */

export const MAX_PHOTO_BYTES = 1_572_864;
export const MAX_PHOTO_DIMENSION = 2_048;
// The base64 photo plus a little JSON; the Vercel adapter allows 3 MB.
const MAX_FOUND_BODY_BYTES = Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 16 * 1024;
export const CHECKS_PER_HOUR = 20;
export const FOUNDED_PER_DAY = 5;
/** Manual review (#153): requests per account per Victoria day, and how long a failed check's photo is kept for one. */
export const REVIEWS_PER_DAY = 3;
export const REVIEW_KEEP_MS = 24 * 3_600_000;
const MAX_SEEN_IDS = 50;
// Wide enough to catch a big catalogue park whose centre is a few km away.
const CATALOGUE_KM = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const COVER_PATH = /^\/api\/parks\/([a-z0-9]+(?:-[a-z0-9]+)*)\/cover\/([0-9a-f]{64})\.jpg$/;
const SUMMARY_PATH = /^\/api\/parks\/([a-z0-9]+(?:-[a-z0-9]+)*)\/summary$/;

export type FounderEventName = "park_founded" | "founder_photo_checked" | "founding_review_requested"
  | "flag_planted" | "flag_taken" | "flag_held" | "visit_already_today" | "flag_fell";

export interface FoundersHandlers {
  store(): FoundersStore;
  osm(): OsmClient;
  /** Null when the photo model is not configured: every check is "unavailable". */
  photoChecker(): PhotoChecker | null;
  threshold: number;
  mutation(): Promise<{ accountId: string }>;
  /** The signed-in account, or null for anyone else. Never throws for a missing session. */
  optionalAccount(): Promise<{ accountId: string } | null>;
  /** Catalogue parks near a point, to match an outline and choose a region. */
  nearbyParks(lat: number, lng: number, km: number): Promise<NearbyPark[]>;
  /** Origin of this API, for absolute cover URLs that native builds can load cross-origin. */
  publicOrigin: string;
  now(): number;
  uuid(): string;
  emit(type: FounderEventName, properties: Record<string, unknown>): void;
}

export type FoundTarget = { osm: OsmRef } | { parkId: string };

export interface FoundRequest {
  attemptId: string;
  position: DevicePosition;
  target: FoundTarget;
  photo: { bytes: Uint8Array; width: number; height: number };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[], message = "Invalid request."): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new HttpError(400, "invalid_request", message);
  }
  return value;
}

function validateTarget(value: unknown): FoundTarget {
  if (record(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "parkId")) {
    const parkId = value.parkId;
    if (typeof parkId !== "string" || parkId.length > 160 || !PARK_ID.test(parkId)) throw new HttpError(400, "invalid_request", "Invalid park ID.");
    return { parkId };
  }
  if (record(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "osm")) {
    const osm = exactKeys(value.osm, ["type", "id"], "Unknown OpenStreetMap park.");
    if ((osm.type !== "way" && osm.type !== "relation") || typeof osm.id !== "number" || !Number.isSafeInteger(osm.id) || osm.id <= 0) {
      throw new HttpError(400, "invalid_request", "Unknown OpenStreetMap park.");
    }
    return { osm: { type: osm.type, id: osm.id } };
  }
  throw new HttpError(400, "invalid_request", "Choose the park to found.");
}

function invalidPhoto(): HttpError {
  return new HttpError(400, "invalid_photo", "Send the photo as a JPEG.");
}

/** Validates the body strictly and removes the photo's metadata before anything else sees it. */
export function validateFoundBody(body: unknown): FoundRequest {
  const value = exactKeys(body, ["attemptId", "position", "target", "photo"]);
  if (typeof value.attemptId !== "string" || !UUID.test(value.attemptId)) throw new HttpError(400, "invalid_request", "Invalid attempt ID.");
  const position = validatePosition(value.position);
  const target = validateTarget(value.target);
  const photo = exactKeys(value.photo, ["mime", "base64", "width", "height"], "Send the photo as a JPEG.");
  if (photo.mime !== "image/jpeg" || typeof photo.base64 !== "string") throw invalidPhoto();
  if (typeof photo.width !== "number" || typeof photo.height !== "number" || !Number.isInteger(photo.width) || !Number.isInteger(photo.height) ||
      photo.width < 1 || photo.height < 1) throw invalidPhoto();
  if (photo.width > MAX_PHOTO_DIMENSION || photo.height > MAX_PHOTO_DIMENSION) {
    throw new HttpError(413, "photo_too_large", "That photo is too large. Use one of at most 2,048 pixels on each side.");
  }
  if (photo.base64.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4) throw new HttpError(413, "photo_too_large", "That photo is too large. Try a smaller one.");
  if (!photo.base64.length || !BASE64.test(photo.base64)) throw invalidPhoto();
  const raw = new Uint8Array(Buffer.from(photo.base64, "base64"));
  if (raw.length > MAX_PHOTO_BYTES) throw new HttpError(413, "photo_too_large", "That photo is too large. Try a smaller one.");
  let stripped;
  try {
    stripped = stripJpegMetadata(raw);
  } catch (error) {
    if (error instanceof JpegError) throw invalidPhoto();
    throw error;
  }
  if (stripped.width !== photo.width || stripped.height !== photo.height) {
    throw new HttpError(400, "invalid_photo", "The photo's size does not match its width and height.");
  }
  return { attemptId: value.attemptId.toLowerCase(), position, target, photo: { bytes: stripped.bytes, width: stripped.width, height: stripped.height } };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/** The visit a founding records, derived from the attempt so a retry can find it. */
export async function founderVisitId(attemptId: string): Promise<string> {
  const hex = await sha256Hex(new TextEncoder().encode(`kip-founder-visit:${attemptId}`));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function coverUrl(origin: string, parkId: string, sha256: string): string {
  return `${origin}/api/parks/${parkId}/cover/${sha256}.jpg`;
}

function json(data: unknown, status = 200, cacheControl = "no-store", extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cacheControl, "x-content-type-options": "nosniff", ...extra },
  });
}

function flagList(flags: readonly string[]) {
  return flags.filter((flag): flag is PhotoFlag => flag in FLAG_MESSAGES).map((code) => ({ code, message: FLAG_MESSAGES[code] }));
}

/** `reviewableUntil` is when the kept photo goes, or null once it is gone. */
function checkResponse(outcome: "reject" | "unsure", flags: readonly string[], keptAt: string | null): Response {
  const list = outcome === "reject" ? flagList(flags) : [];
  return json({
    outcome: outcome === "reject" ? "rejected" : "unsure",
    flags: list,
    message: outcome === "reject" ? list[0]?.message ?? FLAG_MESSAGES.not_park : UNSURE_MESSAGE,
    reviewableUntil: keptAt ? new Date(Date.parse(keptAt) + REVIEW_KEEP_MS).toISOString() : null,
  });
}

function foundedResponse(origin: string, founded: FoundedRecord): Response {
  return json({
    outcome: "founded",
    park: { id: founded.parkId, name: founded.parkName },
    coverUrl: coverUrl(origin, founded.parkId, founded.photoSha256),
    visit: founded.visit ? apiVisit(founded.visit) : null,
    founderPoints: founded.founderPoints,
  });
}

function alreadyFounded(handle: string | null): HttpError {
  return new HttpError(409, "already_founded", handle ? `This park already has a founder: @${handle}.` : "This park already has a founder.");
}

type Resolved =
  | { kind: "existing"; parkId: string; name: string; label: string; outline: MultiPolygon }
  | { kind: "osm"; parkId: string; feature: OsmFeature; nearby: NearbyPark[] };

async function resolveExisting(handlers: FoundersHandlers, store: FoundersStore, parkId: string, fallback: OsmFeature | null): Promise<Resolved> {
  const [parks, hidden, founders] = await Promise.all([store.catalogueParks([parkId]), store.hidden([parkId]), store.founders([parkId])]);
  const park = parks.get(parkId);
  if (!park || hidden.has(parkId)) throw new HttpError(404, "park_not_found", "That park is not in Parkdex.");
  const founder = founders.get(parkId);
  if (founder) throw alreadyFounded(founder.handle);
  // The catalogue outline decides; an OpenStreetMap outline stands in for a park without one.
  const outline = park.boundary ?? fallback?.geometry ?? null;
  if (!outline) throw new HttpError(422, "no_outline", "This park has no outline yet, so it can't be founded.");
  return { kind: "existing", parkId, name: park.name, label: park.category, outline };
}

async function resolveTarget(handlers: FoundersHandlers, store: FoundersStore, target: FoundTarget, position: DevicePosition): Promise<Resolved> {
  if ("parkId" in target) return resolveExisting(handlers, store, target.parkId, null);
  const publishedId = osmParkId(target.osm);
  if ((await store.catalogueParks([publishedId])).has(publishedId)) return resolveExisting(handlers, store, publishedId, null);
  const feature = await handlers.osm().feature(target.osm);
  if (!feature) throw new HttpError(404, "park_not_found", "That park is not on OpenStreetMap.");
  const nearby = await handlers.nearbyParks(position.lat, position.lng, CATALOGUE_KM);
  // An outline that is already a Parkdex park is founded as that park, never published twice.
  const listed = catalogueMatch(feature, nearby);
  if (listed) return resolveExisting(handlers, store, listed.parkId, feature);
  if (!feature.name) throw new HttpError(422, "unnamed_park", "This park has no name on OpenStreetMap yet, so it can't be founded.");
  return { kind: "osm", parkId: publishedId, feature, nearby };
}

function moderationRecord(answers: PhotoAnswers | null, threshold: number, at: string, flags: string[]) {
  return { version: 1, checkedAt: at, model: answers?.model ?? null, threshold, answers: answers?.answers ?? null, flags };
}

async function postFound(request: Request, handlers: FoundersHandlers): Promise<Response> {
  const { accountId } = await handlers.mutation();
  const input = validateFoundBody(await readJsonBody(request, MAX_FOUND_BODY_BYTES));
  const store = handlers.store();
  const at = new Date(handlers.now()).toISOString();
  const photoSha256 = await sha256Hex(input.photo.bytes);
  const visitId = await founderVisitId(input.attemptId);

  if (!await store.hasHandle(accountId)) throw new HttpError(409, "handle_required", "Choose a handle before founding a park.");

  // A retry with the same attempt answers what the first request did, without asking the model again.
  const earlier = await store.attempt(accountId, input.attemptId, visitId);
  if (earlier.founded) {
    if (earlier.founded.photoSha256 !== photoSha256) throw new HttpError(409, "attempt_id_reused", "This attempt ID was already used for another photo.");
    return foundedResponse(handlers.publicOrigin, earlier.founded);
  }
  if (earlier.check) {
    if (earlier.check.photoSha256 !== photoSha256) throw new HttpError(409, "attempt_id_reused", "This attempt ID was already used for another photo.");
    if (earlier.check.outcome === "reject" || earlier.check.outcome === "unsure") return checkResponse(earlier.check.outcome, earlier.check.flags, earlier.check.keptAt);
  }

  const usage = await store.usage(accountId, at);
  if (usage.foundedLastDay >= FOUNDED_PER_DAY) throw new HttpError(429, "rate_limited_founding", "You've founded a lot of parks today. Try again tomorrow.");
  if (usage.checksLastHour >= CHECKS_PER_HOUR) throw new HttpError(429, "rate_limited_founding", "That's a lot of photos this hour. Try again a little later.");

  const resolved = await resolveTarget(handlers, store, input.target, input.position);
  const outline = resolved.kind === "osm" ? resolved.feature.geometry : resolved.outline;
  const where = positionInside(input.position, outline);
  if (!where.inside) throw new HttpError(422, "not_in_park", "You need to be in the park to found it. Walk a little further in and try again.");

  const osm = "osm" in input.target && resolved.kind === "osm" ? input.target.osm : null;
  const checker = handlers.photoChecker();
  const answers = checker
    ? await checker({
      jpeg: input.photo.bytes,
      parkName: resolved.kind === "osm" ? resolved.feature.name ?? "an unnamed park" : resolved.name,
      parkKind: resolved.kind === "osm" ? resolved.feature.kind : resolved.label,
    }).catch(() => null)
    : null;
  const decision = answers ? decidePhoto(answers, handlers.threshold) : null;
  const outcome = decision?.outcome ?? "unavailable";
  const flags: string[] = decision?.flags ?? [];
  const photo = { sha256: photoSha256, base64: Buffer.from(input.photo.bytes).toString("base64"), width: input.photo.width, height: input.photo.height };
  // A photo the player can appeal (#153) is kept for a day, with the position and the target.
  const keep: KeptAttempt | null = decision && decision.outcome !== "approve" ? {
    parkName: resolved.kind === "osm" ? resolved.feature.name ?? "Unnamed park" : resolved.name,
    osmFeature: resolved.kind === "osm" ? resolved.feature : null,
    position: { lat: input.position.lat, lng: input.position.lng, accuracyM: input.position.accuracyM },
    photo,
  } : null;
  await store.recordCheck({
    id: handlers.uuid(), accountId, attemptId: input.attemptId, parkId: resolved.parkId, osm, at, outcome, flags, photoSha256,
    moderation: answers ? moderationRecord(answers, handlers.threshold, at, flags) : null,
    keep,
  });
  handlers.emit("founder_photo_checked", { parkId: resolved.parkId, outcome, flags: flags.join(","), source: resolved.kind === "osm" ? "osm_new" : "existing" });
  if (!decision) throw new HttpError(503, "photo_check_unavailable", UNAVAILABLE_MESSAGE);
  if (decision.outcome !== "approve") return checkResponse(decision.outcome, decision.flags, at);

  const common = { accountId, attemptId: input.attemptId, visitId, at, photo, moderation: moderationRecord(answers, handlers.threshold, at, []) };
  let result: FoundResult;
  let source: "osm_new" | "existing" = resolved.kind === "osm" ? "osm_new" : "existing";
  if (resolved.kind === "osm") {
    const feature = resolved.feature;
    const marker = markerPoint(feature.geometry, input.position);
    const region = await regionFor({ nearbyParks: (lat, lng, km) => handlers.nearbyParks(lat, lng, km) }, resolved.nearby, marker);
    const proposalId = handlers.uuid();
    const park = parkFromProposal(feature, { id: proposalId, name: feature.name ?? "", note: "", point: marker, createdAt: at }, region, marker);
    const distanceM = Math.round(where.distanceM);
    result = await store.foundOsm({
      ...common,
      park,
      osm: { type: feature.type, id: feature.id },
      proposal: {
        id: proposalId,
        // The shape the operator dashboard shows for proposals.
        moderation: {
          version: 1, checkedAt: at, model: answers?.model ?? null, threshold: handlers.threshold,
          answers: answers?.answers ?? null, reasons: ["Founded by a signed-in player standing in the park, with an approved photo."],
          osm: { type: feature.type, id: feature.id, name: feature.name, kind: feature.kind, areaM2: feature.areaM2, distanceM, containsPin: distanceM === 0 },
          nearby: [],
        },
      },
    });
    if (result.status === "park_exists") {
      // Published another way since the lookup: found it as the catalogue park it now is.
      source = "existing";
      result = await store.foundExisting({ ...common, parkId: park.id });
    }
  } else {
    // The outline the player chose, when it is this catalogue park, so its pending reviews close too.
    result = await store.foundExisting({ ...common, parkId: resolved.parkId, osm: "osm" in input.target ? input.target.osm : null });
  }

  if (result.status !== "founded") {
    if (result.status === "already_founded" || result.status === "park_exists") {
      const founder = (await store.founders([resolved.parkId])).get(resolved.parkId);
      throw alreadyFounded(founder?.handle ?? null);
    }
    if (result.status === "park_missing" || result.status === "park_hidden") throw new HttpError(404, "park_not_found", "That park is not in Parkdex.");
    if (result.status === "attempt_reused") throw new HttpError(409, "attempt_id_reused", "This attempt ID was already used for another park.");
    if (result.status === "blocked") throw new HttpError(409, "founding_blocked", "This park can't be founded right now.");
    throw new HttpError(503, "service_unavailable", "Founding didn't finish. Try again in a moment.");
  }

  handlers.emit("park_founded", { parkId: result.record.parkId, source });
  if (result.record.visit) {
    for (const event of visitEvents({ status: "recorded", visit: result.record.visit }, accountId)) {
      handlers.emit(event.name as FounderEventName, { parkId: event.parkId, pointsEarned: event.pointsEarned });
    }
  }
  return foundedResponse(handlers.publicOrigin, result.record);
}

/** `POST /api/parks/found/review`: asks the operator to look at a rejected or unsure photo (#153). */
async function postReview(request: Request, handlers: FoundersHandlers): Promise<Response> {
  const { accountId } = await handlers.mutation();
  const body = exactKeys(await readJsonBody(request, 1024), ["attemptId"]);
  if (typeof body.attemptId !== "string" || !UUID.test(body.attemptId)) throw new HttpError(400, "invalid_request", "Invalid attempt ID.");
  const attemptId = body.attemptId.toLowerCase();
  const store = handlers.store();
  if (!await store.hasHandle(accountId)) throw new HttpError(409, "handle_required", "Choose a handle before asking for a review.");

  // Asking again for the same attempt answers with the request it already made.
  const found = await store.reviewAttempt(accountId, attemptId);
  if (found.request) return json({ status: found.request.status, requestId: found.request.id });
  const { check } = found;
  if (!check) throw new HttpError(404, "attempt_not_found", "We couldn't find that photo. Take a new one and try again.");
  if (check.outcome !== "reject" && check.outcome !== "unsure") throw new HttpError(409, "not_reviewable", "Only photos the check turned down can be reviewed.");
  if (!check.kept) throw new HttpError(410, "photo_expired", "That photo is no longer kept. Take a new one and try again.");
  const [hidden, founders] = await Promise.all([store.hidden([check.parkId]), store.founders([check.parkId])]);
  if (hidden.has(check.parkId)) throw new HttpError(404, "park_not_found", "That park is not in Parkdex.");
  const founder = founders.get(check.parkId);
  if (founder) throw alreadyFounded(founder.handle);

  const requestId = handlers.uuid();
  const at = new Date(handlers.now()).toISOString();
  const result = await store.requestReview({ id: requestId, accountId, attemptId, parkId: check.parkId, at, perDay: REVIEWS_PER_DAY });
  if (result === "exists") {
    // A concurrent request for the same attempt won; answer with it.
    const again = await store.reviewAttempt(accountId, attemptId);
    if (again.request) return json({ status: again.request.status, requestId: again.request.id });
    throw new HttpError(503, "service_unavailable", "Your request didn't go through. Try again in a moment.");
  }
  if (result === "pending") throw new HttpError(409, "review_pending", "You already asked for a review of this park. We'll let you know.");
  if (result === "limited") throw new HttpError(429, "rate_limited_review", "You can ask for 3 reviews a day. Try again tomorrow.");
  if (result === "expired") throw new HttpError(410, "photo_expired", "That photo is no longer kept. Take a new one and try again.");
  if (result === "already_founded") {
    const current = (await store.founders([check.parkId])).get(check.parkId);
    throw alreadyFounded(current?.handle ?? null);
  }
  handlers.emit("founding_review_requested", { parkId: check.parkId, outcome: check.outcome, source: check.osm ? "osm_new" : "existing" });
  return json({ status: "pending", requestId });
}

/** `POST /api/parks/found/review/seen`: the app showed these decisions. */
async function postReviewSeen(request: Request, handlers: FoundersHandlers): Promise<Response> {
  const { accountId } = await handlers.mutation();
  const body = exactKeys(await readJsonBody(request, 4 * 1024), ["requestIds"]);
  const ids = body.requestIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_SEEN_IDS || !ids.every((id) => typeof id === "string" && UUID.test(id))) {
    throw new HttpError(400, "invalid_request", `Send 1 to ${MAX_SEEN_IDS} request IDs.`);
  }
  const at = new Date(handlers.now()).toISOString();
  const seen = await handlers.store().markReviewsSeen(accountId, (ids as string[]).map((id) => id.toLowerCase()), at);
  return json({ seen });
}

async function getCover(request: Request, handlers: FoundersHandlers, parkId: string, sha256: string): Promise<Response> {
  const store = handlers.store();
  const [bytes, hidden] = await Promise.all([store.cover(parkId, sha256), store.hidden([parkId])]);
  if (!bytes || hidden.has(parkId)) throw new HttpError(404, "not_found", "Cover photo not found.");
  const etag = `"${sha256}"`;
  const headers = {
    "content-type": "image/jpeg",
    // The URL names the bytes, so they never change. Only browsers cache it: a shared cache
    // would keep serving a photo after its park is hidden or its founder deletes their account.
    "cache-control": "public, max-age=31536000, immutable",
    etag,
    "x-content-type-options": "nosniff",
  };
  const match = request.headers.get("if-none-match");
  if (match && match.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(bytes).buffer, { status: 200, headers: { ...headers, "content-length": String(bytes.length) } });
}

async function getSummary(handlers: FoundersHandlers, parkId: string): Promise<Response> {
  const account = await handlers.optionalAccount();
  const store = handlers.store();
  const now = new Date(handlers.now()).toISOString();
  const [summary, hidden] = await Promise.all([store.summary(parkId, account?.accountId ?? null, now), store.hidden([parkId])]);
  if (!summary || hidden.has(parkId)) throw new HttpError(404, "park_not_found", "That park is not in Parkdex.");
  const body = {
    parkId,
    founder: summary.founder ? { handle: summary.founder.handle, foundedAt: summary.founder.foundedAt } : null,
    coverUrl: summary.founder ? coverUrl(handlers.publicOrigin, parkId, summary.founder.photoSha256) : null,
    visits: { total: summary.total, last30Days: summary.last30Days, mine: summary.mine },
  };
  // Public counts may be a minute old; a signed-in answer carries the caller's own count.
  return json(body, 200, account ? "private, no-store" : "public, max-age=60", { vary: "Authorization, Cookie" });
}

/**
 * Routes `/api/parks/found`, `/api/parks/found/review`, `/api/parks/found/review/seen`,
 * `/api/parks/:id/cover/:sha256.jpg` and `/api/parks/:id/summary`. Null for other paths.
 */
export async function handleFoundersRequest(request: Request, handlers: FoundersHandlers): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/api/parks/found") {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
    return postFound(request, handlers);
  }
  if (path === "/api/parks/found/review") {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
    return postReview(request, handlers);
  }
  if (path === "/api/parks/found/review/seen") {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
    return postReviewSeen(request, handlers);
  }
  const cover = COVER_PATH.exec(path);
  if (cover) {
    if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Use GET.");
    return getCover(request, handlers, cover[1], cover[2]);
  }
  const summary = SUMMARY_PATH.exec(path);
  if (summary && summary[1].length <= 160) {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    return getSummary(handlers, summary[1]);
  }
  return null;
}
