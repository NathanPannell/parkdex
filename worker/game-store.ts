import { database } from "./db.js";
import { isParkHidden } from "./parkVisibility.js";

export interface PlayerRecord {
  handle: string;
  flagSeed: string;
  createdAt: string;
  takeoversSeenAt: string | null;
}

/** `joined` and `logged` are crew outcomes (#170): joining a crew, and a visit during someone else's protected hour. */
export type VisitOutcome = "planted" | "took" | "held" | "joined" | "logged" | "already_today";

/** Why a visit was logged instead of taking the flag: someone else's protected hour (#170). */
export interface ProtectedRecord {
  /** When the protected hour ends; the flag can be taken from then on. */
  until: string;
  leader: { handle: string; flagSeed: string };
  crewSize: number;
}

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
  /** Set for a logged visit, and for already_today during someone else's protected hour. */
  protected: ProtectedRecord | null;
}

export interface PointsBreakdown {
  base: number;
  /** One point per whole day the taken flag had flown; 0 for every other outcome. */
  days: number;
}

export type RecordVisitResult =
  /** protected: the visit was logged during someone else's protected hour (#170). */
  | { status: "recorded" | "protected" | "replayed" | "already_today"; visit: VisitRecord }
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
  crew: HeldParkCrew;
}

/** The crew this account holds a park with (#170). A solo flag is a crew of 1 led by its holder. */
export interface HeldParkCrew {
  size: number;
  /** True for the planter or taker, false for a member who joined. */
  leader: boolean;
  /** The end of the protected hour while it lasts, else null. */
  protectedUntil: string | null;
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
  /**
   * Parks with a logged visit today and no flag action (#170). A logged visit does not use up
   * the day's flag action, so these are not in visitedToday.
   */
  loggedToday: string[];
}

export interface FlagRecord {
  parkId: string;
  handle: string;
  flagSeed: string;
  since: string;
  crew: FlagCrew;
}

/** A flag's crew for map pins (#170). The leader is the flag's own handle and seed. */
export interface FlagCrew {
  /** Everyone holding the flag, leader included. */
  size: number;
  /** Up to 3 members after the leader, earliest first. */
  memberSeeds: string[];
  protectedUntil: string | null;
}

export interface CrewMemberRecord {
  handle: string;
  flagSeed: string;
  joinedAt: string;
  leader: boolean;
}

/** A crew as one account sees it (#170). The code is only there for members during the hour. */
export interface CrewRecord {
  parkId: string;
  leader: { handle: string; flagSeed: string };
  /** Leader first, then by joinedAt. */
  members: CrewMemberRecord[];
  size: number;
  cap: number;
  flagSince: string;
  protectedUntil: string | null;
  /** True when the reading account is in this crew. */
  member: boolean;
  code: string | null;
  codeExpiresAt: string | null;
}

export type JoinCrewFailure = "code_not_found" | "code_expired" | "crew_full" | "already_today" | "handle_required"
  | "account_unavailable" | "conflict" | "park_not_found";

export type JoinCrewResult =
  | { status: "joined" | "replayed"; visit: VisitRecord; crew: CrewRecord }
  | { status: "already_member"; crew: CrewRecord }
  | { status: JoinCrewFailure };

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
  /** Joins the crew of the protected hour that has this code (#170). */
  joinCrew(accountId: string, code: string, visitId: string, now: string): Promise<JoinCrewResult>;
  /** The crew of the flag up at a park, as this account sees it, or null when no flag is up. */
  parkCrew(parkId: string, accountId: string, now: string): Promise<CrewRecord | null>;
  /** Every founded park. Empty where founders_001_init.sql has not run. */
  founders?(): Promise<FounderRecord[]>;
  /** The founder bonus included in the account's score. */
  founderPoints?(accountId: string, now: string): Promise<number>;
  /** Pending review requests and unseen decisions. Empty where founders_002_reviews.sql has not run. */
  foundingReviews?(accountId: string): Promise<FoundingReviewRecord[]>;
}

