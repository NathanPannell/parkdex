import { neon } from "@neondatabase/serverless";
import { HttpError } from "../../../worker/validation.js";
import { BIOMES, CATEGORIES, RARITIES, SHAPE_FOR_CATEGORY, type SqlRunner } from "../drafts.js";
import { normalizeGeometry, type MultiPolygon } from "./geometry.js";

/**
 * Editing parks that are already in Parkdex. Every save is one transaction that first checks
 * the park still matches what the operator opened, then writes public.parks and, when needed,
 * public.boundaries. The content triggers turn it into one synchronized revision, so a save
 * reaches installed apps on their next content sync.
 */

export interface LivePark {
  id: string;
  name: string;
  short: string;
  category: string;
  region: string;
  lat: number;
  lng: number;
  biome: string;
  shape: string;
  rarity: string;
  scene: string | null;
  seed: number;
  blurb: string;
}

export interface LiveParkDetail extends LivePark {
  geometry: MultiPolygon | null;
}

export type LiveParkChanges = Partial<Pick<LivePark, "name" | "short" | "category" | "region" | "lat" | "lng" | "biome" | "rarity" | "blurb">> & { geometry?: MultiPolygon };

export interface LiveParkStore {
  list(): Promise<LivePark[]>;
  /** Every region already used by a live park, so editors pick one instead of inventing one. */
  regions(): Promise<string[]>;
  get(id: string): Promise<LiveParkDetail | null>;
  /** Applies changes only if the park still matches `expected`; returns the new revision. */
  update(id: string, expected: LivePark, changes: LiveParkChanges): Promise<number | null>;
}

const COLUMNS = "id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb";

function toPark(row: Record<string, unknown>): LivePark {
  return {
    id: String(row.id), name: String(row.name), short: String(row.short), category: String(row.category), region: String(row.region),
    lat: Number(row.lat), lng: Number(row.lng), biome: String(row.biome), shape: String(row.shape), rarity: String(row.rarity),
    scene: (row.scene as string | null) ?? null, seed: Number(row.seed), blurb: String(row.blurb),
  };
}

function text(value: unknown, label: string, max: number, allowEmpty: boolean): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_field", `${label} must be text.`);
  const trimmed = value.trim();
  // The account backup contract rejects control characters in park text.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed) || trimmed.length > max || (!allowEmpty && !trimmed)) {
    throw new HttpError(400, "invalid_field", `${label} must be ${allowEmpty ? "" : "1 to "}${max} characters${allowEmpty ? " or fewer" : ""} of plain text.`);
  }
  return trimmed;
}

function choice(value: unknown, options: readonly string[], label: string): string {
  if (typeof value === "string" && options.includes(value)) return value;
  throw new HttpError(400, "invalid_field", `Unknown ${label}.`);
}

function coordinate(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new HttpError(400, "invalid_field", `${label} is out of range.`);
  return Math.round(value * 1e6) / 1e6;
}

export function validateLiveChanges(value: unknown): LiveParkChanges {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "invalid_request", "Invalid park changes.");
  const input = value as Record<string, unknown>;
  const allowed = ["name", "short", "category", "region", "lat", "lng", "biome", "rarity", "blurb", "geometry"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpError(400, "invalid_request", "Invalid park changes.");
  if (("lat" in input) !== ("lng" in input)) throw new HttpError(400, "invalid_request", "Send the pin's latitude and longitude together.");
  const changes: LiveParkChanges = {};
  if ("name" in input) changes.name = text(input.name, "Name", 140, false);
  if ("short" in input) changes.short = text(input.short, "Short name", 140, false);
  if ("region" in input) changes.region = text(input.region, "Region", 140, true);
  if ("blurb" in input) changes.blurb = text(input.blurb, "Description", 800, true);
  if ("category" in input) changes.category = choice(input.category, CATEGORIES, "category");
  if ("biome" in input) changes.biome = choice(input.biome, BIOMES, "biome");
  if ("rarity" in input) changes.rarity = choice(input.rarity, RARITIES, "rarity");
  if ("lat" in input) {
    changes.lat = coordinate(input.lat, -90, 90, "Latitude");
    changes.lng = coordinate(input.lng, -180, 180, "Longitude");
  }
  if ("geometry" in input) changes.geometry = normalizeGeometry(input.geometry, "The boundary");
  return changes;
}

