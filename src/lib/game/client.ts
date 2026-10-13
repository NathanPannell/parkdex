import { fetchAccountApi, fetchAuthenticated } from "../accounts/authClient";
import type { BadgeStatus } from "./badges";

/**
 * Client for the flag game routes (`/api/game/*`, contract in issue #76).
 * V1 is online only: nothing here is cached on the device, and every call either
 * returns the server's answer or throws.
 */

export type GamePlayer = { handle: string; flagSeed: string };
/** A held park's crew (#170): its size, whether this player leads it, and the protected hour's end while it lasts. */
export type HeldParkCrew = { size: number; leader: boolean; protectedUntil: string | null };
/**
 * `days` is the flag's age for weathering; `hours` is this player's holding points on it (additive, #169).
 * `crew` is additive (#170): crew members hold the park too, so this can list a park whose flag someone else leads.
 */
export type HeldPark = { parkId: string; since: string; days: number; hours: number; crew?: HeldParkCrew | null };
export type Takeover = { parkId: string; byHandle: string; byFlagSeed: string; at: string };
/** A founding photo the player sent for manual review, still waiting (#153). */
export type PendingFoundingReview = { requestId: string; parkId: string | null; parkName: string; createdAt: string };
export type FoundingDecisionStatus = "approved" | "rejected" | "superseded";
/** A manual review decision the player has not seen yet (#153). */
export type FoundingDecision = {
  requestId: string;
  status: FoundingDecisionStatus;
  parkId: string | null;
  parkName: string;
  reason: string | null;
  coverUrl: string | null;
  /** The park's current founder: the player after an approval, someone else after a superseded request. */
  founderHandle: string | null;
  decidedAt: string;
};
export type FoundingReviews = { pending: PendingFoundingReview[]; decided: FoundingDecision[] };

export type GameMe = {
  player: GamePlayer | null;
  score: number;
  parks: HeldPark[];
  takeovers: Takeover[];
  /** The account's flag seed, sent even before a handle exists (additive to the #76 contract). */
  flagSeed: string | null;
  /** Parks already visited on the current Victoria day (additive). */
  visitedToday?: string[];
  /** When that day ends, from the server, so the list expires at midnight in Victoria (additive). */
  visitedTodayUntil?: string | null;
  /**
   * Parks with only a logged visit today, during someone else's protected hour (additive, #170).
   * A logged visit leaves the day's flag action unused, so the park can still be taken after the hour.
   */
  loggedToday?: string[];
  /** Manual reviews of founding photos: those waiting, and unseen decisions (additive, #153). */
  foundingReviews?: FoundingReviews;
  /**
   * Every badge with its progress (additive, #175). Undefined from a server without badges, so
   * the app can hide them there; an empty list means the server has badges and none apply.
   */
  badges?: BadgeStatus[];
  /** Badges sewn on the player's flag, at most 3 (additive, #175). */
  flagPatches?: string[];
  /** Badges this read unlocked, such as a flag reaching 7 days (additive, #175). */
  newBadges?: BadgeUnlock[];
};

/** A badge a request unlocked (#175). */
export type BadgeUnlock = { id: string; unlockedAt: string };

/**
 * `joined` and `logged` come from crews (#170) and reach every build, whatever the `crews` flag
 * says: joining a crew, and a visit during someone else's protected hour.
 */
export type VisitOutcome = "planted" | "took" | "held" | "joined" | "logged" | "already_today";
/** pointsEarned in parts: the outcome's base points and a take's day bonus (additive, #169). */
export type PointsBreakdown = { base: number; days: number };
/** Why a visit was logged instead of taking the flag: someone else's protected hour (#170). */
export type ProtectedHour = { until: string; leader: GamePlayer | null; crewSize: number };
export type VisitResult = {
  visitId: string;
  parkId: string;
  outcome: VisitOutcome;
  pointsEarned: number;
  pointsBreakdown: PointsBreakdown;
  previousHolder: GamePlayer | null;
  flagSince: string | null;
  /** Set for a logged visit, and for already_today during someone else's protected hour (additive, #170). */
  protected: ProtectedHour | null;
  /** Badges this visit unlocked (additive, #175). */
  newBadges?: BadgeUnlock[];
};

