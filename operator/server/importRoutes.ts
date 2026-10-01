import { HttpError, readJsonBody } from "../../worker/validation.js";
import { assertWebp, badgeAsset, badgeUploadsConfigured, imageType, sceneSlug, sha256Hex, uploadAndVerifyBadge, type BadgeEnv } from "./badges.js";
import { BIOMES, CATEGORIES, draftFromLegacy, MAX_IMAGE_BYTES, publishBlockers, RARITIES, SHAPES, type Draft, type DraftFields, type DraftStore } from "./drafts.js";
import type { LegacySource } from "./legacy.js";

/** Routes for importing legacy parks as drafts, editing them, and publishing them to Parkdex. */

export interface ImportContext {
  json(data: unknown, status?: number): Response;
  requireSameOrigin(): void;
  drafts(): DraftStore;
  legacy: LegacySource;
  env: BadgeEnv;
  fetch?: typeof fetch;
  randomSeed(): number;
}

const ID = /^[a-z0-9][a-z0-9-]{0,159}$/;

async function readBytes(request: Request, max: number): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) throw new HttpError(413, "too_large", "That image is larger than 4 MB.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > max) throw new HttpError(413, "too_large", "That image is larger than 4 MB.");
  if (!bytes.byteLength) throw new HttpError(400, "empty_body", "No image was uploaded.");
  return bytes;
}

function textField(value: unknown, label: string, max: number, allowEmpty = true): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_field", `${label} must be text.`);
  const trimmed = value.trim();
  // The account backup contract rejects control characters in park text.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) throw new HttpError(400, "invalid_field", `${label} contains unsupported characters.`);
  if (trimmed.length > max || (!allowEmpty && !trimmed)) throw new HttpError(400, "invalid_field", `${label} must be ${allowEmpty ? "" : "1 to "}${max} characters${allowEmpty ? " or fewer" : ""}.`);
  return trimmed;
}

function oneOf(value: unknown, options: readonly string[], label: string, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value === "string" && options.includes(value)) return value;
  throw new HttpError(400, "invalid_field", `Unknown ${label}.`);
}

export function validateDraftPatch(body: unknown): Partial<DraftFields> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_request", "Invalid draft update.");
  const input = body as Record<string, unknown>;
  const allowed = ["name", "short", "category", "region", "biome", "shape", "rarity", "blurb"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpError(400, "invalid_request", "Invalid draft update.");
  const patch: Partial<DraftFields> = {};
  if ("name" in input) patch.name = textField(input.name, "Name", 140, false);
  if ("short" in input) patch.short = textField(input.short, "Short name", 140);
  if ("region" in input) patch.region = textField(input.region, "Region", 140);
  if ("blurb" in input) patch.blurb = textField(input.blurb, "Description", 800);
  if ("category" in input) patch.category = oneOf(input.category, CATEGORIES, "category", true);
  if ("rarity" in input) patch.rarity = oneOf(input.rarity, RARITIES, "rarity", true);
  if ("biome" in input) patch.biome = oneOf(input.biome, BIOMES, "biome", false)!;
  if ("shape" in input) patch.shape = oneOf(input.shape, SHAPES, "shape", false)!;
  return patch;
}

function draftView(draft: Draft, env: BadgeEnv) {
  return { ...draft, blockers: publishBlockers(draft), badgeUploads: badgeUploadsConfigured(env) };
}

/** Everything an LLM or image model needs to propose a name, description and badge for this park. */
export function aiBrief(draft: Draft) {
  const record = (draft.source.record ?? {}) as Record<string, unknown>;
  return {
    schema: "parkdex.park-brief/v1",
    task: "Propose a player-facing name, a short name, a description of 800 characters or fewer, and a badge scene for this park.",
    park: {
      id: draft.id,
      legacyName: record.name ?? draft.name,
      currentName: draft.name,
      short: draft.short,
      category: draft.category,
      region: draft.region,
      location: { lat: draft.lat, lng: draft.lng },
      legacyDescription: record.description ?? null,
      source: { name: record.sourceName ?? null, url: record.sourceUrl ?? null, id: record.sourceId ?? null },
      biome: draft.biome,
      rarity: draft.rarity,
      currentDescription: draft.blurb || null,
    },
    boundary: draft.geometry,
    referencePhoto: draft.referencePhotoType ? `/api/drafts/${draft.id}/reference` : null,
    constraints: { nameMaxLength: 140, shortMaxLength: 140, descriptionMaxLength: 800, badge: "Square WebP, 4 MB or smaller" },
  };
}

