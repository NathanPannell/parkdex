import { database, type SqlClient } from "./db.js";
import { visitFromJson, type VisitRecord } from "./game-store.js";
import { publishStatements } from "../operator/server/drafts.js";
import type { MultiPolygon } from "./osmParks.js";
import type { PublishablePark } from "./parkPublish.js";
import { hiddenParks } from "./parkVisibility.js";
import { databaseSqlRunner } from "./proposalReview.js";
import type { SqlRunner } from "./parkPublish.js";

/** Park founders storage (database/migrations/founders_001_init.sql). Every query goes through database(). */

export interface CatalogueParkRecord {
  id: string;
  name: string;
  category: string;
  boundary: MultiPolygon | null;
}

export interface FounderInfo {
  handle: string | null;
  foundedAt: string;
  photoSha256: string;
}

export interface CheckRecord {
  outcome: "approve" | "reject" | "unsure" | "unavailable";
  flags: string[];
  photoSha256: string;
}

export interface FoundedRecord {
  parkId: string;
  parkName: string;
  photoSha256: string;
  visit: VisitRecord | null;
  founderPoints: number;
}

export interface PhotoInput {
  sha256: string;
  base64: string;
  width: number;
  height: number;
}

export interface FoundCommon {
  accountId: string;
  attemptId: string;
  visitId: string;
  /** Server time of the founding and of the visit it records. */
  at: string;
  photo: PhotoInput;
  /** The model's answers, stored with the founder; never the image. */
  moderation: Record<string, unknown>;
}

export interface FoundOsmInput extends FoundCommon {
  park: PublishablePark;
  osm: { type: string; id: number };
  /** The proposal row that records this founding for the operator. */
  proposal: { id: string; moderation: Record<string, unknown> };
}

export interface FoundExistingInput extends FoundCommon {
  parkId: string;
}

export type FoundResult =
  | { status: "founded"; record: FoundedRecord }
  /** park_exists: the OpenStreetMap park was published another way meanwhile; found it as an existing park. */
  | { status: "already_founded" | "park_exists" | "park_missing" | "blocked" | "attempt_reused" | "visit_failed" };

export interface ParkSummaryRecord {
  founder: FounderInfo | null;
  total: number;
  last30Days: number;
  mine: number | null;
}

export interface FoundersStore {
  catalogueParks(parkIds: string[]): Promise<Map<string, CatalogueParkRecord>>;
  hidden(parkIds: string[]): Promise<Set<string>>;
  founders(parkIds: string[]): Promise<Map<string, FounderInfo>>;
  hasHandle(accountId: string): Promise<boolean>;
  usage(accountId: string, now: string): Promise<{ checksLastHour: number; foundedLastDay: number }>;
  /** What an earlier request with this attempt ID already did. */
  attempt(accountId: string, attemptId: string, visitId: string): Promise<{ founded: FoundedRecord | null; check: CheckRecord | null }>;
  recordCheck(input: {
    id: string;
    accountId: string;
    attemptId: string;
    parkId: string;
    osm: { type: string; id: number } | null;
    at: string;
    outcome: CheckRecord["outcome"];
    flags: string[];
    photoSha256: string;
    moderation: Record<string, unknown> | null;
  }): Promise<void>;
  foundOsm(input: FoundOsmInput): Promise<FoundResult>;
  foundExisting(input: FoundExistingInput): Promise<FoundResult>;
  cover(parkId: string, sha256: string): Promise<Uint8Array | null>;
  summary(parkId: string, accountId: string | null, now: string): Promise<ParkSummaryRecord | null>;
  /** The database runner, for the shared catalogue lookups. */
  runner(): SqlRunner;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  // Some drivers return a PostgreSQL array literal such as {people,lighting}.
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) return value.slice(1, -1).split(",").filter(Boolean);
  return [];
}

function missingRelation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "42P01";
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  const constraint = String((error as { constraint?: unknown })?.constraint ?? "");
  return `${message} ${constraint}`;
}

const lockStatement = (parkId: string) => ({
  // Serialises founders of one park; record_visit takes its own park lock after this one.
  text: "SELECT pg_advisory_xact_lock(hashtextextended('kip_founders.park:' || $1, 0))",
  params: [parkId],
});

