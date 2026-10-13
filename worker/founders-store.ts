import { database, type SqlClient } from "./db.js";
import { badgeUnlocksFromJson, visitFromJson } from "./game-store.js";
import { runFounding, type FoundedRecord, type FoundExistingInput, type FoundOsmInput, type FoundResult } from "./founding.js";
import type { MultiPolygon, OsmFeature } from "./osmParks.js";
import { hiddenParks } from "./parkVisibility.js";
import { databaseSqlRunner } from "./proposalReview.js";
import type { SqlRunner } from "./parkPublish.js";

export type { FoundCommon, FoundedRecord, FoundExistingInput, FoundOsmInput, FoundResult, PhotoInput } from "./founding.js";

/** Park founders storage (database/migrations/founders_001_init.sql, founders_002_reviews.sql). Every query goes through database(). */

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
  /** When the photo of a rejected or unsure check was kept for a review; null once it is gone. */
  keptAt: string | null;
}

/** What a rejected or unsure check keeps for a day, so the player can ask for a review (#153). */
export interface KeptAttempt {
  parkName: string;
  /** The outline checked against, for an OpenStreetMap park not in Parkdex yet. */
  osmFeature: OsmFeature | null;
  position: { lat: number; lng: number; accuracyM: number };
  photo: { sha256: string; base64: string; width: number; height: number };
}

export type ReviewStatus = "pending" | "approved" | "rejected" | "superseded";

export interface ReviewAttempt {
  /** The request already made for this attempt. */
  request: { id: string; status: ReviewStatus } | null;
  /** The newest check of this attempt. */
  check: { outcome: CheckRecord["outcome"]; flags: string[]; parkId: string; osm: { type: string; id: number } | null; kept: boolean } | null;
}

export type RequestReviewResult = "created" | "exists" | "pending" | "limited" | "already_founded" | "expired";

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
    /** Rejected and unsure checks keep the photo and position for a day. */
    keep: KeptAttempt | null;
  }): Promise<void>;
  foundOsm(input: FoundOsmInput): Promise<FoundResult>;
  foundExisting(input: FoundExistingInput): Promise<FoundResult>;
  cover(parkId: string, sha256: string): Promise<Uint8Array | null>;
  summary(parkId: string, accountId: string | null, now: string): Promise<ParkSummaryRecord | null>;
  /** The review request and the check behind an attempt, for `POST /api/parks/found/review`. */
  reviewAttempt(accountId: string, attemptId: string): Promise<ReviewAttempt>;
  /**
   * Moves the kept photo of an attempt into a new pending request, under a per-account lock that
   * also enforces the daily limit and one pending request per park.
   */
  requestReview(input: { id: string; accountId: string; attemptId: string; parkId: string; at: string; perDay: number }): Promise<RequestReviewResult>;
  /** Marks decided requests as seen by the player; returns the IDs it changed. */
  markReviewsSeen(accountId: string, requestIds: string[], at: string): Promise<string[]>;
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

