import { neon } from "@neondatabase/serverless";
import { HttpError } from "../../../worker/validation.js";
import type { SqlRunner } from "../drafts.js";
import type { MultiPolygon } from "./geometry.js";

/**
 * The park manager's reads and moderation writes: the catalogue with its visibility, founders and
 * visits, a park's activity and history, and hide, unhide, delete and founder moderation.
 *
 * Every write is one transaction. Changes to public.parks and public.content_park_hidden go
 * through the content triggers, so each is one content revision that phones pick up on their
 * next sync (docs/park-visibility.md, docs/content-sync.md).
 */

/** Where a park came from. Founded covers every osm-* park, whether a player or the operator published it. */
export type ParkSource = "curated" | "legacy" | "founded" | "proposal";

export interface HiddenState {
  reason: string;
  source: "category" | "operator";
  hiddenAt: string;
}

export interface ParkRow {
  id: string;
  name: string;
  short: string;
  category: string;
  region: string;
  lat: number;
  lng: number;
  biome: string;
  rarity: string;
  source: ParkSource;
  hidden: HiddenState | null;
  founder: { handle: string | null; foundedAt: string; photoSha256: string } | null;
  visits: number;
}

export interface ParkStats {
  live: number;
  hidden: number;
  founded: number;
  osmOutlines: number;
  /**
   * OpenStreetMap outlines with no Parkdex park: not published under their own osm-* id and with
   * no catalogue pin inside their bounding box. A quick estimate over the whole table; the map
   * layer applies the full catalogueMatch rule to the outlines in view.
   */
  osmNotInParkdex: number;
  osmSourceDate: string | null;
}

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ParkOutline {
  id: string;
  category: string;
  hidden: boolean;
  geometry: MultiPolygon;
}

export interface ChangeRow {
  revision: number;
  at: string;
  entity: "park" | "boundary" | "drive" | "asset";
  operation: "upsert" | "delete";
  /** The park fields for park upserts; boundaries and drive values are left out to keep this small. */
  value: Record<string, unknown> | null;
}

export interface ParkActivity {
  source: ParkSource;
  hidden: HiddenState | null;
  founder: {
    handle: string | null;
    foundedAt: string;
    source: string;
    photoSha256: string;
    photoWidth: number;
    photoHeight: number;
    photoBytes: number;
  } | null;
  visits: { total: number; last30Days: number; uniquePlayers: number };
  /** The open tenure. `up` is false once it fell, 30 days after the holder's last visit. */
  flag: { handle: string | null; since: string; lastVisitAt: string; fallsAt: string; up: boolean } | null;
  tenures: number;
  history: ChangeRow[];
}

export interface CoverPhoto {
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
}

export interface CoverInput {
  sha256: string;
  base64: string;
  width: number;
  height: number;
}

export interface ParkManagerStore {
  rows(): Promise<ParkRow[]>;
  stats(): Promise<ParkStats>;
  outlines(bbox: Bbox): Promise<ParkOutline[]>;
  activity(id: string, now: string): Promise<ParkActivity | null>;
  /** Each returns the content revision the change produced. */
  hide(id: string, reason: string): Promise<number | null>;
  unhide(id: string): Promise<number | null>;
  remove(id: string): Promise<number | null>;
  /** Removes the founder row: the founder, the cover photo and the founder bonus. */
  clearFounder(id: string): Promise<void>;
  replaceCover(id: string, photo: CoverInput, at: string): Promise<void>;
  cover(id: string): Promise<CoverPhoto | null>;
}

const NOT_FOUND = () => new HttpError(404, "not_found", "That park is not in Parkdex.");
/** The park detail shows this many content changes, newest first. */
export const HISTORY_LIMIT = 40;
/** Outlines per map request. Pins are kept inside a box half again as big as the view. */
export const OUTLINE_LIMIT = 600;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function missingRelation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "42P01";
}

/** Founders, visits and the OSM table are separate migrations; a database without one reads as empty. */
async function optional<T>(query: Promise<T>, empty: T): Promise<T> {
  try {
    return await query;
  } catch (error) {
    if (missingRelation(error)) return empty;
    throw error;
  }
}

export function sourceOf(id: string, legacy: boolean, proposal: boolean): ParkSource {
  if (id.startsWith("osm-")) return "founded";
  if (id.startsWith("proposed-") || proposal) return "proposal";
  if (legacy) return "legacy";
  return "curated";
}

function hiddenOf(row: Record<string, unknown>): HiddenState | null {
  if (row.hidden_reason === null || row.hidden_reason === undefined) return null;
  return { reason: String(row.hidden_reason), source: row.hidden_source === "operator" ? "operator" : "category", hiddenAt: iso(row.hidden_at) };
}