const notFoundedStatement = (parkId: string) => ({
  text: "SELECT kip_park_drafts.require(NOT EXISTS (SELECT 1 FROM kip_founders.parks WHERE park_id = $1), 'already_founded')",
  params: [parkId],
});

function founderStatement(input: FoundCommon, parkId: string, source: "osm_new" | "existing") {
  return {
    text: `INSERT INTO kip_founders.parks
        (park_id, account_id, attempt_id, founded_at, source, photo_sha256, photo_bytes, photo_width, photo_height, moderation)
      VALUES ($1, $2::uuid, $3::uuid, $4::timestamptz, $5, $6, decode($7, 'base64'), $8, $9, $10::jsonb)
      RETURNING kip_founders.bonus_points() AS founder_points`,
    params: [parkId, input.accountId, input.attemptId, input.at, source, input.photo.sha256, input.photo.base64,
      input.photo.width, input.photo.height, JSON.stringify(input.moderation)],
  };
}

function visitStatement(input: FoundCommon, parkId: string) {
  return {
    // Founding counts as today's visit. Anything but a recorded (or same-day) visit rolls it all back.
    text: `SELECT kip_park_drafts.require((v.r->>'status') IN ('recorded', 'already_today', 'replayed'), 'visit_' || coalesce(v.r->>'status', 'failed')) AS ok,
        v.r AS result
      FROM (SELECT kip_game.record_visit($1::uuid, $2::uuid, $3, $4::timestamptz) AS r) v`,
    params: [input.visitId, input.accountId, parkId, input.at],
  };
}

