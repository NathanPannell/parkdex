import { neon } from "@neondatabase/serverless";
import { HttpError } from "../../worker/validation.js";
import type { LegacyPark, MultiPolygon } from "./legacy.js";

/**
 * Park drafts live in kip_park_drafts.drafts, outside synchronized content. Publishing copies a
 * complete draft into public.parks, public.boundaries and the drive tables in one transaction,
 * which is the moment the park reaches phones.
 */

export const CATEGORIES = ["national", "provincial", "regional", "municipal", "community"] as const;
export const BIOMES = ["coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"] as const;
export const SHAPES = ["circle", "hex", "shield", "arch", "seal"] as const;
export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface DraftFields {
  name: string;
  short: string;
  category: string | null;
  region: string;
  biome: string;
  shape: string;
  rarity: string | null;
  blurb: string;
}

export interface Draft extends DraftFields {
  id: string;
  source: Record<string, unknown>;
  geometry: MultiPolygon;
  lat: number;
  lng: number;
  seed: number;
  scene: string | null;
  badgeSha256: string | null;
  badgeBytes: number | null;
  referencePhotoType: string | null;
  status: "draft" | "published";
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftSummary {
  id: string;
  name: string;
  category: string | null;
  rarity: string | null;
  status: "draft" | "published";
  hasBadge: boolean;
  hasBlurb: boolean;
  hasReferencePhoto: boolean;
  updatedAt: string;
}

/** The immutable CDN descriptor for an uploaded badge, matching scripts/publish_park_update.py. */
export interface BadgeAsset {
  logicalPath: string;
  objectKey: string;
  url: string;
  sha256: string;
  byteSize: number;
  contentType: "image/webp";
}

export interface PublishResult {
  id: string;
  revision: number | null;
}

export interface DraftStore {
  list(): Promise<DraftSummary[]>;
  get(id: string): Promise<Draft | null>;
  /** Park ids already in public.parks, so the import list can mark them. */
  publishedParkIds(): Promise<Set<string>>;
  create(input: Omit<Draft, "status" | "publishedAt" | "createdAt" | "updatedAt" | "scene" | "badgeSha256" | "badgeBytes" | "referencePhotoType"> & { sourceSha256: string }): Promise<Draft>;
  update(id: string, fields: Partial<DraftFields>): Promise<Draft | null>;
  setBadge(id: string, bytes: Uint8Array | null, scene: string | null): Promise<Draft | null>;
  getBadge(id: string): Promise<Uint8Array | null>;
  setReferencePhoto(id: string, bytes: Uint8Array | null, contentType: string | null): Promise<Draft | null>;
  getReferencePhoto(id: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  remove(id: string): Promise<boolean>;
  publish(id: string, expectedUpdatedAt: string, asset: BadgeAsset | null): Promise<PublishResult>;
}

/**
 * A database that runs one statement, or several in one transaction. Neon's HTTP driver
 * provides both from an Edge Function; the integration test uses a pg client.
 */
export interface SqlRunner {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  transaction(statements: { text: string; params: unknown[] }[]): Promise<Record<string, unknown>[][]>;
}

const DRAFT_COLUMNS = `id, source, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb, scene,
  encode(sha256(badge_webp), 'hex') AS badge_sha256, octet_length(badge_webp) AS badge_bytes, reference_photo_type,
  status, published_at, created_at, updated_at`;

function iso(value: unknown): string {
  return new Date(value as string).toISOString();
}

function toDraft(row: Record<string, unknown>): Draft {
  return {
    id: String(row.id),
    source: row.source as Record<string, unknown>,
    geometry: row.geometry as MultiPolygon,
    name: String(row.name),
    short: String(row.short),
    category: (row.category as string | null) ?? null,
    region: String(row.region),
    lat: Number(row.lat),
    lng: Number(row.lng),
    biome: String(row.biome),
    shape: String(row.shape),
    rarity: (row.rarity as string | null) ?? null,
    seed: Number(row.seed),
    blurb: String(row.blurb),
    scene: (row.scene as string | null) ?? null,
    badgeSha256: (row.badge_sha256 as string | null) ?? null,
    badgeBytes: row.badge_bytes === null || row.badge_bytes === undefined ? null : Number(row.badge_bytes),
    referencePhotoType: (row.reference_photo_type as string | null) ?? null,
    status: row.status as Draft["status"],
    publishedAt: row.published_at ? iso(row.published_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// Images travel as hex text so both drivers agree on bytea encoding.
function toHex(bytes: Uint8Array | null): string | null {
  return bytes ? Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("") : null;
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** What a draft still needs before it can be published. Badge and description are optional. */
export function publishBlockers(draft: Pick<Draft, "name" | "short" | "category" | "rarity" | "status">): string[] {
  const missing: string[] = [];
  if (draft.status !== "draft") missing.push("This draft is already published.");
  if (!draft.name.trim()) missing.push("Add a name.");
  if (!draft.short.trim()) missing.push("Add a short name.");
  if (!draft.category) missing.push("Choose a category.");
  if (!draft.rarity) missing.push("Choose a rarity.");
  return missing;
}

/** The public boundary feature carries exactly id and biome, like the legacy importer writes. */
export function publicFeature(id: string, biome: string, geometry: MultiPolygon) {
  return { type: "Feature", properties: { id, biome }, geometry };
}


const GUARDS: Record<string, [number, string]> = {
  draft_missing: [404, "Draft not found."],
  draft_changed: [409, "This draft changed since you opened it. Reload and try again."],
  draft_incomplete: [422, "This draft is missing a name, short name, category or rarity."],
  badge_changed: [409, "The badge changed while publishing. Try again."],
  park_exists: [409, "A park with this id is already in Parkdex."],
  scene_taken: [409, "That badge slug is already registered to a different image."],
};

/**
 * One transaction with no client round trips between statements. Each guard raises through
 * kip_park_drafts.require, which rolls back everything before the park reaches content.
 */
export function publishStatements(id: string, expectedUpdatedAt: string, asset: BadgeAsset | null): { text: string; params: unknown[] }[] {
  const scene = asset ? asset.logicalPath.slice("art/badges/scenes/".length, -".webp".length) : null;
  const statements: { text: string; params: unknown[] }[] = [
    { text: "SELECT id FROM kip_park_drafts.drafts WHERE id = $1 FOR UPDATE", params: [id] },
    { text: "SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM kip_park_drafts.drafts WHERE id = $1), 'draft_missing')", params: [id] },
    {
      // The client sees millisecond timestamps, so compare at that precision.
      text: `SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM kip_park_drafts.drafts WHERE id = $1 AND status = 'draft'
        AND date_trunc('milliseconds', updated_at) = $2::timestamptz), 'draft_changed')`,
      params: [id, expectedUpdatedAt],
    },
    {
      text: `SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM kip_park_drafts.drafts WHERE id = $1 AND length(btrim(name)) > 0
        AND length(btrim(short)) > 0 AND category IS NOT NULL AND rarity IS NOT NULL), 'draft_incomplete')`,
      params: [id],
    },
    {
      text: `SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM kip_park_drafts.drafts WHERE id = $1
        AND scene IS NOT DISTINCT FROM $2::text AND encode(sha256(badge_webp), 'hex') IS NOT DISTINCT FROM $3::text), 'badge_changed')`,
      params: [id, scene, asset?.sha256 ?? null],
    },
    { text: "SELECT kip_park_drafts.require(NOT EXISTS (SELECT 1 FROM public.parks WHERE id = $1), 'park_exists')", params: [id] },
  ];
  if (asset) {
    statements.push(
      {
        text: `INSERT INTO public.r2_objects (logical_path, object_key, url, sha256, byte_size, content_type)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (logical_path) DO NOTHING`,
        params: [asset.logicalPath, asset.objectKey, asset.url, asset.sha256, asset.byteSize, asset.contentType],
      },
      {
        text: `SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM public.r2_objects WHERE logical_path = $1 AND object_key = $2
          AND sha256 = $3 AND byte_size = $4), 'scene_taken')`,
        params: [asset.logicalPath, asset.objectKey, asset.sha256, asset.byteSize],
      },
    );
  }
  statements.push(
    {
      text: `INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
        SELECT id, btrim(name), btrim(short), category, region, lat, lng, biome, shape, rarity, scene, seed, btrim(blurb)
        FROM kip_park_drafts.drafts WHERE id = $1`,
      params: [id],
    },
    // Access starts unverified: walk 0 and no route to any hub, the importer's explicit sentinel.
    { text: "INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES ($1, 0)", params: [id] },
    { text: "INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min) SELECT $1, position, NULL, NULL FROM public.drive_hubs ORDER BY position", params: [id] },
    {
      // The public feature carries exactly id and biome, like the legacy importer writes.
      text: `INSERT INTO public.boundaries (park_id, feature)
        SELECT id, jsonb_build_object('type', 'Feature', 'properties', jsonb_build_object('id', id, 'biome', biome), 'geometry', geometry)
        FROM kip_park_drafts.drafts WHERE id = $1`,
      params: [id],
    },
    {
      text: `UPDATE kip_park_drafts.drafts SET status = 'published', published_at = now(), updated_at = now(),
          published_revision = (SELECT revision FROM public.content_clock WHERE singleton = true)
        WHERE id = $1 RETURNING published_revision`,
      params: [id],
    },
  );
  return statements;
}

export async function publishWith(db: SqlRunner, id: string, expectedUpdatedAt: string, asset: BadgeAsset | null): Promise<PublishResult> {
  try {
    const results = await db.transaction(publishStatements(id, new Date(expectedUpdatedAt).toISOString(), asset));
    const revision = results[results.length - 1][0]?.published_revision;
    return { id, revision: revision === null || revision === undefined ? null : Number(revision) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const guard = Object.keys(GUARDS).find((key) => message.includes(key));
    if (guard) throw new HttpError(GUARDS[guard][0], guard, GUARDS[guard][1]);
    // PostgreSQL errors can include connection details; keep the message safe.
    const code = (error as { code?: unknown })?.code;
    throw new HttpError(422, "publish_failed", `Publishing was rolled back by a database check${typeof code === "string" ? ` (${code})` : ""}.`);
  }
}

export function createSqlDraftStore(db: SqlRunner): DraftStore {
  async function one(id: string): Promise<Draft | null> {
    const rows = await db.query(`SELECT ${DRAFT_COLUMNS} FROM kip_park_drafts.drafts WHERE id = $1`, [id]);
    return rows[0] ? toDraft(rows[0]) : null;
  }
  async function reread(rows: Record<string, unknown>[], id: string): Promise<Draft | null> {
    return rows.length ? one(id) : null;
  }
  return {
    async list() {
      const rows = await db.query(`SELECT id, name, category, rarity, status, badge_webp IS NOT NULL AS has_badge,
        length(btrim(blurb)) > 0 AS has_blurb, reference_photo IS NOT NULL AS has_reference, updated_at
        FROM kip_park_drafts.drafts ORDER BY status, updated_at DESC LIMIT 500`);
      return rows.map((row) => ({
        id: String(row.id), name: String(row.name), category: (row.category as string | null) ?? null, rarity: (row.rarity as string | null) ?? null,
        status: row.status as DraftSummary["status"], hasBadge: Boolean(row.has_badge), hasBlurb: Boolean(row.has_blurb),
        hasReferencePhoto: Boolean(row.has_reference), updatedAt: iso(row.updated_at),
      }));
    },
    get: one,
    async publishedParkIds() {
      return new Set((await db.query("SELECT id FROM public.parks")).map((row) => String(row.id)));
    },
    async create(input) {
      const inserted = await db.query(
        `INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb)
         SELECT $1, $2::jsonb, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
         WHERE NOT EXISTS (SELECT 1 FROM public.parks WHERE id = $1)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [input.id, JSON.stringify(input.source), input.sourceSha256, JSON.stringify(input.geometry), input.name, input.short, input.category,
          input.region, input.lat, input.lng, input.biome, input.shape, input.rarity, input.seed, input.blurb],
      );
      if (!inserted.length) throw new HttpError(409, "already_imported", "This park already has a draft or is already in Parkdex.");
      return (await one(input.id))!;
    },
    async update(id, fields) {
      const columns = Object.keys(fields) as (keyof DraftFields)[];
      if (!columns.length) return one(id);
      const sets = columns.map((column, index) => `${column} = $${index + 2}`).join(", ");
      return reread(await db.query(
        `UPDATE kip_park_drafts.drafts SET ${sets}, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING id`,
        [id, ...columns.map((column) => fields[column])],
      ), id);
    },
    async setBadge(id, bytes, scene) {
      return reread(await db.query(
        "UPDATE kip_park_drafts.drafts SET badge_webp = decode($2::text, 'hex'), scene = $3, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING id",
        [id, toHex(bytes), scene],
      ), id);
    },
    async getBadge(id) {
      const rows = await db.query("SELECT encode(badge_webp, 'hex') AS hex FROM kip_park_drafts.drafts WHERE id = $1 AND badge_webp IS NOT NULL", [id]);
      return rows[0] ? fromHex(String(rows[0].hex)) : null;
    },
    async setReferencePhoto(id, bytes, contentType) {
      return reread(await db.query(
        "UPDATE kip_park_drafts.drafts SET reference_photo = decode($2::text, 'hex'), reference_photo_type = $3, updated_at = now() WHERE id = $1 RETURNING id",
        [id, toHex(bytes), contentType],
      ), id);
    },
    async getReferencePhoto(id) {
      const rows = await db.query("SELECT encode(reference_photo, 'hex') AS hex, reference_photo_type FROM kip_park_drafts.drafts WHERE id = $1 AND reference_photo IS NOT NULL", [id]);
      return rows[0] ? { bytes: fromHex(String(rows[0].hex)), contentType: String(rows[0].reference_photo_type) } : null;
    },
    async remove(id) {
      return (await db.query("DELETE FROM kip_park_drafts.drafts WHERE id = $1 AND status = 'draft' RETURNING id", [id])).length > 0;
    },
    publish: (id, expectedUpdatedAt, asset) => publishWith(db, id, expectedUpdatedAt, asset),
  };
}

/** Neon's HTTP driver runs single statements and non-interactive transactions from an Edge Function. */
export function createNeonDraftStore(databaseUrl: string): DraftStore {
  const sql = neon(databaseUrl);
  return createSqlDraftStore({
    query: (text, params = []) => sql.query(text, params) as Promise<Record<string, unknown>[]>,
    transaction: (statements) => sql.transaction(statements.map(({ text, params }) => sql.query(text, params))) as Promise<Record<string, unknown>[][]>,
  });
}


/** A fresh draft from a legacy park. Nathan sets rarity; category stays empty when the app lacks it. */
export function draftFromLegacy(park: LegacyPark, seed: number) {
  const category = (CATEGORIES as readonly string[]).includes(park.category) ? park.category : null;
  return {
    id: park.id,
    source: { record: park.record, boundaryProperties: park.boundaryProperties },
    geometry: park.geometry,
    name: park.name,
    short: park.name.replace(/\s+(Provincial|Regional|National|Community|Municipal)?\s*Park( Reserve)?$/i, "").trim() || park.name,
    category,
    region: park.region,
    lat: park.lat,
    lng: park.lng,
    biome: "forest",
    shape: "circle",
    rarity: null,
    seed,
    blurb: "",
  };
}
