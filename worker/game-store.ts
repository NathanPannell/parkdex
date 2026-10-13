import { database } from "./db.js";
import { isParkHidden } from "./parkVisibility.js";

export interface PlayerRecord {
  handle: string;
  flagSeed: string;
  createdAt: string;
  takeoversSeenAt: string | null;
}

export type VisitOutcome = "planted" | "took" | "held" | "already_today";

export interface VisitRecord {
  visitId: string;
  parkId: string;
  outcome: VisitOutcome;
  pointsEarned: number;
  /** pointsEarned split into the outcome's base points and a take's day bonus (#169). */
  pointsBreakdown: PointsBreakdown;
  previousHolder: { handle: string; flagSeed: string } | null;
  flagSince: string | null;
  visitedAt: string;
  /** True when this visit first closed a fallen flag at the park. */
  fell: boolean;
}

export interface PointsBreakdown {
  base: number;
  /** One point per whole day the taken flag had flown; 0 for every other outcome. */
  days: number;
}

export type RecordVisitResult =
  | { status: "recorded" | "replayed" | "already_today"; visit: VisitRecord }
  | { status: "park_not_found" | "handle_required" | "account_unavailable" | "conflict" };

export type SetHandleResult =
  | { status: "saved"; player: PlayerRecord }
  | { status: "taken" | "account_unavailable" };

export interface HeldPark {
  parkId: string;
  /** When the flag went up; days counts from here, for weathering. */
  since: string;
  days: number;
  /** Whole hours this account has held the flag: its holding points so far. */
  hours: number;
}

export interface Takeover {
  parkId: string;
  byHandle: string;
  byFlagSeed: string;
  at: string;
}

export interface PlayerSummary {
  score: number;
  parks: HeldPark[];
  takeovers: Takeover[];
  /** Parks this account has already visited on the current America/Vancouver day. */
  visitedToday: string[];
  /** When that day ends (the next Victoria midnight), so clients never need time zone rules. */
  visitedTodayUntil: string;
}

export interface FlagRecord {
  parkId: string;
  handle: string;
  flagSeed: string;
  since: string;
}

/** A founded park, for the map: who founded it and which cover photo it has. */
export interface FounderRecord {
  parkId: string;
  handle: string | null;
  photoSha256: string;
}

