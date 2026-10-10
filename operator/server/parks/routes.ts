import { JpegError, stripJpegMetadata } from "../../../worker/jpeg.js";
import { readJsonBody } from "../../../worker/validation.js";
import type { DashboardEnv, SectionContext } from "../api.js";
import { allowMethods, databaseUrl, HttpError, json, plainObject } from "../http.js";
import { createNeonLiveParkStore, validateExpected, validateLiveChanges, validateNewPark, type LiveParkStore } from "./liveParks.js";
import { createNeonParkManagerStore, neonRunner, type Bbox, type ParkManagerStore } from "./manager.js";
import { catalogueBox, createSqlOsmStore, matchOutlines, neighbourhood, OSM_LIMIT, osmDraft, parseOsmRef, type OsmStore } from "./osm.js";
import { catalogueMatch } from "../../../worker/catalogueMatch.js";
import type { FoundingReviewStore } from "../../../worker/founding-reviews.js";
import { reviewRoutes } from "./reviews.js";

/**
 * Parks section under /api/parks: the map-first park manager. It reads and edits the live
 * catalogue of the database the toggle chose, hides, unhides and deletes parks, moderates
 * founders and covers, creates parks from OpenStreetMap outlines, and decides players' requests
 * for a manual review of a founding photo (/api/parks/review, reviews.ts).
 */

/** Settings this section reads from the deployment. */
export interface ParksEnv {}

export interface ParksDependencies {
  liveParkStore?(env: DashboardEnv): LiveParkStore;
  parkManagerStore?(env: DashboardEnv): ParkManagerStore;
  osmStore?(env: DashboardEnv): OsmStore;
  /** Manual review requests for founding photos (#153). */
  foundingReviewStore?(env: DashboardEnv): FoundingReviewStore;
  /** The clock, so tests can pin "last 30 days" and flag falls. */
  now?(): number;
}

const ID = /^[a-z0-9][a-z0-9-]{0,159}$/;
/** Map layers load by view; wider views would mean thousands of outlines in one response. */
const MAX_OUTLINE_SPAN_DEG = 3;
const MAX_OSM_SPAN_DEG = 1.2;
/** The same limits founding applies to cover photos (docs/park-founders.md). */
const MAX_COVER_BYTES = 1_572_864;
const MAX_COVER_SIDE = 2048;

function bboxParam(url: URL, maxSpan: number): Bbox {
  const parts = (url.searchParams.get("bbox") ?? "").split(",").map((part) => Number(part));
  const [west, south, east, north] = parts;
  if (parts.length !== 4 || !parts.every(Number.isFinite) || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    throw new HttpError(400, "invalid_bbox", "Send bbox as west,south,east,north.");
  }
  if (east - west > maxSpan || north - south > maxSpan) throw new HttpError(422, "zoom_in", "Zoom in to load this layer.");
  return { west, south, east, north };
}

function reasonOf(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || text.length > 500) throw new HttpError(400, "invalid_reason", "The reason must be 500 characters or fewer of plain text.");
  return text || "Hidden from the operator dashboard.";
}

function base64Bytes(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    throw new HttpError(400, "invalid_photo", "The photo is not valid base64.");
  }
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/** A replacement cover gets the same treatment as a founder's photo: JPEG only, metadata removed, within the size limits. */
async function coverInput(body: unknown) {
  const input = plainObject(body, ["photo"], "Send the photo as { photo: { base64 } }.");
  const photo = plainObject(input.photo, ["base64"], "Send the photo as { photo: { base64 } }.");
  if (typeof photo.base64 !== "string" || !photo.base64) throw new HttpError(400, "invalid_photo", "Send the photo as { photo: { base64 } }.");
  let stripped;
  try {
    stripped = stripJpegMetadata(base64Bytes(photo.base64));
  } catch (error) {
    if (error instanceof JpegError) throw new HttpError(400, "invalid_photo", "The cover must be a JPEG photo.");
    throw error;
  }
  if (stripped.bytes.byteLength > MAX_COVER_BYTES || stripped.width > MAX_COVER_SIDE || stripped.height > MAX_COVER_SIDE) {
    throw new HttpError(413, "photo_too_large", "The cover must be at most 1.5 MiB and 2,048 px on each side.");
  }
  return { sha256: await sha256Hex(stripped.bytes), base64: base64Of(stripped.bytes), width: stripped.width, height: stripped.height };
}