/** Grows a map view so pins just outside it still bring their outlines. */
export function grow(bbox: Bbox, factor = 0.5): Bbox {
  const dx = (bbox.east - bbox.west) * factor, dy = (bbox.north - bbox.south) * factor;
  return { west: bbox.west - dx, south: bbox.south - dy, east: bbox.east + dx, north: bbox.north + dy };
}

const lock = (id: string) => ({ text: "SELECT id FROM public.parks WHERE id = $1 FOR UPDATE", params: [id] });
const exists = (id: string) => ({ text: "SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM public.parks WHERE id = $1), 'park_missing')", params: [id] });
const clock = { text: "SELECT revision FROM public.content_clock WHERE singleton = true", params: [] as unknown[] };

export function hideStatements(id: string, reason: string) {
  return [
    lock(id),
    exists(id),
    { text: "SELECT kip_park_drafts.require(NOT EXISTS (SELECT 1 FROM public.content_park_hidden WHERE park_id = $1), 'already_hidden')", params: [id] },
    // The visibility trigger writes the park, boundary and drive tombstones in this revision.
    { text: "INSERT INTO public.content_park_hidden (park_id, reason, source) VALUES ($1, $2, 'operator')", params: [id, reason] },
    clock,
  ];
}

export function unhideStatements(id: string) {
  return [
    lock(id),
    exists(id),
    { text: "SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM public.content_park_hidden WHERE park_id = $1), 'not_hidden')", params: [id] },
    // Unhiding sends the park, its boundary, drive data and scene back as upserts.
    { text: "DELETE FROM public.content_park_hidden WHERE park_id = $1", params: [id] },
    clock,
  ];
}

/**
 * Deletes a park in one content revision. The park row cascades to its boundary, drive data,
 * reader floor, hidden row and founder (with the cover photo), and the content triggers write
 * the tombstones. Visits and tenures keep their park id and stay as history. The draft goes too,
 * so the same OpenStreetMap park can be founded or created again later.
 */
export function deleteStatements(id: string) {
  return [...deleteGuards(id), ...deleteRows(id)];
}

/** The row lock and the checks a delete makes first; Remove from map (removal.ts) shares them. */
export function deleteGuards(id: string) {
  return [
    lock(id),
    exists(id),
    // The 100-park enrichment queue restricts deletes; such a park is part of an operator run.
    { text: "SELECT kip_park_drafts.require(NOT EXISTS (SELECT 1 FROM public.park_enrichment_jobs WHERE park_id = $1), 'park_in_enrichment')", params: [id] },
  ];
}

/** The draft, the park (cascading to its content rows and founder) and the revision it produced. */
export function deleteRows(id: string) {
  return [
    { text: "DELETE FROM kip_park_drafts.drafts WHERE id = $1", params: [id] },
    { text: "DELETE FROM public.parks WHERE id = $1", params: [id] },
    clock,
  ];
}

/** Turns a guard raised in a transaction into the error the operator sees. */
export function transactionError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  if (/park_missing/.test(message)) return NOT_FOUND();
  if (/already_hidden/.test(message)) return new HttpError(409, "already_hidden", "This park is already hidden. Reload to see its current state.");
  if (/not_hidden/.test(message)) return new HttpError(409, "not_hidden", "This park is not hidden. Reload to see its current state.");
  if (/park_in_enrichment/.test(message)) return new HttpError(409, "park_in_enrichment", "This park is in the art enrichment queue, so it cannot be deleted. Hide it instead.");
  const code = (error as { code?: unknown })?.code;
  return new HttpError(422, "save_failed", `The change was rolled back by a content check${typeof code === "string" ? ` (${code})` : ""}.`);
}

function revisionOf(results: Record<string, unknown>[][]): number | null {
  const revision = results[results.length - 1]?.[0]?.revision;
  return revision === undefined || revision === null ? null : Number(revision);
}

