import { HttpError, readJsonBody } from "../../worker/validation.js";
import { assertWebp, badgeAsset, badgeUploadsConfigured, imageType, sceneSlug, sha256Hex, uploadAndVerifyBadge, type BadgeEnv } from "./badges.js";
import type { ParkProposalStore } from "../../worker/parkProposals.js";
import { BIOMES, CATEGORIES, draftFromLegacy, draftFromProposal, MAX_IMAGE_BYTES, publishBlockers, RARITIES, SHAPE_FOR_CATEGORY, type Draft, type DraftFields, type DraftPlacement, type DraftStore, type ProposalSource } from "./drafts.js";
import { normalizeGeometry, type LegacySource } from "./legacy.js";
import { bestPhoto, downloadPhoto, searchPhotos } from "./photos.js";

/** Routes for importing legacy parks as drafts, editing them, and publishing them to Parkdex. */

export interface ImportContext {
  json(data: unknown, status?: number): Response;
  requireSameOrigin(): void;
  drafts(): DraftStore;
  proposals(): ParkProposalStore;
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

function coordinate(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new HttpError(400, "invalid_field", `${label} is out of range.`);
  return Math.round(value * 1e6) / 1e6;
}

export function validateDraftPatch(body: unknown): Partial<DraftFields & DraftPlacement> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_request", "Invalid draft update.");
  const input = body as Record<string, unknown>;
  const allowed = ["name", "short", "category", "region", "biome", "rarity", "blurb", "geometry", "lat", "lng"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpError(400, "invalid_request", "Invalid draft update.");
  if (("lat" in input) !== ("lng" in input)) throw new HttpError(400, "invalid_request", "Send the pin's latitude and longitude together.");
  const patch: Partial<DraftFields & DraftPlacement> = {};
  if ("name" in input) patch.name = textField(input.name, "Name", 140, false);
  if ("short" in input) patch.short = textField(input.short, "Short name", 140);
  if ("region" in input) patch.region = textField(input.region, "Region", 140);
  if ("blurb" in input) patch.blurb = textField(input.blurb, "Description", 800);
  if ("category" in input) {
    patch.category = oneOf(input.category, CATEGORIES, "category", true);
    // The badge shape always follows the category.
    patch.shape = SHAPE_FOR_CATEGORY[patch.category ?? ""] ?? "circle";
  }
  if ("rarity" in input) patch.rarity = oneOf(input.rarity, RARITIES, "rarity", true);
  if ("biome" in input) patch.biome = oneOf(input.biome, BIOMES, "biome", false)!;
  if ("geometry" in input) patch.geometry = input.geometry === null ? null : normalizeGeometry(input.geometry, "The boundary");
  if ("lat" in input) {
    patch.lat = coordinate(input.lat, -90, 90, "Latitude");
    patch.lng = coordinate(input.lng, -180, 180, "Longitude");
  }
  return patch;
}

function draftView(draft: Draft, env: BadgeEnv) {
  return { ...draft, blockers: publishBlockers(draft), badgeUploads: badgeUploadsConfigured(env) };
}

/** A short brief for an LLM or image model: who the park is, not how its data was sourced. */
export function aiBrief(draft: Draft) {
  const record = (draft.source.record ?? {}) as Record<string, unknown>;
  const proposal = draft.source.proposal as ProposalSource | undefined;
  const description = [record.description, proposal?.note].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    task: "Suggest a player-facing park name, a short name, and a description of 800 characters or fewer for this park. Then describe a badge scene for it.",
    park: {
      name: draft.name,
      region: draft.region || null,
      category: draft.category,
      description: description.join("\n\n") || null,
      sourceName: typeof record.sourceName === "string" ? record.sourceName : null,
      center: { lat: draft.lat, lng: draft.lng },
    },
  };
}

/** Best effort: a new draft starts with a web photo of the park when one is easy to find. */
async function attachFirstPhoto(context: ImportContext, draft: Draft): Promise<Draft> {
  try {
    const photo = bestPhoto(await searchPhotos(draft, context.fetch), draft.name);
    if (!photo) return draft;
    const { bytes, contentType } = await downloadPhoto(photo.thumbUrl, context.fetch);
    return await context.drafts().setReferencePhoto(draft.id, bytes, contentType) ?? draft;
  } catch {
    return draft;
  }
}

async function proposalSource(context: ImportContext, id: unknown): Promise<ProposalSource | null> {
  if (id === undefined) return null;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "invalid_request", "Unknown proposal.");
  const proposal = (await context.proposals().list(null)).find((item) => item.id === id.toLowerCase());
  if (!proposal) throw new HttpError(404, "not_found", "That proposal no longer exists.");
  return { id: proposal.id, name: proposal.name, note: proposal.note, point: proposal.point, outline: proposal.outline, createdAt: proposal.createdAt };
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
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => !["legacyId", "proposalId"].includes(key))) {
      throw new HttpError(400, "invalid_request", "Send a legacy park id, a proposal id, or both.");
    }
    const proposal = await proposalSource(context, body.proposalId);
    if (body.legacyId === undefined) {
      // No legacy match: start from the player's pin and sketch.
      if (!proposal) throw new HttpError(400, "invalid_request", "Send a legacy park id, a proposal id, or both.");
      const suffix = crypto.randomUUID().slice(0, 4);
      const created = await context.drafts().create({ ...draftFromProposal(proposal, context.randomSeed(), suffix), sourceSha256: await sha256Hex(new TextEncoder().encode(JSON.stringify(proposal))) });
      const draft = await attachFirstPhoto(context, created);
      return json({ draft: draftView(draft, context.env) }, 201);
    }
    if (typeof body.legacyId !== "string" || !ID.test(body.legacyId)) throw new HttpError(400, "invalid_request", "Unknown legacy park.");
    const park = await context.legacy.get(body.legacyId);
    if (!park) throw new HttpError(404, "not_found", "That park is not in the legacy map.");
    const sourceSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify({ record: park.record, boundaryProperties: park.boundaryProperties, geometry: park.geometry })));
    const draft = await attachFirstPhoto(context, await context.drafts().create({ ...draftFromLegacy(park, context.randomSeed(), proposal), sourceSha256 }));
    return json({ draft: draftView(draft, context.env) }, 201);
  }

  const match = /^\/api\/drafts\/([^/]+)(?:\/(badge|reference|brief|publish|photos|reference-from-web))?$/.exec(path);
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

  if (action === "photos") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    const draft = await drafts.get(id);
    if (!draft) throw new HttpError(404, "not_found", "Draft not found.");
    // An operator's own search words replace the name and region; the pin still finds nearby photos.
    const words = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 200);
    return json({ photos: await searchPhotos(words ? { ...draft, name: words, region: "" } : draft, context.fetch) });
  }

  if (action === "reference-from-web") {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
    context.requireSameOrigin();
    const body = await readJsonBody(request, 4096) as Record<string, unknown>;
    const { bytes, contentType } = await downloadPhoto(body?.url, context.fetch);
    const draft = await drafts.setReferencePhoto(id, bytes, contentType);
    if (!draft) throw new HttpError(404, "not_found", "Draft not found, or it is already published.");
    return json({ draft: draftView(draft, context.env) });
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