export function createSqlFoundersStore(sql: SqlClient, db: SqlRunner): FoundersStore {
  const rows = async (text: string, params: unknown[]) => await sql.query(text, params) as Array<Record<string, unknown>>;

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
          `SELECT c.outcome, c.flags, c.photo_sha256, k.created_at AS kept_at
           FROM kip_founders.photo_checks c LEFT JOIN kip_founders.check_photos k ON k.check_id = c.id
           WHERE c.account_id = $1::uuid AND c.attempt_id = $2::uuid AND c.outcome <> 'unavailable'
           ORDER BY c.created_at DESC LIMIT 1`,
          [accountId, attemptId],
        ),
      ]);
      const row = founded[0];
      const visit = row ? jsonValue(row.visit) : null;
      // The badges the founding unlocked (#175), for a replay. None before game_004_badges.sql.
      const badges = row ? await rows("SELECT kip_game.visit_badges($1::uuid, $2::uuid) AS badges", [accountId, visitId])
        .then((found) => badgeUnlocksFromJson(jsonValue(found[0]?.badges)))
        .catch(() => []) : [];
      return {
        founded: row ? {
          parkId: String(row.park_id), parkName: String(row.name), photoSha256: String(row.photo_sha256),
          founderPoints: Number(row.founder_points), visit: visit ? visitFromJson(visit) : null, badges,
        } : null,
        check: checks[0] ? {
          outcome: String(checks[0].outcome) as CheckRecord["outcome"],
          flags: textArray(checks[0].flags),
          photoSha256: String(checks[0].photo_sha256),
          keptAt: checks[0].kept_at === null || checks[0].kept_at === undefined ? null : iso(checks[0].kept_at),
        } : null,
      };
    },

    async recordCheck(input) {
      const check = {
        text: `INSERT INTO kip_founders.photo_checks (id, account_id, attempt_id, park_id, osm_type, osm_id, created_at, outcome, flags, photo_sha256, moderation)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz, $8, $9::text[], $10, $11::jsonb)`,
        params: [input.id, input.accountId, input.attemptId, input.parkId, input.osm?.type ?? null, input.osm?.id ?? null, input.at,
          input.outcome, input.flags, input.photoSha256, input.moderation ? JSON.stringify(input.moderation) : null],
      };
      if (!input.keep) {
        await rows(check.text, check.params);
        return;
      }
      const { keep } = input;
      await db.transaction([check, {
        text: `INSERT INTO kip_founders.check_photos (check_id, account_id, attempt_id, created_at, park_name, osm_feature, latitude, longitude, accuracy_m,
            photo_sha256, photo_bytes, photo_width, photo_height)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5, $6::jsonb, $7, $8, $9, $10, decode($11, 'base64'), $12, $13)`,
        params: [input.id, input.accountId, input.attemptId, input.at, keep.parkName.slice(0, 200), keep.osmFeature ? JSON.stringify(keep.osmFeature) : null,
          keep.position.lat, keep.position.lng, keep.position.accuracyM, keep.photo.sha256, keep.photo.base64, keep.photo.width, keep.photo.height],
      }]);
    },

    async foundOsm(input) {
      return runFounding(db, { kind: "osm", ...input }, input.park.name, { visit: true, reviewRequestId: null });
    },

    async foundExisting(input) {
      const parks = await rows("SELECT name FROM public.parks WHERE id = $1", [input.parkId]);
      if (!parks[0]) return { status: "park_missing" };
      return runFounding(db, { kind: "existing", ...input }, String(parks[0].name), { visit: true, reviewRequestId: null });
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

    async reviewAttempt(accountId, attemptId) {
      const [requests, checks] = await Promise.all([
        rows("SELECT id, status FROM kip_founders.review_requests WHERE account_id = $1::uuid AND attempt_id = $2::uuid", [accountId, attemptId]),
        rows(
          `SELECT c.outcome, c.flags, c.park_id, c.osm_type, c.osm_id, (k.check_id IS NOT NULL) AS kept
           FROM kip_founders.photo_checks c LEFT JOIN kip_founders.check_photos k ON k.check_id = c.id
           WHERE c.account_id = $1::uuid AND c.attempt_id = $2::uuid
           ORDER BY c.created_at DESC, (c.outcome <> 'unavailable') DESC LIMIT 1`,
          [accountId, attemptId],
        ),
      ]);
      const check = checks[0];
      return {
        request: requests[0] ? { id: String(requests[0].id), status: String(requests[0].status) as ReviewStatus } : null,
        check: check ? {
          outcome: String(check.outcome) as CheckRecord["outcome"],
          flags: textArray(check.flags),
          parkId: String(check.park_id),
          osm: check.osm_type ? { type: String(check.osm_type), id: Number(check.osm_id) } : null,
          kept: check.kept === true,
        } : null,
      };
    },

    async requestReview(input) {
      const guard = (condition: string, reason: string, params: unknown[]) => ({ text: `SELECT kip_park_drafts.require(${condition}, '${reason}')`, params });
      try {
        await db.transaction([
          // One account's requests are counted and checked one at a time.
          { text: "SELECT pg_advisory_xact_lock(hashtextextended('kip_founders.review:' || $1, 0))", params: [input.accountId] },
          guard("NOT EXISTS (SELECT 1 FROM kip_founders.review_requests WHERE attempt_id = $1::uuid)", "review_exists", [input.attemptId]),
          guard("EXISTS (SELECT 1 FROM kip_founders.check_photos WHERE account_id = $1::uuid AND attempt_id = $2::uuid)", "review_expired", [input.accountId, input.attemptId]),
          guard("NOT EXISTS (SELECT 1 FROM kip_founders.parks WHERE park_id = $1)", "already_founded", [input.parkId]),
          guard("NOT EXISTS (SELECT 1 FROM kip_founders.review_requests WHERE account_id = $1::uuid AND park_id = $2 AND status = 'pending')", "review_pending", [input.accountId, input.parkId]),
          // Requests since the start of today in Victoria.
          guard(`(SELECT count(*) FROM kip_founders.review_requests WHERE account_id = $1::uuid
              AND created_at >= (kip_game.local_day($2::timestamptz)::timestamp AT TIME ZONE 'America/Vancouver')) < $3`, "review_limit",
          [input.accountId, input.at, input.perDay]),
          {
            text: `INSERT INTO kip_founders.review_requests (id, account_id, attempt_id, check_id, park_id, osm_type, osm_id, park_name, osm_feature,
                latitude, longitude, accuracy_m, photo_bytes, photo_sha256, photo_width, photo_height, outcome, flags, moderation, checked_at, created_at)
              SELECT $1::uuid, k.account_id, k.attempt_id, c.id, c.park_id, c.osm_type, c.osm_id, k.park_name, k.osm_feature,
                k.latitude, k.longitude, k.accuracy_m, k.photo_bytes, k.photo_sha256, k.photo_width, k.photo_height, c.outcome, c.flags, c.moderation,
                c.created_at, $4::timestamptz
              FROM kip_founders.check_photos k JOIN kip_founders.photo_checks c ON c.id = k.check_id
              WHERE k.account_id = $2::uuid AND k.attempt_id = $3::uuid AND c.outcome IN ('reject', 'unsure')
              ORDER BY k.created_at DESC LIMIT 1`,
            params: [input.id, input.accountId, input.attemptId, input.at],
          },
          guard("EXISTS (SELECT 1 FROM kip_founders.review_requests WHERE id = $1::uuid)", "review_expired", [input.id]),
          // The request holds its own copy now; the day-long copy goes.
          { text: "DELETE FROM kip_founders.check_photos WHERE account_id = $1::uuid AND attempt_id = $2::uuid", params: [input.accountId, input.attemptId] },
        ]);
        return "created";
      } catch (error) {
        const reason = `${error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "")} ${String((error as { constraint?: unknown })?.constraint ?? "")}`;
        if (/review_exists|review_requests_attempt_id_key/.test(reason)) return "exists";
        if (/review_pending|review_requests_one_pending_idx/.test(reason)) return "pending";
        if (/review_limit/.test(reason)) return "limited";
        if (/already_founded/.test(reason)) return "already_founded";
        if (/review_expired/.test(reason)) return "expired";
        throw error;
      }
    },

    async markReviewsSeen(accountId, requestIds, at) {
      if (!requestIds.length) return [];
      const updated = await rows(
        `UPDATE kip_founders.review_requests SET seen_at = $3::timestamptz
         WHERE account_id = $1::uuid AND id = ANY($2::uuid[]) AND status <> 'pending' AND seen_at IS NULL
         RETURNING id`,
        [accountId, [...new Set(requestIds)], at],
      );
      return updated.map((row) => String(row.id)).sort();
    },

    runner: () => db,
  };
}

export function createNeonFoundersStore(databaseUrl: string): FoundersStore {
  return createSqlFoundersStore(database(databaseUrl), databaseSqlRunner(databaseUrl));
}