export const TAKEOVER_LIMIT = 50;
const VISIT_OUTCOMES = new Set(["planted", "took", "held", "joined", "logged", "already_today"]);
const JOIN_FAILURES = new Set<string>(["code_not_found", "code_expired", "crew_full", "already_today", "handle_required", "account_unavailable", "conflict"]);

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/** A text[] column, as an array or in PostgreSQL's `{a,b}` text form. Flag seeds never need quoting. */
function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    return value.length > 2 ? value.slice(1, -1).split(",") : [];
  }
  return [];
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
    // game_001's and game_002's visit_json have no protected hour; they only run while a deploy replays them.
    protected: protectedFromJson(visit.protected),
  };
}

function protectedFromJson(value: unknown): ProtectedRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const leader = row.leader as Record<string, unknown>;
  return {
    until: iso(row.until),
    leader: { handle: String(leader.handle), flagSeed: String(leader.flagSeed) },
    crewSize: Number(row.crewSize),
  };
}

export function crewFromJson(value: unknown): CrewRecord {
  const crew = value as Record<string, unknown>;
  const leader = crew.leader as Record<string, unknown>;
  const members = Array.isArray(crew.members) ? crew.members as Array<Record<string, unknown>> : [];
  return {
    parkId: String(crew.parkId),
    leader: { handle: String(leader.handle), flagSeed: String(leader.flagSeed) },
    members: members.map((member) => ({
      handle: String(member.handle), flagSeed: String(member.flagSeed), joinedAt: iso(member.joinedAt), leader: member.leader === true,
    })),
    size: Number(crew.size),
    cap: Number(crew.cap),
    flagSince: iso(crew.flagSince),
    protectedUntil: nullableIso(crew.protectedUntil),
    member: crew.member === true,
    code: typeof crew.code === "string" ? crew.code : null,
    codeExpiresAt: nullableIso(crew.codeExpiresAt),
  };
}

// Undefined table or function: a database without founders_001_init.sql.
function missingFounders(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "42P01" || code === "42883" || code === "3F000";
}