/** A flag's crew for map pins (#170). The leader is the flag's own holder; `memberSeeds` has up to 3 more, earliest first. */
export type FlagCrew = { size: number; memberSeeds: string[]; protectedUntil: string | null };
/** `crew` (#170) and `patches`, the holder's badges drawn on their flag (#175), are additive; older servers send neither. */
export type ParkFlag = { parkId: string; handle: string; flagSeed: string; since: string; crew?: FlagCrew | null; patches?: string[] };

/** `patches` are the member's badges, drawn on their flag (additive, #175). */
export type CrewMember = { handle: string; flagSeed: string; joinedAt: string; leader: boolean; patches?: string[] };
/** A crew as the signed-in player sees it (#170). `code` is set only for members during the protected hour. */
export type Crew = {
  parkId: string;
  leader: GamePlayer;
  /** The leader first, then by when they joined. */
  members: CrewMember[];
  size: number;
  cap: number;
  flagSince: string;
  protectedUntil: string | null;
  member: boolean;
  code: string | null;
  codeExpiresAt: string | null;
};
export type ParkCrewResponse = { parkId: string; crew: Crew | null; serverTime: string };
export type JoinCrewResult =
  | { status: "joined"; visit: VisitResult; crew: Crew }
  | { status: "already_member"; visit: null; crew: Crew };
/** A founded park and its cover photo, sent with the flags (additive to the #76 contract, #126). */
export type ParkFounder = { parkId: string; handle: string | null; coverUrl: string | null };
export type FlagsResponse = { flags: ParkFlag[]; founders: ParkFounder[]; serverTime: string };
export type LeaderboardRow = { rank: number; handle: string; flagSeed: string; score: number; parksHeld: number; patches?: string[] };
export type LeaderboardResponse = { players: LeaderboardRow[]; serverTime: string };

export type GameErrorCode =
  | "handle_taken" | "handle_rejected" | "handle_required" | "invalid_handle" | "park_not_found" | "visit_id_reused" | "invalid_request"
  | "unauthenticated" | "unavailable" | "offline" | "account_deleting"
  // Badge patches (#175).
  | "badge_locked" | "invalid_patches"
  // Crew joins (#170).
  | "invalid_code" | "code_not_found" | "code_expired" | "crew_full" | "already_today";

const KNOWN_CODES = new Set<GameErrorCode>([
  "handle_taken", "handle_rejected", "handle_required", "invalid_handle", "park_not_found", "visit_id_reused", "invalid_request",
  "unauthenticated", "unavailable", "offline", "account_deleting", "invalid_code", "code_not_found", "code_expired", "crew_full", "already_today",
  "badge_locked", "invalid_patches",
]);
const OUTCOMES = new Set<VisitOutcome>(["planted", "took", "held", "joined", "logged", "already_today"]);
const DECISIONS = new Set<FoundingDecisionStatus>(["approved", "rejected", "superseded"]);
const REQUEST_TIMEOUT_MS = 10_000;

export class GameError extends Error {
  constructor(readonly code: GameErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = "GameError";
  }
}

export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;

/** What the player typed, as the server will store it: no leading @, lower case. */
export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@+/, "").toLowerCase();
}

/** A plain reason the handle cannot be sent, or null when it has the right shape. */
export function handleProblem(handle: string): string | null {
  if (handle.length < 3) return "Use at least 3 characters.";
  if (handle.length > 20) return "Use 20 characters or fewer.";
  if (!HANDLE_PATTERN.test(handle)) return "Use only letters, numbers and underscores.";
  return null;
}

export function createVisitId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID().toLowerCase();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isOfflineError(error: unknown): boolean {
  return error instanceof GameError && error.code === "offline";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function list<T>(value: unknown, parse: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    const parsed = row ? parse(row) : null;
    return parsed ? [parsed] : [];
  });
}

/** Badge and patch IDs: lower-case words joined by hyphens. */
const BADGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function badgeIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length <= 40 && BADGE_ID.test(id)))] : [];
}

export function parseBadgeUnlocks(value: unknown): BadgeUnlock[] {
  return list(value, (item) => {
    const id = text(item.id);
    const unlockedAt = instant(item.unlockedAt);
    return id && BADGE_ID.test(id) && unlockedAt ? { id, unlockedAt } : null;
  });
}

function parseBadgeStatuses(value: unknown): BadgeStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return list(value, (item) => {
    const id = text(item.id);
    if (!id || !BADGE_ID.test(id)) return null;
    const goal = Math.max(1, count(item.goal));
    return { id, progress: Math.min(count(item.progress), goal), goal, unlockedAt: instant(item.unlockedAt) };
  });
}