export async function parksRoutes(request: Request, context: SectionContext): Promise<Response | null> {
  const { path, url } = context;
  const deps = context.dependencies;
  const live = () => deps.liveParkStore?.(context.env) ?? createNeonLiveParkStore(databaseUrl(context.env));
  const manager = () => deps.parkManagerStore?.(context.env) ?? createNeonParkManagerStore(databaseUrl(context.env));
  const osm = () => deps.osmStore?.(context.env) ?? createSqlOsmStore(neonRunner(databaseUrl(context.env)));
  const now = () => new Date(deps.now?.() ?? Date.now()).toISOString();

  if (path === "/api/parks") {
    allowMethods(request, "GET");
    return json({ parks: await manager().rows() });
  }
  // The bare words below are checked before /api/parks/<id>; no park id is one of them.
  if (path === "/api/parks/regions") {
    allowMethods(request, "GET");
    return json({ regions: await live().regions() });
  }
  if (path === "/api/parks/stats") {
    allowMethods(request, "GET");
    return json({ stats: await manager().stats() });
  }
  if (path === "/api/parks/outlines") {
    allowMethods(request, "GET");
    return json({ outlines: await manager().outlines(bboxParam(url, MAX_OUTLINE_SPAN_DEG)) });
  }
  if (path === "/api/parks/osm") {
    allowMethods(request, "GET");
    const view = bboxParam(url, MAX_OSM_SPAN_DEG);
    const store = osm();
    const [features, catalogue] = await Promise.all([store.inBox(view, OSM_LIMIT), store.catalogue(catalogueBox(view))]);
    return json({ outlines: matchOutlines(features, catalogue, view), truncated: features.length >= OSM_LIMIT });
  }

  if (path === "/api/parks/review" || path.startsWith("/api/parks/review/")) return reviewRoutes(request, context, now);

  const osmMatch = /^\/api\/parks\/osm\/([^/]+)$/.exec(path);
  if (osmMatch) return osmRoute(request, context, osm(), osmMatch[1], now);

  const match = /^\/api\/parks\/([^/]+)(?:\/(hide|unhide|founder|cover))?$/.exec(path);
  if (!match) return null;
  const [, id, action] = match;
  if (!ID.test(id)) throw new HttpError(404, "not_found", "That park is not in Parkdex.");

  if (action === "cover") {
    if (request.method === "GET") {
      const cover = await manager().cover(id);
      if (!cover) throw new HttpError(404, "not_found", "This park has no cover photo.");
      return new Response(new Uint8Array(cover.bytes), {
        headers: {
          "content-type": cover.contentType, "cache-control": "private, no-store", etag: `"${cover.sha256}"`,
          "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        },
      });
    }
    allowMethods(request, "GET", "PUT");
    context.requireSameOrigin();
    const photo = await coverInput(await readJsonBody(request, 2_200_000));
    await manager().replaceCover(id, photo, now());
    return json({ ok: true, photoSha256: photo.sha256 });
  }
  if (action === "founder") {
    allowMethods(request, "DELETE");
    context.requireSameOrigin();
    await manager().clearFounder(id);
    return json({ ok: true });
  }
  if (action === "hide") {
    allowMethods(request, "POST");
    context.requireSameOrigin();
    const body = request.headers.get("content-type") ? plainObject(await readJsonBody(request, 4096), ["reason"], "Send { reason }.") : {};
    return json({ revision: await manager().hide(id, reasonOf(body.reason)) });
  }
  if (action === "unhide") {
    allowMethods(request, "POST");
    context.requireSameOrigin();
    return json({ revision: await manager().unhide(id) });
  }

  if (request.method === "GET") {
    const [park, activity] = await Promise.all([live().get(id), manager().activity(id, now())]);
    if (!park || !activity) throw new HttpError(404, "not_found", "That park is not in Parkdex.");
    return json({ park, activity });
  }
  allowMethods(request, "GET", "PATCH", "DELETE");
  context.requireSameOrigin();
  if (request.method === "DELETE") return json({ revision: await manager().remove(id) });

  const store = live();
  const body = await readJsonBody(request, 512 * 1024) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_request", "Send expected and changes.");
  const expected = validateExpected(body.expected);
  if (expected.id !== id) throw new HttpError(400, "invalid_request", "Send the park as you opened it.");
  const changes = validateLiveChanges(body.changes);
  if (!Object.keys(changes).length) throw new HttpError(400, "invalid_request", "Nothing to save.");
  const revision = await store.update(id, expected, changes);
  const park = await store.get(id);
  if (!park) throw new HttpError(404, "not_found", "That park is not in Parkdex.");
  return json({ revision, park });
}

/** GET prefills the create form from the outline; POST publishes it as a new park. */
async function osmRoute(request: Request, context: SectionContext, store: OsmStore, value: string, now: () => string): Promise<Response> {
  const ref = parseOsmRef(value);
  if (!ref) throw new HttpError(404, "not_found", "That OpenStreetMap outline is not in the park table.");
  allowMethods(request, "GET", "POST");
  if (request.method === "POST") context.requireSameOrigin();
  const feature = await store.feature(ref);
  if (!feature) throw new HttpError(404, "not_found", "That OpenStreetMap outline is not in the park table.");
  const catalogue = await store.catalogue(neighbourhood(feature));
  const inParkdex = catalogueMatch(feature, catalogue);
  const draft = osmDraft(feature, catalogue);
  if (request.method === "GET") {
    const { source: _source, ...park } = draft;
    return json({ outline: matchOutlines([feature], catalogue)[0], inParkdex, draft: park });
  }
  // Checked again on publish: the catalogue may have changed since the form opened.
  if (inParkdex) throw new HttpError(409, "already_in_parkdex", `This outline is already in Parkdex as ${inParkdex.name}.`);
  const body = plainObject(await readJsonBody(request, 16 * 1024), ["park"], "Send { park }.");
  const fields = validateNewPark(body.park);
  const at = now();
  const park = { ...draft, ...fields, source: { ...draft.source, operator: { action: "create_from_osm", at } } };
  const revision = await store.publish(park, at);
  return json({ revision, parkId: park.id }, 201);
}