export function createSqlFoundersStore(sql: SqlClient, db: SqlRunner): FoundersStore {
  const rows = async (text: string, params: unknown[]) => await sql.query(text, params) as Array<Record<string, unknown>>;

  async function run(statements: { text: string; params: unknown[] }[], parkId: string, parkName: string, photoSha256: string): Promise<FoundResult> {
    let results: Record<string, unknown>[][];
    try {
      results = await db.transaction(statements);
    } catch (error) {
      const reason = failure(error);
      if (/already_founded/.test(reason)) return { status: "already_founded" };
      if (/attempt_id/.test(reason)) return { status: "attempt_reused" };
      // The primary key on kip_founders.parks backs up the guard.
      if (/23505|duplicate key|parks_pkey/.test(reason)) return { status: "already_founded" };
      if (/park_exists/.test(reason)) return { status: "park_exists" };
      if (/park_missing/.test(reason)) return { status: "park_missing" };
      if (/draft_changed|draft_missing|draft_incomplete|badge_changed/.test(reason)) return { status: "blocked" };
      if (/visit_/.test(reason)) return { status: "visit_failed" };
      throw error;
    }
    const founderPoints = Number(results.find((result) => result[0] && "founder_points" in result[0])?.[0]?.founder_points ?? 0);
    const visitRow = results[results.length - 1]?.[0];
    const body = jsonValue(visitRow?.result) as { visit?: unknown } | null;
    return {
      status: "founded",
      record: { parkId, parkName, photoSha256, founderPoints, visit: body?.visit ? visitFromJson(body.visit) : null },
    };
  }

  async function founders(parkIds: string[]): Promise<Map<string, FounderInfo>> {
    if (!parkIds.length) return new Map();
    try {
      const found = await rows(
        `SELECT f.park_id, pl.handle, f.founded_at, f.photo_sha256
         FROM kip_founders.parks f
         LEFT JOIN kip_game.players pl ON pl.account_id = f.account_id
         WHERE f.park_id = ANY($1::text[])`,
        [[...new Set(parkIds)]],
      );
      return new Map(found.map((row) => [String(row.park_id), {
        handle: row.handle === null || row.handle === undefined ? null : String(row.handle),
        foundedAt: iso(row.founded_at),
        photoSha256: String(row.photo_sha256),
      }]));
    } catch (error) {
      // A database without founders_001 has no founders.
      if (missingRelation(error)) return new Map();
      throw error;
    }
  }

  return {
    async catalogueParks(parkIds) {
      if (!parkIds.length) return new Map();
      const found = await rows(
        `SELECT p.id, p.name, p.category, b.feature->'geometry' AS geometry
         FROM public.parks p LEFT JOIN public.boundaries b ON b.park_id = p.id
         WHERE p.id = ANY($1::text[])`,
        [[...new Set(parkIds)]],
      );
      return new Map(found.map((row) => {
        const geometry = jsonValue(row.geometry) as MultiPolygon | null;
        return [String(row.id), {
          id: String(row.id), name: String(row.name), category: String(row.category ?? "park"),
          boundary: geometry && geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates) && geometry.coordinates.length ? geometry : null,
        }];
      }));
    },

    async hidden(parkIds) {
      return new Set((await hiddenParks(sql, parkIds)).keys());
    },

    founders,

    async hasHandle(accountId) {
      const found = await rows(
        `SELECT 1 FROM kip_game.players p JOIN kip_account.accounts a ON a.id = p.account_id AND a.deletion_state = 'active'
         WHERE p.account_id = $1::uuid`,
        [accountId],
      );
      return found.length > 0;
    },

    async usage(accountId, now) {
      const found = await rows(
        `SELECT
           (SELECT count(*) FROM kip_founders.photo_checks
             WHERE account_id = $1::uuid AND created_at > $2::timestamptz - interval '1 hour')::integer AS checks,
           (SELECT count(*) FROM kip_founders.parks
             WHERE account_id = $1::uuid AND founded_at > $2::timestamptz - interval '24 hours')::integer AS founded`,
        [accountId, now],
      );
      return { checksLastHour: Number(found[0]?.checks ?? 0), foundedLastDay: Number(found[0]?.founded ?? 0) };
    },

    async attempt(accountId, attemptId, visitId) {
      const [founded, checks] = await Promise.all([
        rows(
          `SELECT f.park_id, p.name, f.photo_sha256, kip_founders.bonus_points() AS founder_points,
             kip_game.visit_json($1::uuid, $3::uuid) AS visit
           FROM kip_founders.parks f JOIN public.parks p ON p.id = f.park_id
           WHERE f.account_id = $1::uuid AND f.attempt_id = $2::uuid`,
          [accountId, attemptId, visitId],
        ),
        rows(
          `SELECT outcome, flags, photo_sha256 FROM kip_founders.photo_checks
           WHERE account_id = $1::uuid AND attempt_id = $2::uuid AND outcome <> 'unavailable'
           ORDER BY created_at DESC LIMIT 1`,
          [accountId, attemptId],
        ),
      ]);
      const row = founded[0];
      const visit = row ? jsonValue(row.visit) : null;
      return {
        founded: row ? {
          parkId: String(row.park_id), parkName: String(row.name), photoSha256: String(row.photo_sha256),
          founderPoints: Number(row.founder_points), visit: visit ? visitFromJson(visit) : null,
        } : null,
        check: checks[0] ? {
          outcome: String(checks[0].outcome) as CheckRecord["outcome"],
          flags: textArray(checks[0].flags),
          photoSha256: String(checks[0].photo_sha256),
        } : null,
      };
    },

    async recordCheck(input) {
      await rows(
        `INSERT INTO kip_founders.photo_checks (id, account_id, attempt_id, park_id, osm_type, osm_id, created_at, outcome, flags, photo_sha256, moderation)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz, $8, $9::text[], $10, $11::jsonb)`,
        [input.id, input.accountId, input.attemptId, input.parkId, input.osm?.type ?? null, input.osm?.id ?? null, input.at,
          input.outcome, input.flags, input.photoSha256, input.moderation ? JSON.stringify(input.moderation) : null],
      );
    },

    async foundOsm(input) {
      const { park } = input;
      const sourceSha256 = await sha256Hex(JSON.stringify(park.source));
      const statements = [
        lockStatement(park.id),
        notFoundedStatement(park.id),
        {
          text: `INSERT INTO kip_proposals.parks (id, submission_id, payload_hash, name, note, longitude, latitude, context, status,
              osm_type, osm_id, decision, moderation, decided_at, published_park_id, founder_account_id)
            VALUES ($1::uuid, $2::uuid, $3, $4, '', $5, $6, $7::jsonb, 'accepted', $8, $9, 'approved', $10::jsonb, $11::timestamptz, $12, $13::uuid)`,
          params: [input.proposal.id, input.attemptId, input.photo.sha256, park.name.slice(0, 120), park.lng, park.lat,
            JSON.stringify({ source: "founder" }), input.osm.type, input.osm.id, JSON.stringify(input.proposal.moderation), input.at, park.id, input.accountId],
        },
        {
          // The draft is written inside the founding transaction, so a failed founding leaves no
          // draft behind to block the next player. A draft left by an earlier proposal is reused.
          text: `INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb, updated_at)
            VALUES ($1, $2::jsonb, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz)
            ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, source_sha256 = EXCLUDED.source_sha256, geometry = EXCLUDED.geometry,
              name = EXCLUDED.name, short = EXCLUDED.short, category = EXCLUDED.category, region = EXCLUDED.region, lat = EXCLUDED.lat,
              lng = EXCLUDED.lng, biome = EXCLUDED.biome, shape = EXCLUDED.shape, rarity = EXCLUDED.rarity, seed = EXCLUDED.seed,
              blurb = EXCLUDED.blurb, updated_at = EXCLUDED.updated_at
            WHERE kip_park_drafts.drafts.status = 'draft' AND kip_park_drafts.drafts.source ? 'proposal'`,
          params: [park.id, JSON.stringify(park.source), sourceSha256, JSON.stringify(park.geometry), park.name, park.short, park.category,
            park.region, park.lat, park.lng, park.biome, park.shape, park.rarity, park.seed, park.blurb, input.at],
        },
        ...publishStatements(park.id, input.at, null),
        founderStatement(input, park.id, "osm_new"),
        visitStatement(input, park.id),
      ];
      return run(statements, park.id, park.name, input.photo.sha256);
    },

    async foundExisting(input) {
      const parks = await rows("SELECT name FROM public.parks WHERE id = $1", [input.parkId]);
      if (!parks[0]) return { status: "park_missing" };
      const statements = [
        lockStatement(input.parkId),
        notFoundedStatement(input.parkId),
        { text: "SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM public.parks WHERE id = $1), 'park_missing')", params: [input.parkId] },
        founderStatement(input, input.parkId, "existing"),
        visitStatement(input, input.parkId),
      ];
      return run(statements, input.parkId, String(parks[0].name), input.photo.sha256);
    },

    async cover(parkId, sha256) {
      try {
        const found = await rows(
          "SELECT encode(photo_bytes, 'base64') AS photo FROM kip_founders.parks WHERE park_id = $1 AND photo_sha256 = $2",
          [parkId, sha256],
        );
        return found[0] ? new Uint8Array(Buffer.from(String(found[0].photo), "base64")) : null;
      } catch (error) {
        if (missingRelation(error)) return null;
        throw error;
      }
    },

    async summary(parkId, accountId, now) {
      const [parks, counts, known] = await Promise.all([
        rows("SELECT 1 FROM public.parks WHERE id = $1", [parkId]),
        rows(
          `SELECT count(*)::integer AS total,
             count(*) FILTER (WHERE visited_at > $2::timestamptz - interval '30 days')::integer AS last30,
             count(*) FILTER (WHERE account_id = $3::uuid)::integer AS mine
           FROM kip_game.visits WHERE park_id = $1 AND visited_at <= $2::timestamptz`,
          [parkId, now, accountId],
        ),
        founders([parkId]),
      ]);
      if (!parks[0]) return null;
      return {
        founder: known.get(parkId) ?? null,
        total: Number(counts[0]?.total ?? 0),
        last30Days: Number(counts[0]?.last30 ?? 0),
        mine: accountId ? Number(counts[0]?.mine ?? 0) : null,
      };
    },

    runner: () => db,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function createNeonFoundersStore(databaseUrl: string): FoundersStore {
  return createSqlFoundersStore(database(databaseUrl), databaseSqlRunner(databaseUrl));
}