function parsePlayer(value: unknown): GamePlayer | null {
  const row = record(value);
  const handle = text(row?.handle);
  const flagSeed = text(row?.flagSeed);
  return handle && flagSeed ? { handle, flagSeed } : null;
}

export function parseMe(body: unknown): GameMe {
  const row = record(body) ?? {};
  return {
    player: parsePlayer(row.player),
    score: count(row.score),
    parks: list(row.parks, (park) => {
      const parkId = text(park.parkId);
      const since = text(park.since);
      if (!parkId || !since) return null;
      const days = count(park.days);
      // A server from before #169 sends no hours; a whole day is at least 24 of them.
      return { parkId, since, days, hours: typeof park.hours === "number" ? count(park.hours) : days * 24, crew: parseHeldCrew(park.crew) };
    }),
    takeovers: list(row.takeovers, (takeover) => {
      const parkId = text(takeover.parkId);
      const byHandle = text(takeover.byHandle);
      const byFlagSeed = text(takeover.byFlagSeed);
      const at = text(takeover.at);
      return parkId && byHandle && byFlagSeed && at ? { parkId, byHandle, byFlagSeed, at } : null;
    }),
    flagSeed: text(row.flagSeed) ?? parsePlayer(row.player)?.flagSeed ?? null,
    visitedToday: ids(row.visitedToday),
    visitedTodayUntil: instant(row.visitedTodayUntil),
    loggedToday: ids(row.loggedToday),
    foundingReviews: parseFoundingReviews(row.foundingReviews),
    badges: parseBadgeStatuses(row.badges),
    flagPatches: badgeIds(row.flagPatches).slice(0, 3),
    newBadges: parseBadgeUnlocks(row.newBadges),
  };
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

function parseHeldCrew(value: unknown): HeldParkCrew | null {
  const row = record(value);
  if (!row) return null;
  return { size: Math.max(1, count(row.size)), leader: row.leader !== false, protectedUntil: instant(row.protectedUntil) };
}

export function parseFoundingReviews(value: unknown): FoundingReviews {
  const row = record(value) ?? {};
  return {
    pending: list(row.pending, (item) => {
      const requestId = text(item.requestId);
      const createdAt = instant(item.createdAt);
      return requestId && createdAt ? { requestId, parkId: text(item.parkId), parkName: text(item.parkName) ?? "this park", createdAt } : null;
    }),
    decided: list(row.decided, (item) => {
      const requestId = text(item.requestId);
      const status = item.status;
      const decidedAt = instant(item.decidedAt);
      if (!requestId || !decidedAt || typeof status !== "string" || !DECISIONS.has(status as FoundingDecisionStatus)) return null;
      return {
        requestId,
        status: status as FoundingDecisionStatus,
        parkId: text(item.parkId),
        parkName: text(item.parkName) ?? "this park",
        reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim().slice(0, 200) : null,
        coverUrl: text(item.coverUrl),
        founderHandle: text(item.founderHandle),
        decidedAt,
      };
    }),
  };
}

function instant(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function parseVisit(body: unknown): VisitResult {
  const visit = record(record(body)?.visit);
  const visitId = text(visit?.visitId);
  const parkId = text(visit?.parkId);
  const outcome = visit?.outcome;
  if (!visit || !visitId || !parkId || typeof outcome !== "string" || !OUTCOMES.has(outcome as VisitOutcome)) {
    throw new GameError("unavailable", 200, "Parkdex sent an answer this version cannot read.");
  }
  const pointsEarned = count(visit.pointsEarned);
  const breakdown = record(visit.pointsBreakdown);
  return {
    visitId,
    parkId,
    outcome: outcome as VisitOutcome,
    pointsEarned,
    // A server from before #169 sends no breakdown: show the whole amount as the base.
    pointsBreakdown: breakdown ? { base: count(breakdown.base), days: count(breakdown.days) } : { base: pointsEarned, days: 0 },
    previousHolder: parsePlayer(visit.previousHolder),
    flagSince: text(visit.flagSince),
    protected: parseProtected(visit.protected),
    // Only a visit answer from a server with badges (#175) has newBadges beside the visit.
    ...(Array.isArray(record(body)?.newBadges) ? { newBadges: parseBadgeUnlocks(record(body)?.newBadges) } : {}),
  };
}

function parseProtected(value: unknown): ProtectedHour | null {
  const row = record(value);
  const until = instant(row?.until);
  if (!row || !until) return null;
  return { until, leader: parsePlayer(row.leader), crewSize: Math.max(1, count(row.crewSize)) };
}

function parseFlagCrew(value: unknown): FlagCrew | null {
  const row = record(value);
  if (!row) return null;
  const memberSeeds = Array.isArray(row.memberSeeds) ? row.memberSeeds.filter((seed): seed is string => typeof seed === "string" && seed.length > 0).slice(0, 3) : [];
  return { size: Math.max(1, count(row.size), memberSeeds.length + 1), memberSeeds, protectedUntil: instant(row.protectedUntil) };
}

export function parseCrew(value: unknown): Crew | null {
  const row = record(value);
  const parkId = text(row?.parkId);
  const leader = parsePlayer(row?.leader);
  const flagSince = instant(row?.flagSince);
  if (!row || !parkId || !leader || !flagSince) return null;
  const members = list(row.members, (member): CrewMember | null => {
    const player = parsePlayer(member);
    const joinedAt = instant(member.joinedAt);
    return player && joinedAt ? { ...player, joinedAt, leader: member.leader === true, patches: badgeIds(member.patches).slice(0, 3) } : null;
  });
  return {
    parkId,
    leader,
    members,
    size: Math.max(1, count(row.size), members.length),
    cap: count(row.cap) || 8,
    flagSince,
    protectedUntil: instant(row.protectedUntil),
    member: row.member === true,
    code: text(row.code),
    codeExpiresAt: instant(row.codeExpiresAt),
  };
}

export function parseParkCrew(body: unknown, parkId: string): ParkCrewResponse {
  const row = record(body) ?? {};
  return { parkId: text(row.parkId) ?? parkId, crew: parseCrew(row.crew), serverTime: text(row.serverTime) ?? new Date().toISOString() };
}

export function parseJoinCrew(body: unknown): JoinCrewResult {
  const row = record(body);
  const crew = parseCrew(row?.crew);
  if (row && crew && row.status === "already_member") return { status: "already_member", visit: null, crew };
  if (row && crew && row.status === "joined") {
    const visit = parseVisit(row);
    if (visit.outcome === "joined") return { status: "joined", visit, crew };
  }
  throw new GameError("unavailable", 200, "Parkdex sent an answer this version cannot read.");
}

export function parseFlags(body: unknown): FlagsResponse {
  const row = record(body) ?? {};
  return {
    flags: list(row.flags, (flag) => {
      const parkId = text(flag.parkId);
      const handle = text(flag.handle);
      const flagSeed = text(flag.flagSeed);
      const since = text(flag.since);
      return parkId && handle && flagSeed && since ? { parkId, handle, flagSeed, since, crew: parseFlagCrew(flag.crew), patches: badgeIds(flag.patches).slice(0, 3) } : null;
    }),
    founders: list(row.founders, (founder) => {
      const parkId = text(founder.parkId);
      return parkId ? { parkId, handle: text(founder.handle), coverUrl: text(founder.coverUrl) } : null;
    }),
    serverTime: text(row.serverTime) ?? new Date().toISOString(),
  };
}

export function parseLeaderboard(body: unknown): LeaderboardResponse {
  const row = record(body) ?? {};
  return {
    players: list(row.players, (player) => {
      const handle = text(player.handle);
      const flagSeed = text(player.flagSeed);
      return handle && flagSeed
        ? { rank: count(player.rank), handle, flagSeed, score: count(player.score), parksHeld: count(player.parksHeld), patches: badgeIds(player.patches).slice(0, 3) }
        : null;
    }),
    serverTime: text(row.serverTime) ?? new Date().toISOString(),
  };
}

// The contract names codes such as handle_taken; accept them under `code` or `error`.
function errorCode(status: number, body: Record<string, unknown>): GameErrorCode {
  for (const value of [body.code, body.error]) {
    if (typeof value === "string" && KNOWN_CODES.has(value as GameErrorCode)) return value as GameErrorCode;
  }
  if (status === 401 || status === 403) return "unauthenticated";
  if (status === 400 || status === 422) return "invalid_request";
  return "unavailable";
}

const MESSAGES: Record<GameErrorCode, string> = {
  handle_taken: "Someone already has that handle. Try another.",
  handle_rejected: "That handle can't be used. Try another.",
  handle_required: "Pick a handle before you plant your flag.",
  invalid_handle: "Use 3 to 20 letters, numbers or underscores.",
  park_not_found: "Parkdex doesn't know this park yet. Update the app and try again.",
  visit_id_reused: "That visit was already used for another park. Try again.",
  invalid_request: "Parkdex couldn't use that request.",
  badge_locked: "Earn that badge before you sew it on.",
  invalid_patches: "Your flag has room for 3 badges.",
  unauthenticated: "Sign in again to keep playing.",
  unavailable: "Parkdex is unavailable right now. Try again shortly.",
  offline: "You need a connection for this.",
  account_deleting: "This account is being deleted.",
  invalid_code: "Crew codes are 6 letters and numbers.",
  code_not_found: "No crew has that code. Check it and try again.",
  code_expired: "That crew's protected hour is over, so it can't take new people.",
  crew_full: "That crew is full. Crews have up to 8 people.",
  already_today: "You already had your flag turn at this park today. Come back tomorrow.",
};

export function gameErrorMessage(error: unknown): string {
  return error instanceof GameError ? error.message : MESSAGES.unavailable;
}

type Sender = (path: string, init: RequestInit) => Promise<Response>;

async function request(send: Sender, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await send(path, { ...init, headers, signal: controller.signal });
  } catch (error) {
    // fetch rejects with a TypeError (or an abort on timeout) when no HTTP answer came back.
    if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) throw new GameError("offline", 0, MESSAGES.offline);
    throw new GameError("unavailable", 0, error instanceof Error && error.message ? error.message.slice(0, 240) : MESSAGES.unavailable);
  } finally {
    clearTimeout(timeout);
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* Empty or non-JSON answer. */ }
  if (!response.ok) {
    const code = errorCode(response.status, record(body) ?? {});
    throw new GameError(code, response.status, MESSAGES[code]);
  }
  return body;
}