export function validateExpected(value: unknown): LivePark {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "invalid_request", "Send the park as you opened it.");
  const park = value as Record<string, unknown>;
  for (const key of ["id", "name", "short", "category", "region", "biome", "shape", "rarity", "blurb"]) {
    if (typeof park[key] !== "string") throw new HttpError(400, "invalid_request", "Send the park as you opened it.");
  }
  if (typeof park.lat !== "number" || typeof park.lng !== "number" || typeof park.seed !== "number" || !(park.scene === null || typeof park.scene === "string")) {
    throw new HttpError(400, "invalid_request", "Send the park as you opened it.");
  }
  return toPark(park);
}

/** The guarded transaction, shared by the Neon store and the PostgreSQL integration test. */
export function liveUpdateStatements(id: string, expected: LivePark, changes: LiveParkChanges) {
  const next: LivePark = { ...expected, ...Object.fromEntries(Object.entries(changes).filter(([key]) => key !== "geometry")) } as LivePark;
  // The badge shape follows the category when the category changes.
  if (changes.category && changes.category !== expected.category) next.shape = SHAPE_FOR_CATEGORY[changes.category] ?? expected.shape;
  const statements: { text: string; params: unknown[] }[] = [
    { text: "SELECT id FROM public.parks WHERE id = $1 FOR UPDATE", params: [id] },
    {
      // Compare with what the operator opened, so two editors cannot silently overwrite each other.
      text: `SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM public.parks WHERE id = $1 AND name = $2 AND short = $3 AND category = $4
        AND region = $5 AND lat = $6 AND lng = $7 AND biome = $8 AND shape = $9 AND rarity = $10 AND scene IS NOT DISTINCT FROM $11::text AND blurb = $12), 'park_changed')`,
      params: [id, expected.name, expected.short, expected.category, expected.region, expected.lat, expected.lng, expected.biome, expected.shape, expected.rarity, expected.scene, expected.blurb],
    },
    {
      text: `UPDATE public.parks SET name = $2, short = $3, category = $4, region = $5, lat = $6, lng = $7, biome = $8, shape = $9,
        rarity = $10, blurb = $11 WHERE id = $1`,
      params: [id, next.name, next.short, next.category, next.region, next.lat, next.lng, next.biome, next.shape, next.rarity, next.blurb],
    },
  ];
  // The public boundary carries the park's biome, so it changes with the biome or a redrawn shape.
  if (changes.geometry || next.biome !== expected.biome) {
    statements.push({
      text: `UPDATE public.boundaries SET feature = jsonb_build_object('type', 'Feature', 'properties', jsonb_build_object('id', park_id, 'biome', $2::text),
        'geometry', COALESCE($3::jsonb, feature->'geometry')) WHERE park_id = $1`,
      params: [id, next.biome, changes.geometry ? JSON.stringify(changes.geometry) : null],
    });
  }
  statements.push({ text: "SELECT revision FROM public.content_clock WHERE singleton = true", params: [] });
  return statements;
}

export function createSqlLiveParkStore(db: SqlRunner): LiveParkStore {
  return {
    async list() {
      return (await db.query(`SELECT ${COLUMNS} FROM public.parks ORDER BY name`)).map(toPark);
    },
    async regions() {
      const rows = await db.query("SELECT DISTINCT region FROM public.parks WHERE region <> '' ORDER BY region");
      return rows.map((row) => String(row.region));
    },
    async get(id) {
      const rows = await db.query(
        `SELECT ${COLUMNS.split(", ").map((column) => `p.${column}`).join(", ")}, b.feature->'geometry' AS geometry
           FROM public.parks p
           LEFT JOIN public.boundaries b ON b.park_id = p.id
          WHERE p.id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      return { ...toPark(row), geometry: (row.geometry as MultiPolygon | null) ?? null };
    },
    async update(id, expected, changes) {
      try {
        const results = await db.transaction(liveUpdateStatements(id, expected, changes));
        const revision = results[results.length - 1][0]?.revision;
        return revision === undefined || revision === null ? null : Number(revision);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("park_changed")) throw new HttpError(409, "park_changed", "This park changed since you opened it. Reload it and make your edit again.");
        const code = (error as { code?: unknown })?.code;
        throw new HttpError(422, "save_failed", `The save was rolled back by a content check${typeof code === "string" ? ` (${code})` : ""}.`);
      }
    },
  };
}

export function createNeonLiveParkStore(databaseUrl: string): LiveParkStore {
  const sql = neon(databaseUrl);
  return createSqlLiveParkStore({
    query: (statement, params = []) => sql.query(statement, params) as Promise<Record<string, unknown>[]>,
    transaction: (statements) => sql.transaction(statements.map(({ text: statement, params }) => sql.query(statement, params))) as Promise<Record<string, unknown>[][]>,
  });
}
