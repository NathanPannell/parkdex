import { HttpError, readJsonBody } from "../../worker/validation.js";
import { assertWebp, badgeAsset, badgeUploadsConfigured, sceneSlug, sha256Hex, uploadAndVerifyBadge, type BadgeEnv } from "./badges.js";
import { MAX_IMAGE_BYTES } from "./drafts.js";
import { badgeFallbackUrl, validateExpected, validateLiveChanges, type LiveParkDetail, type LiveParkStore } from "./liveParks.js";

/** Routes for reading and editing parks that are already live in Parkdex. */

export interface ParkContext {
  json(data: unknown, status?: number): Response;
  requireSameOrigin(): void;
  parks(): LiveParkStore;
  env: BadgeEnv;
  fetch?: typeof fetch;
}

const ID = /^[a-z0-9][a-z0-9-]{0,159}$/;
/** The badge upload sends the park as the operator opened it in this header, URI encoded. */
export const EXPECTED_HEADER = "x-parkdex-expected";

function view(park: LiveParkDetail, env: BadgeEnv) {
  return { ...park, badgeUrl: park.badgeUrl ?? badgeFallbackUrl(park.scene), badgeUploads: badgeUploadsConfigured(env) };
}

async function load(context: ParkContext, id: string) {
  const park = await context.parks().get(id);
  if (!park) throw new HttpError(404, "not_found", "That park is not in Parkdex.");
  return park;
}

export async function routeParks(request: Request, path: string, context: ParkContext): Promise<Response | null> {
  const { json } = context;
  if (path === "/api/parks") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    return json({ parks: await context.parks().list() });
  }
  if (path === "/api/regions") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    return json({ regions: await context.parks().regions() });
  }
  const match = /^\/api\/parks\/([^/]+)(\/badge)?$/.exec(path);
  if (!match) return null;
  const id = match[1];
  if (!ID.test(id)) throw new HttpError(404, "not_found", "That park is not in Parkdex.");

  if (!match[2]) {
    if (request.method === "GET") return json({ park: view(await load(context, id), context.env) });
    if (request.method !== "PATCH") throw new HttpError(405, "method_not_allowed", "Use GET or PATCH.");
    context.requireSameOrigin();
    const body = await readJsonBody(request, 512 * 1024) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_request", "Send expected and changes.");
    const expected = validateExpected(body.expected);
    if (expected.id !== id) throw new HttpError(400, "invalid_request", "Send the park as you opened it.");
    const changes = validateLiveChanges(body.changes);
    if (!Object.keys(changes).length) throw new HttpError(400, "invalid_request", "Nothing to save.");
    const revision = await context.parks().update(id, expected, changes, null);
    return json({ revision, park: view(await load(context, id), context.env) });
  }

  if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "Use PUT.");
  context.requireSameOrigin();
  if (!badgeUploadsConfigured(context.env)) throw new HttpError(503, "badge_uploads_off", "Badge uploads are not configured on this deployment.");
  let expectedInput: unknown;
  try {
    expectedInput = JSON.parse(decodeURIComponent(request.headers.get(EXPECTED_HEADER) ?? ""));
  } catch {
    throw new HttpError(400, "invalid_request", "Send the park as you opened it.");
  }
  const expected = validateExpected(expectedInput);
  if (expected.id !== id) throw new HttpError(400, "invalid_request", "Send the park as you opened it.");
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) throw new HttpError(413, "too_large", "That image is larger than 4 MB.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) throw new HttpError(400, "empty_body", "No image was uploaded.");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, "too_large", "That image is larger than 4 MB.");
  assertWebp(bytes);
  const sha256 = await sha256Hex(bytes);
  const asset = badgeAsset(sceneSlug(id, sha256), sha256, bytes.byteLength);
  // Content addressed and never overwritten, so an upload followed by a failed save is safe to retry.
  await uploadAndVerifyBadge(context.env, asset, bytes, context.fetch);
  const revision = await context.parks().update(id, expected, {}, asset);
  return json({ revision, park: view(await load(context, id), context.env) });
}