/** A manual review request (#153) the player should see: pending, or decided and not yet shown. */
export interface FoundingReviewRecord {
  requestId: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  /** The park an approval founded, else the requested park. */
  parkId: string;
  osm: { type: string; id: number } | null;
  parkName: string;
  reason: string | null;
  /** The park's current founder and cover, if any. */
  founderHandle: string | null;
  founderIsPlayer: boolean;
  coverSha256: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface LeaderboardRow {
  rank: number;
  handle: string;
  flagSeed: string;
  score: number;
  parksHeld: number;
}

export interface GameStore {
  getPlayer(accountId: string): Promise<PlayerRecord | null>;
  handleOwner(handle: string, accountId: string): Promise<"none" | "self" | "other">;
  setHandle(accountId: string, handle: string): Promise<SetHandleResult>;
  recordVisit(accountId: string, visitId: string, parkId: string, visitedAt: string): Promise<RecordVisitResult>;
  summary(accountId: string, now: string): Promise<PlayerSummary>;
  markTakeoversSeen(accountId: string, at: string): Promise<PlayerRecord | null>;
  flags(now: string): Promise<FlagRecord[]>;
  leaderboard(now: string): Promise<LeaderboardRow[]>;
  /** Every founded park. Empty where founders_001_init.sql has not run. */
  founders?(): Promise<FounderRecord[]>;
  /** The founder bonus included in the account's score. */
  founderPoints?(accountId: string, now: string): Promise<number>;
  /** Pending review requests and unseen decisions. Empty where founders_002_reviews.sql has not run. */
  foundingReviews?(accountId: string): Promise<FoundingReviewRecord[]>;
}

export const TAKEOVER_LIMIT = 50;
const VISIT_OUTCOMES = new Set(["planted", "took", "held", "already_today"]);

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

function playerFromRow(row: Record<string, unknown>): PlayerRecord {
  return {
    handle: String(row.handle),
    flagSeed: String(row.flag_seed),
    createdAt: iso(row.created_at),
    takeoversSeenAt: nullableIso(row.takeovers_seen_at),
  };
}

export function visitFromJson(value: unknown): VisitRecord {
  const visit = value as Record<string, unknown>;
  const outcome = String(visit.outcome);
  if (!VISIT_OUTCOMES.has(outcome)) throw new Error("unexpected stored visit outcome");
  const holder = visit.previousHolder as Record<string, unknown> | null;
  const pointsEarned = Number(visit.pointsEarned);
  const breakdown = visit.pointsBreakdown as Record<string, unknown> | null | undefined;
  return {
    visitId: String(visit.visitId).toLowerCase(),
    parkId: String(visit.parkId),
    outcome: outcome as VisitOutcome,
    pointsEarned,
    // game_001's visit_json has no breakdown; it only runs briefly while a deploy replays it.
    pointsBreakdown: breakdown
      ? { base: Number(breakdown.base), days: Number(breakdown.days) }
      : { base: pointsEarned, days: 0 },
    previousHolder: holder ? { handle: String(holder.handle), flagSeed: String(holder.flagSeed) } : null,
    flagSince: nullableIso(visit.flagSince),
    visitedAt: iso(visit.visitedAt),
    fell: visit.fell === true,
  };
}

// Undefined table or function: a database without founders_001_init.sql.
function missingFounders(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "42P01" || code === "42883" || code === "3F000";
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

export function createNeonGameStore(databaseUrl: string): GameStore {
  const sql = database(databaseUrl);
  const rows = async (text: string, params: unknown[]) => await sql.query(text, params) as Array<Record<string, unknown>>;

  const playerColumns = "handle, flag_seed, created_at, takeovers_seen_at";

  return {
    async getPlayer(accountId) {
      const found = await rows(`SELECT ${playerColumns} FROM kip_game.players WHERE account_id = $1::uuid`, [accountId]);
      return found[0] ? playerFromRow(found[0]) : null;
    },

    async handleOwner(handle, accountId) {
      const found = await rows("SELECT account_id = $2::uuid AS mine FROM kip_game.players WHERE handle = $1", [handle, accountId]);
      if (!found[0]) return "none";
      return found[0].mine === true || found[0].mine === "t" ? "self" : "other";
    },

    async setHandle(accountId, handle) {
      try {
        const saved = await rows(`
          INSERT INTO kip_game.players (account_id, handle, flag_seed)
          SELECT a.id, $2, kip_game.flag_seed(a.id) FROM kip_account.accounts a
          WHERE a.id = $1::uuid AND a.deletion_state = 'active'
          ON CONFLICT (account_id) DO UPDATE SET handle = EXCLUDED.handle,
            updated_at = CASE WHEN kip_game.players.handle = EXCLUDED.handle THEN kip_game.players.updated_at ELSE now() END
          RETURNING ${playerColumns}`, [accountId, handle]);
        return saved[0] ? { status: "saved", player: playerFromRow(saved[0]) } : { status: "account_unavailable" };
      } catch (error) {
        if (uniqueViolation(error)) return { status: "taken" };
        throw error;
      }
    },

    async recordVisit(accountId, visitId, parkId, visitedAt) {
      // A hidden park takes no new visits; a replay of a visit stored before it was hidden still answers.
      if (await isParkHidden(sql, parkId)) {
        const stored = await rows("SELECT 1 FROM kip_game.visits WHERE account_id = $1::uuid AND visit_id = $2::uuid", [accountId, visitId]);
        if (!stored.length) return { status: "park_not_found" };
      }
      const result = await rows("SELECT kip_game.record_visit($1::uuid, $2::uuid, $3, $4::timestamptz) AS result", [visitId, accountId, parkId, visitedAt]);
      const body = jsonValue(result[0]?.result) as { status: string; visit?: unknown };
      if (body.status === "recorded" || body.status === "replayed" || body.status === "already_today") {
        return { status: body.status, visit: visitFromJson(body.visit) };
      }
      if (body.status === "park_not_found" || body.status === "handle_required" || body.status === "account_unavailable" || body.status === "conflict") {
        return { status: body.status };
      }
      throw new Error("unexpected record_visit status");
    },

    async summary(accountId, now) {
      const [score, parks, takeovers, visitedToday, dayEnd] = await Promise.all([
        rows("SELECT score FROM kip_game.player_scores($2::timestamptz) WHERE account_id = $1::uuid", [accountId, now]),
        rows(`
          SELECT h.park_id, h.flag_since, kip_game.whole_days(h.flag_since, $2::timestamptz) AS days,
            kip_game.holding_points(h.held_from, h.last_visit_at, h.ended_at, $2::timestamptz) AS hours
          FROM kip_game.holdings($2::timestamptz) h
          WHERE h.account_id = $1::uuid AND kip_game.flag_up(h.last_visit_at, h.ended_at, $2::timestamptz)
          ORDER BY h.flag_since ASC, h.park_id ASC`, [accountId, now]),
        rows(`
          SELECT t.park_id, t.ended_at, taker.handle, taker.flag_seed
          FROM kip_game.players me
          JOIN kip_game.tenures t ON t.holder_account_id = me.account_id AND t.end_reason = 'taken'
          JOIN kip_game.players taker ON taker.account_id = t.ended_by_account_id
          WHERE me.account_id = $1::uuid AND t.ended_at > coalesce(me.takeovers_seen_at, me.created_at)
            AND t.ended_at <= $2::timestamptz
          ORDER BY t.ended_at DESC, t.park_id ASC
          LIMIT ${TAKEOVER_LIMIT}`, [accountId, now]),
        rows(`
          SELECT DISTINCT park_id FROM kip_game.visits
          WHERE account_id = $1::uuid AND source = 'visit'
            AND local_day = kip_game.local_day($2::timestamptz) AND visited_at <= $2::timestamptz
          ORDER BY park_id`, [accountId, now]),
        rows("SELECT ((kip_game.local_day($1::timestamptz) + 1)::timestamp AT TIME ZONE 'America/Vancouver') AS until", [now]),
      ]);
      return {
        score: Number(score[0]?.score ?? 0),
        parks: parks.map((row) => ({ parkId: String(row.park_id), since: iso(row.flag_since), days: Number(row.days), hours: Number(row.hours) })),
        takeovers: takeovers.map((row) => ({
          parkId: String(row.park_id), byHandle: String(row.handle), byFlagSeed: String(row.flag_seed), at: iso(row.ended_at),
        })),
        visitedToday: visitedToday.map((row) => String(row.park_id)),
        visitedTodayUntil: iso(dayEnd[0]?.until),
      };
    },

    async markTakeoversSeen(accountId, at) {
      // Never move the marker backwards, so an older tab cannot resurrect seen messages.
      const updated = await rows(`
        UPDATE kip_game.players SET takeovers_seen_at = greatest(coalesce(takeovers_seen_at, '-infinity'::timestamptz), $2::timestamptz)
        WHERE account_id = $1::uuid
        RETURNING ${playerColumns}`, [accountId, at]);
      return updated[0] ? playerFromRow(updated[0]) : null;
    },

    async flags(now) {
      const found = await rows("SELECT park_id, handle, flag_seed, since FROM kip_game.flags_up($1::timestamptz)", [now]);
      return found.map((row) => ({ parkId: String(row.park_id), handle: String(row.handle), flagSeed: String(row.flag_seed), since: iso(row.since) }));
    },

    async founders() {
      try {
        const found = await rows(`
          SELECT f.park_id, pl.handle, f.photo_sha256
          FROM kip_founders.parks f
          LEFT JOIN kip_game.players pl ON pl.account_id = f.account_id
          ORDER BY f.park_id`, []);
        return found.map((row) => ({
          parkId: String(row.park_id),
          handle: row.handle === null || row.handle === undefined ? null : String(row.handle),
          photoSha256: String(row.photo_sha256),
        }));
      } catch (error) {
        if (missingFounders(error)) return [];
        throw error;
      }
    },

    async founderPoints(accountId, now) {
      try {
        const found = await rows("SELECT kip_founders.founder_points($1::uuid, $2::timestamptz) AS points", [accountId, now]);
        return Number(found[0]?.points ?? 0);
      } catch (error) {
        if (missingFounders(error)) return 0;
        throw error;
      }
    },

    async foundingReviews(accountId) {
      try {
        const found = await rows(`
          SELECT r.id, r.status, coalesce(r.founded_park_id, r.park_id) AS park_id, r.osm_type, r.osm_id,
            coalesce(p.name, r.park_name) AS park_name, r.decision_reason, r.created_at, r.decided_at,
            f.photo_sha256, (f.account_id = r.account_id) AS founder_is_player, pl.handle AS founder_handle
          FROM kip_founders.review_requests r
          LEFT JOIN public.parks p ON p.id = coalesce(r.founded_park_id, r.park_id)
          LEFT JOIN kip_founders.parks f ON f.park_id = coalesce(r.founded_park_id, r.park_id)
          LEFT JOIN kip_game.players pl ON pl.account_id = f.account_id
          WHERE r.account_id = $1::uuid AND (r.status = 'pending' OR r.seen_at IS NULL)
          ORDER BY coalesce(r.decided_at, r.created_at), r.created_at, r.id
          LIMIT 100`, [accountId]);
        return found.map((row) => ({
          requestId: String(row.id),
          status: String(row.status) as FoundingReviewRecord["status"],
          parkId: String(row.park_id),
          osm: row.osm_type ? { type: String(row.osm_type), id: Number(row.osm_id) } : null,
          parkName: String(row.park_name),
          reason: row.decision_reason === null || row.decision_reason === undefined ? null : String(row.decision_reason),
          founderHandle: row.founder_handle === null || row.founder_handle === undefined ? null : String(row.founder_handle),
          founderIsPlayer: row.founder_is_player === true,
          coverSha256: row.photo_sha256 === null || row.photo_sha256 === undefined ? null : String(row.photo_sha256),
          createdAt: iso(row.created_at),
          decidedAt: nullableIso(row.decided_at),
        }));
      } catch (error) {
        if (missingFounders(error)) return [];
        throw error;
      }
    },

    async leaderboard(now) {
      const found = await rows("SELECT rank, handle, flag_seed, score, parks_held FROM kip_game.leaderboard($1::timestamptz)", [now]);
      return found.map((row) => ({
        rank: Number(row.rank), handle: String(row.handle), flagSeed: String(row.flag_seed), score: Number(row.score), parksHeld: Number(row.parks_held),
      }));
    },
  };
}