// Booleans arrive as true over the Neon driver and as "t" through some adapters.
function truthy(value: unknown): boolean {
  return value === true || value === "t";
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
      if (body.status === "recorded" || body.status === "protected" || body.status === "replayed" || body.status === "already_today") {
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
            kip_game.holding_points(h.held_from, h.last_visit_at, h.ended_at, $2::timestamptz) AS hours,
            kip_game.crew_size(h.tenure_id) AS crew_size, t.holder_account_id = h.account_id AS leader,
            CASE WHEN $2::timestamptz < kip_game.protected_until(h.flag_since) THEN kip_game.protected_until(h.flag_since) END AS protected_until
          FROM kip_game.holdings($2::timestamptz) h
          JOIN kip_game.tenures t ON t.tenure_id = h.tenure_id
          WHERE h.account_id = $1::uuid AND kip_game.flag_up(h.last_visit_at, h.ended_at, $2::timestamptz)
          ORDER BY h.flag_since ASC, h.park_id ASC`, [accountId, now]),
        // Flags this account held, as leader or crew member (#170), that someone took.
        rows(`
          SELECT t.park_id, t.ended_at, taker.handle, taker.flag_seed
          FROM kip_game.players me
          JOIN (
            SELECT tenure_id FROM kip_game.tenures WHERE holder_account_id = $1::uuid AND end_reason = 'taken'
            UNION
            SELECT tenure_id FROM kip_game.crew_members WHERE account_id = $1::uuid
          ) mine ON true
          JOIN kip_game.tenures t ON t.tenure_id = mine.tenure_id AND t.end_reason = 'taken'
          JOIN kip_game.players taker ON taker.account_id = t.ended_by_account_id
          WHERE me.account_id = $1::uuid AND t.ended_at > coalesce(me.takeovers_seen_at, me.created_at)
            AND t.ended_at <= $2::timestamptz
          ORDER BY t.ended_at DESC, t.park_id ASC
          LIMIT ${TAKEOVER_LIMIT}`, [accountId, now]),
        // A logged visit (#170) does not use up the day's flag action, so it is listed apart.
        rows(`
          SELECT park_id, bool_or(outcome <> 'logged') AS flag_action FROM kip_game.visits
          WHERE account_id = $1::uuid AND source = 'visit'
            AND local_day = kip_game.local_day($2::timestamptz) AND visited_at <= $2::timestamptz
          GROUP BY park_id
          ORDER BY park_id`, [accountId, now]),
        rows("SELECT ((kip_game.local_day($1::timestamptz) + 1)::timestamp AT TIME ZONE 'America/Vancouver') AS until", [now]),
      ]);
      return {
        score: Number(score[0]?.score ?? 0),
        parks: parks.map((row) => ({
          parkId: String(row.park_id), since: iso(row.flag_since), days: Number(row.days), hours: Number(row.hours),
          crew: { size: Number(row.crew_size), leader: truthy(row.leader), protectedUntil: nullableIso(row.protected_until) },
        })),
        takeovers: takeovers.map((row) => ({
          parkId: String(row.park_id), byHandle: String(row.handle), byFlagSeed: String(row.flag_seed), at: iso(row.ended_at),
        })),
        visitedToday: visitedToday.filter((row) => truthy(row.flag_action)).map((row) => String(row.park_id)),
        visitedTodayUntil: iso(dayEnd[0]?.until),
        loggedToday: visitedToday.filter((row) => !truthy(row.flag_action)).map((row) => String(row.park_id)),
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
      const found = await rows(`
        SELECT f.park_id, f.handle, f.flag_seed, f.since, c.crew_size, c.member_seeds, c.protected_until
        FROM kip_game.flags_up($1::timestamptz) f
        LEFT JOIN kip_game.flag_crews($1::timestamptz) c ON c.park_id = f.park_id
        ORDER BY f.park_id`, [now]);
      return found.map((row) => ({
        parkId: String(row.park_id), handle: String(row.handle), flagSeed: String(row.flag_seed), since: iso(row.since),
        crew: {
          size: row.crew_size === null || row.crew_size === undefined ? 1 : Number(row.crew_size),
          memberSeeds: textArray(row.member_seeds),
          protectedUntil: nullableIso(row.protected_until),
        },
      }));
    },

    async joinCrew(accountId, code, visitId, now) {
      // A hidden park takes no new joins, like visits; a replay of a stored join still answers.
      const target = await rows(`
        SELECT t.park_id FROM kip_game.crew_codes c JOIN kip_game.tenures t ON t.tenure_id = c.tenure_id
        WHERE c.code = $1 ORDER BY c.released ASC, c.expires_at DESC LIMIT 1`, [code]);
      if (target[0] && await isParkHidden(sql, String(target[0].park_id))) {
        const stored = await rows("SELECT 1 FROM kip_game.visits WHERE account_id = $1::uuid AND visit_id = $2::uuid", [accountId, visitId]);
        if (!stored.length) return { status: "park_not_found" };
      }
      const result = await rows("SELECT kip_game.join_crew($1::uuid, $2, $3::uuid, $4::timestamptz) AS result", [accountId, code, visitId, now]);
      const body = jsonValue(result[0]?.result) as { status: string; visit?: unknown; crew?: unknown };
      if (body.status === "joined" || body.status === "replayed") {
        return { status: body.status, visit: visitFromJson(body.visit), crew: crewFromJson(body.crew) };
      }
      if (body.status === "already_member") return { status: body.status, crew: crewFromJson(body.crew) };
      if (JOIN_FAILURES.has(body.status)) return { status: body.status as JoinCrewFailure };
      throw new Error("unexpected join_crew status");
    },

    async parkCrew(parkId, accountId, now) {
      const found = await rows("SELECT kip_game.park_crew($1, $2::uuid, $3::timestamptz) AS crew", [parkId, accountId, now]);
      const crew = jsonValue(found[0]?.crew);
      return crew ? crewFromJson(crew) : null;
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