const authenticated = (accountId: string): Sender => (path, init) => fetchAuthenticated(path, init, accountId);
const anyone: Sender = (path, init) => fetchAccountApi(path, init);

export async function fetchGameMe(accountId: string): Promise<GameMe> {
  return parseMe(await request(authenticated(accountId), "/api/game/me"));
}

export async function saveHandle(accountId: string, handle: string): Promise<GamePlayer> {
  const body = record(await request(authenticated(accountId), "/api/game/handle", { method: "PUT", body: JSON.stringify({ handle }) }));
  const player = parsePlayer(body?.player) ?? parsePlayer(body);
  if (!player) throw new GameError("unavailable", 200, MESSAGES.unavailable);
  return player;
}

export async function sendVisit(accountId: string, visit: { visitId: string; parkId: string }): Promise<VisitResult> {
  return parseVisit(await request(authenticated(accountId), "/api/game/visits", { method: "POST", body: JSON.stringify(visit) }));
}

/** Sews up to 3 unlocked badges onto the flag (#175). Returns the patches the server saved. */
export async function savePatches(accountId: string, patches: string[]): Promise<string[]> {
  const body = record(await request(authenticated(accountId), "/api/game/me/patches", { method: "PUT", body: JSON.stringify({ patches }) }));
  return badgeIds(body?.patches).slice(0, 3);
}

/**
 * The crew at a park (#170). Members get the code, which the server records as shown, so call
 * this when the park page or the code sheet opens, never on a map refresh.
 */
export async function fetchParkCrew(accountId: string, parkId: string): Promise<ParkCrewResponse> {
  return parseParkCrew(await request(authenticated(accountId), `/api/game/parks/${encodeURIComponent(parkId)}/crew`), parkId);
}

/** Joins the crew whose code this is (#170). Resending the same visit ID returns the same answer. */
export async function joinCrew(accountId: string, join: { visitId: string; code: string }): Promise<JoinCrewResult> {
  return parseJoinCrew(await request(authenticated(accountId), "/api/game/crews/join", { method: "POST", body: JSON.stringify(join) }));
}

export async function markTakeoversSeen(accountId: string, at: string): Promise<void> {
  await request(authenticated(accountId), "/api/game/takeovers/seen", { method: "POST", body: JSON.stringify({ at }) });
}

export async function fetchFlags(): Promise<FlagsResponse> {
  return parseFlags(await request(anyone, "/api/game/flags"));
}

export async function fetchGameLeaderboard(): Promise<LeaderboardResponse> {
  return parseLeaderboard(await request(anyone, "/api/game/leaderboard"));
}
