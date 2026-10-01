import { Pool } from "@neondatabase/serverless";
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

/** Anything that can run a parameterised query, such as a neon Pool client or a pg client. */
export interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
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

function bytesOf(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
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

export async function publishInTransaction(client: QueryClient, id: string, expectedUpdatedAt: string, asset: BadgeAsset | null): Promise<PublishResult> {
  await client.query("BEGIN");
  try {
    const found = await client.query(`SELECT ${DRAFT_COLUMNS} FROM kip_park_drafts.drafts WHERE id = $1 FOR UPDATE`, [id]);
    if (!found.rows[0]) throw new HttpError(404, "not_found", "Draft not found.");
    const draft = toDraft(found.rows[0]);
    if (draft.updatedAt !== new Date(expectedUpdatedAt).toISOString()) {
      throw new HttpError(409, "draft_changed", "This draft changed since you opened it. Reload and try again.");
    }
    const blockers = publishBlockers(draft);
    if (blockers.length) throw new HttpError(422, "draft_incomplete", blockers.join(" "));
    if ((asset === null) !== (draft.scene === null) || (asset && asset.sha256 !== draft.badgeSha256)) {
      throw new HttpError(409, "badge_changed", "The badge changed while publishing. Try again.");
    }
    const existing = await client.query("SELECT 1 FROM public.parks WHERE id = $1", [id]);
    if (existing.rows.length) throw new HttpError(409, "park_exists", "A park with this id is already in Parkdex.");
    if (asset) {
      await client.query(
        `INSERT INTO public.r2_objects (logical_path, object_key, url, sha256, byte_size, content_type)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (logical_path) DO NOTHING`,
        [asset.logicalPath, asset.objectKey, asset.url, asset.sha256, asset.byteSize, asset.contentType],
      );
      const descriptor = await client.query("SELECT object_key, sha256, byte_size FROM public.r2_objects WHERE logical_path = $1", [asset.logicalPath]);
      const row = descriptor.rows[0];
      if (!row || row.object_key !== asset.objectKey || row.sha256 !== asset.sha256 || Number(row.byte_size) !== asset.byteSize) {
        throw new HttpError(409, "scene_taken", "That badge slug is already registered to a different image.");
      }
    }
    await client.query(
      `INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [draft.id, draft.name.trim(), draft.short.trim(), draft.category, draft.region, draft.lat, draft.lng, draft.biome, draft.shape, draft.rarity, draft.scene, draft.seed, draft.blurb.trim()],
    );
    // Access starts unverified: walk 0 and no route to any hub, the importer's explicit sentinel.
    await client.query("INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES ($1, 0)", [id]);
    await client.query(
      "INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min) SELECT $1, position, NULL, NULL FROM public.drive_hubs ORDER BY position",
      [id],
    );
    await client.query("INSERT INTO public.boundaries (park_id, feature) VALUES ($1, $2::jsonb)", [id, JSON.stringify(publicFeature(id, draft.biome, draft.geometry))]);
    const clock = await client.query("SELECT revision FROM public.content_clock WHERE singleton = true");
    const revision = clock.rows[0] ? Number(clock.rows[0].revision) : null;
    await client.query(
      "UPDATE kip_park_drafts.drafts SET status = 'published', published_at = now(), published_revision = $2, updated_at = now() WHERE id = $1",
      [id, revision],
    );
    await client.query("COMMIT");
    return { id, revision };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof HttpError) throw error;
    // PostgreSQL errors can include connection details; keep the message safe.
    const code = (error as { code?: unknown })?.code;
    throw new HttpError(422, "publish_failed", `Publishing was rolled back by a database check${typeof code === "string" ? ` (${code})` : ""}.`);
  }
}

export function createSqlDraftStore(connect: () => Promise<QueryClient & { release(): void }>): DraftStore {
  async function run<T>(work: (client: QueryClient) => Promise<T>): Promise<T> {
    const client = await connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }
  async function one(client: QueryClient, id: string): Promise<Draft | null> {
    const result = await client.query(`SELECT ${DRAFT_COLUMNS} FROM kip_park_drafts.drafts WHERE id = $1`, [id]);
    return result.rows[0] ? toDraft(result.rows[0]) : null;
  }
  return {
    list: () => run(async (client) => {
      const result = await client.query(`SELECT id, name, category, rarity, status, badge_webp IS NOT NULL AS has_badge,
        length(btrim(blurb)) > 0 AS has_blurb, reference_photo IS NOT NULL AS has_reference, updated_at
        FROM kip_park_drafts.drafts ORDER BY status, updated_at DESC LIMIT 500`);
      return result.rows.map((row) => ({
        id: String(row.id), name: String(row.name), category: (row.category as string | null) ?? null, rarity: (row.rarity as string | null) ?? null,
        status: row.status as DraftSummary["status"], hasBadge: Boolean(row.has_badge), hasBlurb: Boolean(row.has_blurb),
        hasReferencePhoto: Boolean(row.has_reference), updatedAt: iso(row.updated_at),
      }));
    }),
    get: (id) => run((client) => one(client, id)),
    publishedParkIds: () => run(async (client) => new Set((await client.query("SELECT id FROM public.parks")).rows.map((row) => String(row.id)))),
    create: (input) => run(async (client) => {
      const inserted = await client.query(
        `INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb)
         SELECT $1, $2::jsonb, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
         WHERE NOT EXISTS (SELECT 1 FROM public.parks WHERE id = $1)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [input.id, JSON.stringify(input.source), input.sourceSha256, JSON.stringify(input.geometry), input.name, input.short, input.category,
          input.region, input.lat, input.lng, input.biome, input.shape, input.rarity, input.seed, input.blurb],
      );
      if (!inserted.rows.length) throw new HttpError(409, "already_imported", "This park already has a draft or is already in Parkdex.");
      return (await one(client, input.id))!;
    }),
    update: (id, fields) => run(async (client) => {
      const columns = Object.keys(fields) as (keyof DraftFields)[];
      if (!columns.length) return one(client, id);
      const sets = columns.map((column, index) => `${column} = $${index + 2}`).join(", ");
      const result = await client.query(
        `UPDATE kip_park_drafts.drafts SET ${sets}, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING id`,
        [id, ...columns.map((column) => fields[column])],
      );
      return result.rows.length ? one(client, id) : null;
    }),
    setBadge: (id, bytes, scene) => run(async (client) => {
      const result = await client.query(
        "UPDATE kip_park_drafts.drafts SET badge_webp = $2, scene = $3, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING id",
        [id, bytes, scene],
      );
      return result.rows.length ? one(client, id) : null;
    }),
    getBadge: (id) => run(async (client) => {
      const result = await client.query("SELECT badge_webp FROM kip_park_drafts.drafts WHERE id = $1 AND badge_webp IS NOT NULL", [id]);
      return result.rows[0] ? bytesOf(result.rows[0].badge_webp) : null;
    }),
    setReferencePhoto: (id, bytes, contentType) => run(async (client) => {
      const result = await client.query(
        "UPDATE kip_park_drafts.drafts SET reference_photo = $2, reference_photo_type = $3, updated_at = now() WHERE id = $1 RETURNING id",
        [id, bytes, contentType],
      );
      return result.rows.length ? one(client, id) : null;
    }),
    getReferencePhoto: (id) => run(async (client) => {
      const result = await client.query("SELECT reference_photo, reference_photo_type FROM kip_park_drafts.drafts WHERE id = $1 AND reference_photo IS NOT NULL", [id]);
      const row = result.rows[0];
      return row ? { bytes: bytesOf(row.reference_photo), contentType: String(row.reference_photo_type) } : null;
    }),
    remove: (id) => run(async (client) => (await client.query("DELETE FROM kip_park_drafts.drafts WHERE id = $1 AND status = 'draft' RETURNING id", [id])).rows.length > 0),
    publish: (id, expectedUpdatedAt, asset) => run((client) => publishInTransaction(client, id, expectedUpdatedAt, asset)),
  };
}

/** Neon's WebSocket pool supports interactive transactions from an Edge Function. */
export function createNeonDraftStore(databaseUrl: string): DraftStore {
  return createSqlDraftStore(async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    return Object.assign(client as unknown as QueryClient, {
      release() {
        client.release();
        void pool.end();
      },
    });
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
