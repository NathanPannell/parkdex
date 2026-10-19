/**
 * The publish transaction for park drafts. Park founding (worker/founders-store.ts) and the
 * proposal publisher (worker/parkPublish.ts) write a row to kip_park_drafts.drafts and then run
 * publishStatements, which copies it into public.parks, public.boundaries and the drive tables
 * in one transaction: the moment a park reaches phones.
 *
 * The dashboard's own Drafts pages are retired; this module stays because those callers and
 * scripts/qa-founders-sql.mjs import it from this path.
 */

export const CATEGORIES = ["national", "provincial", "regional", "municipal", "community"] as const;
export const BIOMES = ["coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"] as const;
export const SHAPES = ["circle", "hex", "shield", "arch", "seal"] as const;
export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;

/** Badge shape follows category; the arch shape is no longer used for new parks. */
export const SHAPE_FOR_CATEGORY: Record<string, string> = {
  community: "circle",
  municipal: "circle",
  regional: "hex",
  provincial: "shield",
  national: "seal",
};

/** A first guess at the biome from the park's name; the operator can change it. */
export function guessBiome(name: string): string {
  const text = name.toLowerCase();
  if (/\b(falls|waterfall|cascade)\b/.test(text)) return "waterfall";
  if (/\b(lake|lagoon|pond|reservoir)\b/.test(text)) return "lake";
  if (/\b(river|creek|canyon|gorge)\b/.test(text)) return "river";
  if (/\b(beach|marine|bay|cove|spit|point|ocean|shore|island|islet|harbour)\b/.test(text)) return "coast";
  if (/\b(marsh|wetland|bog|swamp|estuary|sanctuary)\b/.test(text)) return "marsh";
  if (/\b(cave|caves|caverns?)\b/.test(text)) return "cave";
  if (/\b(mount|mountain|peak|hill|ridge|summit|bluffs?)\b/.test(text)) return "mountain";
  if (/\b(heritage|historic|fort|lighthouse)\b/.test(text)) return "heritage";
  return "forest";
}

export function shortName(name: string): string {
  return name.replace(/\s+(Provincial|Regional|National|Community|Municipal)?\s*Park( Reserve)?$/i, "").trim() || name;
}

/** The immutable CDN descriptor for a badge, matching scripts/publish_park_update.py. */
export interface BadgeAsset {
  logicalPath: string;
  objectKey: string;
  url: string;
  sha256: string;
  byteSize: number;
  contentType: "image/webp";
}

/**
 * A database that runs one statement, or several in one transaction. Neon's HTTP driver
 * provides both from an Edge Function; the integration tests use a pg client.
 */
export interface SqlRunner {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  transaction(statements: { text: string; params: unknown[] }[]): Promise<Record<string, unknown>[][]>;
}

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
        AND length(btrim(short)) > 0 AND category IS NOT NULL AND rarity IS NOT NULL AND geometry IS NOT NULL), 'draft_incomplete')`,
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
    {
      text: "INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min) SELECT $1, position, NULL, NULL FROM public.drive_hubs ORDER BY position",
      params: [id],
    },
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