export async function routeImport(request: Request, path: string, context: ImportContext): Promise<Response | null> {
  const { json } = context;
  if (path === "/api/legacy/parks") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    const [parks, drafts, published] = await Promise.all([context.legacy.list(), context.drafts().list(), context.drafts().publishedParkIds()]);
    const drafted = new Map(drafts.map((draft) => [draft.id, draft.status]));
    return json({
      parks: parks.map((park) => ({ ...park, status: published.has(park.id) ? "in-parkdex" : drafted.has(park.id) ? "draft" : "available" })),
    });
  }
  const legacyMatch = /^\/api\/legacy\/parks\/([^/]+)$/.exec(path);
  if (legacyMatch) {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    const park = ID.test(legacyMatch[1]) ? await context.legacy.get(legacyMatch[1]) : null;
    if (!park) throw new HttpError(404, "not_found", "That park is not in the legacy map.");
    return json({ park });
  }

  if (path === "/api/drafts") {
    if (request.method === "GET") return json({ drafts: await context.drafts().list(), badgeUploads: badgeUploadsConfigured(context.env) });
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use GET or POST.");
    context.requireSameOrigin();
    const body = await readJsonBody(request, 1024) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Object.keys(body).join() !== "legacyId" || typeof body.legacyId !== "string" || !ID.test(body.legacyId)) {
      throw new HttpError(400, "invalid_request", "Send the legacy park id to import.");
    }
    const park = await context.legacy.get(body.legacyId);
    if (!park) throw new HttpError(404, "not_found", "That park is not in the legacy map.");
    const sourceSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify({ record: park.record, boundaryProperties: park.boundaryProperties, geometry: park.geometry })));
    const draft = await context.drafts().create({ ...draftFromLegacy(park, context.randomSeed()), sourceSha256 });
    return json({ draft: draftView(draft, context.env) }, 201);
  }

  const match = /^\/api\/drafts\/([^/]+)(?:\/(badge|reference|brief|publish))?$/.exec(path);
  if (!match) return null;
  const id = match[1];
  if (!ID.test(id)) throw new HttpError(404, "not_found", "Draft not found.");
  const drafts = context.drafts();
  const action = match[2];

  if (!action) {
    if (request.method === "GET") {
      const draft = await drafts.get(id);
      if (!draft) throw new HttpError(404, "not_found", "Draft not found.");
      return json({ draft: draftView(draft, context.env) });
    }
    context.requireSameOrigin();
    if (request.method === "PATCH") {
      const draft = await drafts.update(id, validateDraftPatch(await readJsonBody(request, 8192)));
      if (!draft) throw new HttpError(404, "not_found", "Draft not found, or it is already published.");
      return json({ draft: draftView(draft, context.env) });
    }
    if (request.method === "DELETE") {
      if (!await drafts.remove(id)) throw new HttpError(404, "not_found", "Draft not found, or it is already published.");
      return json({ ok: true });
    }
    throw new HttpError(405, "method_not_allowed", "Use GET, PATCH or DELETE.");
  }

  if (action === "brief") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    const draft = await drafts.get(id);
    if (!draft) throw new HttpError(404, "not_found", "Draft not found.");
    return json(aiBrief(draft));
  }

  if (action === "badge" || action === "reference") {
    if (request.method === "GET") {
      const image = action === "badge"
        ? await drafts.getBadge(id).then((bytes) => bytes && { bytes, contentType: "image/webp" })
        : await drafts.getReferencePhoto(id);
      if (!image) throw new HttpError(404, "not_found", "No image uploaded yet.");
      return new Response(new Uint8Array(image.bytes), { headers: { "content-type": image.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
    context.requireSameOrigin();
    let draft: Draft | null;
    if (request.method === "DELETE") {
      draft = action === "badge" ? await drafts.setBadge(id, null, null) : await drafts.setReferencePhoto(id, null, null);
    } else if (request.method === "PUT") {
      const bytes = await readBytes(request, MAX_IMAGE_BYTES);
      if (action === "badge") {
        assertWebp(bytes);
        draft = await drafts.setBadge(id, bytes, sceneSlug(id, await sha256Hex(bytes)));
      } else {
        const type = imageType(bytes);
        if (!type) throw new HttpError(415, "invalid_image", "Upload a JPEG, PNG or WebP photo.");
        draft = await drafts.setReferencePhoto(id, bytes, type);
      }
    } else {
      throw new HttpError(405, "method_not_allowed", "Use GET, PUT or DELETE.");
    }
    if (!draft) throw new HttpError(404, "not_found", "Draft not found, or it is already published.");
    return json({ draft: draftView(draft, context.env) });
  }

  // action === "publish"
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
  context.requireSameOrigin();
  const body = await readJsonBody(request, 1024) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || typeof body.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.expectedUpdatedAt))) {
    throw new HttpError(400, "invalid_request", "Send the draft's updatedAt to publish.");
  }
  const draft = await drafts.get(id);
  if (!draft) throw new HttpError(404, "not_found", "Draft not found.");
  const blockers = publishBlockers(draft);
  if (blockers.length) throw new HttpError(422, "draft_incomplete", blockers.join(" "));
  let asset = null;
  if (draft.scene && draft.badgeSha256 && draft.badgeBytes) {
    const bytes = await drafts.getBadge(id);
    if (!bytes) throw new HttpError(409, "badge_changed", "The badge changed while publishing. Try again.");
    asset = badgeAsset(draft.scene, draft.badgeSha256, draft.badgeBytes);
    // The object is immutable and content addressed, so an upload followed by a failed
    // database write is safe to retry.
    await uploadAndVerifyBadge(context.env, asset, bytes, context.fetch);
  }
  const result = await drafts.publish(id, body.expectedUpdatedAt, asset);
  const published = await drafts.get(id);
  return json({ result, draft: published && draftView(published, context.env) });
}