export function createSqlParkManagerStore(db: SqlRunner): ParkManagerStore {
  async function run(statements: { text: string; params: unknown[] }[]) {
    try {
      return revisionOf(await db.transaction(statements));
    } catch (error) {
      throw transactionError(error);
    }
  }

  return {
    async rows() {
      const [parks, proposals, founders, visits] = await Promise.all([
        db.query(
          `SELECT p.id, p.name, p.short, p.category, p.region, p.lat, p.lng, p.biome, p.rarity,
             h.reason AS hidden_reason, h.source AS hidden_source, h.hidden_at, (f.park_id IS NOT NULL) AS legacy
           FROM public.parks p
           LEFT JOIN public.content_park_hidden h ON h.park_id = p.id
           LEFT JOIN public.content_park_reader_floor f ON f.park_id = p.id AND f.minimum_reader >= 3
           ORDER BY p.name, p.id`,
        ),
        optional(db.query("SELECT id FROM kip_park_drafts.drafts WHERE status = 'published' AND source ? 'proposal'"), []),
        optional(db.query(
          `SELECT f.park_id, pl.handle, f.founded_at, f.photo_sha256
           FROM kip_founders.parks f LEFT JOIN kip_game.players pl ON pl.account_id = f.account_id`,
        ), []),
        optional(db.query("SELECT park_id, count(*)::integer AS visits FROM kip_game.visits GROUP BY park_id"), []),
      ]);
      const proposed = new Set(proposals.map((row) => String(row.id)));
      const founderOf = new Map(founders.map((row) => [String(row.park_id), {
        handle: row.handle === null || row.handle === undefined ? null : String(row.handle), foundedAt: iso(row.founded_at), photoSha256: String(row.photo_sha256),
      }]));
      const visitsOf = new Map(visits.map((row) => [String(row.park_id), Number(row.visits)]));
      return parks.map((row) => {
        const id = String(row.id);
        return {
          id, name: String(row.name), short: String(row.short), category: String(row.category), region: String(row.region),
          lat: Number(row.lat), lng: Number(row.lng), biome: String(row.biome), rarity: String(row.rarity),
          source: sourceOf(id, row.legacy === true, proposed.has(id)),
          hidden: hiddenOf(row),
          founder: founderOf.get(id) ?? null,
          visits: visitsOf.get(id) ?? 0,
        };
      });
    },

    async stats() {
      const [parks, founded, osm] = await Promise.all([
        db.query(
          `SELECT count(*)::integer AS total, count(h.park_id)::integer AS hidden
           FROM public.parks p LEFT JOIN public.content_park_hidden h ON h.park_id = p.id`,
        ),
        optional(db.query("SELECT count(*)::integer AS count FROM kip_founders.parks"), [{ count: 0 }]),
        optional(db.query(
          // One pass over the OSM table; each outline looks for its own osm-* id and any catalogue pin in its box.
          `SELECT count(*)::integer AS outlines,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.parks p WHERE p.id = 'osm-' || o.osm_type || '-' || o.osm_id)
               AND NOT EXISTS (SELECT 1 FROM public.parks p WHERE p.lat BETWEEN o.min_lat AND o.max_lat AND p.lng BETWEEN o.min_lng AND o.max_lng)
             )::integer AS missing,
             -- One row per extract (bc, nova-scotia, ...); the oldest says how stale the outlines can be.
             (SELECT min(source_date) FROM kip_osm.source) AS source_date
           FROM kip_osm.parks o`,
        ), [{ outlines: 0, missing: 0, source_date: null }]),
      ]);
      const total = Number(parks[0]?.total ?? 0), hidden = Number(parks[0]?.hidden ?? 0);
      return {
        live: total - hidden,
        hidden,
        founded: Number(founded[0]?.count ?? 0),
        osmOutlines: Number(osm[0]?.outlines ?? 0),
        osmNotInParkdex: Number(osm[0]?.missing ?? 0),
        osmSourceDate: osm[0]?.source_date ? iso(osm[0].source_date) : null,
      };
    },

    async outlines(bbox) {
      const box = grow(bbox);
      const rows = await db.query(
        `SELECT p.id, p.category, (h.park_id IS NOT NULL) AS hidden, b.feature->'geometry' AS geometry
         FROM public.parks p
         JOIN public.boundaries b ON b.park_id = p.id
         LEFT JOIN public.content_park_hidden h ON h.park_id = p.id
         WHERE p.lat BETWEEN $1 AND $2 AND p.lng BETWEEN $3 AND $4
         ORDER BY p.id LIMIT ${OUTLINE_LIMIT}`,
        [box.south, box.north, box.west, box.east],
      );
      return rows.map((row) => ({ id: String(row.id), category: String(row.category), hidden: row.hidden === true, geometry: jsonValue<MultiPolygon>(row.geometry) }));
    },

    async activity(id, now) {
      const [parks, floor, proposal, founder, visits, flag, history] = await Promise.all([
        db.query(
          `SELECT p.id, h.reason AS hidden_reason, h.source AS hidden_source, h.hidden_at
           FROM public.parks p LEFT JOIN public.content_park_hidden h ON h.park_id = p.id WHERE p.id = $1`,
          [id],
        ),
        db.query("SELECT 1 FROM public.content_park_reader_floor WHERE park_id = $1 AND minimum_reader >= 3", [id]),
        optional(db.query("SELECT 1 FROM kip_park_drafts.drafts WHERE id = $1 AND source ? 'proposal'", [id]), []),
        optional(db.query(
          `SELECT pl.handle, f.founded_at, f.source, f.photo_sha256, f.photo_width, f.photo_height, octet_length(f.photo_bytes) AS photo_bytes
           FROM kip_founders.parks f LEFT JOIN kip_game.players pl ON pl.account_id = f.account_id WHERE f.park_id = $1`,
          [id],
        ), []),
        optional(db.query(
          `SELECT count(*)::integer AS total,
             count(*) FILTER (WHERE visited_at > $2::timestamptz - interval '30 days')::integer AS last30,
             count(DISTINCT account_id)::integer AS players,
             (SELECT count(*)::integer FROM kip_game.tenures WHERE park_id = $1) AS tenures
           FROM kip_game.visits WHERE park_id = $1`,
          [id, now],
        ), []),
        optional(db.query(
          `SELECT pl.handle, t.started_at, t.last_visit_at, kip_game.fall_at(t.last_visit_at) AS falls_at,
             kip_game.flag_up(t.last_visit_at, t.ended_at, $2::timestamptz) AS up
           FROM kip_game.tenures t LEFT JOIN kip_game.players pl ON pl.account_id = t.holder_account_id
           WHERE t.park_id = $1 AND t.ended_at IS NULL`,
          [id, now],
        ), []),
        db.query(
          `SELECT c.revision, b.created_at, c.entity, c.operation, CASE WHEN c.entity = 'park' THEN c.value END AS value
           FROM public.content_changes c JOIN public.content_change_batches b ON b.revision = c.revision
           WHERE c.entity_id = $1 AND c.entity IN ('park', 'boundary', 'drive')
           ORDER BY c.revision DESC, c.entity LIMIT ${HISTORY_LIMIT}`,
          [id],
        ),
      ]);
      const park = parks[0];
      if (!park) return null;
      const f = founder[0], v = visits[0], t = flag[0];
      return {
        source: sourceOf(id, floor.length > 0, proposal.length > 0),
        hidden: hiddenOf(park),
        founder: f ? {
          handle: f.handle === null || f.handle === undefined ? null : String(f.handle), foundedAt: iso(f.founded_at), source: String(f.source),
          photoSha256: String(f.photo_sha256), photoWidth: Number(f.photo_width), photoHeight: Number(f.photo_height), photoBytes: Number(f.photo_bytes),
        } : null,
        visits: { total: Number(v?.total ?? 0), last30Days: Number(v?.last30 ?? 0), uniquePlayers: Number(v?.players ?? 0) },
        flag: t ? {
          handle: t.handle === null || t.handle === undefined ? null : String(t.handle),
          since: iso(t.started_at), lastVisitAt: iso(t.last_visit_at), fallsAt: iso(t.falls_at), up: t.up === true,
        } : null,
        tenures: Number(v?.tenures ?? 0),
        history: history.map((row) => ({
          revision: Number(row.revision), at: iso(row.created_at), entity: String(row.entity) as ChangeRow["entity"],
          operation: row.operation === "delete" ? "delete" : "upsert", value: row.value ? jsonValue<Record<string, unknown>>(row.value) : null,
        })),
      };
    },

    hide: (id, reason) => run(hideStatements(id, reason)),
    unhide: (id) => run(unhideStatements(id)),
    remove: (id) => run(deleteStatements(id)),

    async clearFounder(id) {
      const rows = await optional(db.query("DELETE FROM kip_founders.parks WHERE park_id = $1 RETURNING park_id", [id]), []);
      if (!rows.length) throw new HttpError(404, "no_founder", "This park has no founder.");
    },

    async replaceCover(id, photo, at) {
      const rows = await optional(db.query(
        `UPDATE kip_founders.parks SET photo_bytes = decode($2, 'base64'), photo_sha256 = $3, photo_width = $4, photo_height = $5,
           moderation = moderation || jsonb_build_object('operatorCoverReplacedAt', $6::text)
         WHERE park_id = $1 RETURNING park_id`,
        [id, photo.base64, photo.sha256, photo.width, photo.height, at],
      ), []);
      if (!rows.length) throw new HttpError(404, "no_founder", "This park has no founder, so it has no cover to replace.");
    },

    async cover(id) {
      const rows = await optional(db.query("SELECT encode(photo_bytes, 'base64') AS photo, photo_sha256 FROM kip_founders.parks WHERE park_id = $1", [id]), []);
      const row = rows[0];
      if (!row) return null;
      return { bytes: Uint8Array.from(atob(String(row.photo)), (char) => char.charCodeAt(0)), contentType: "image/jpeg", sha256: String(row.photo_sha256) };
    },
  };
}

export function neonRunner(databaseUrl: string): SqlRunner {
  const sql = neon(databaseUrl);
  return {
    query: (statement, params = []) => sql.query(statement, params) as Promise<Record<string, unknown>[]>,
    transaction: (statements) => sql.transaction(statements.map(({ text, params }) => sql.query(text, params))) as Promise<Record<string, unknown>[][]>,
  };
}

export function createNeonParkManagerStore(databaseUrl: string): ParkManagerStore {
  return createSqlParkManagerStore(neonRunner(databaseUrl));
}
