import { fetchAccountApi, fetchAuthenticated } from "../accounts/authClient";

/**
 * Client for the flag game routes (`/api/game/*`, contract in issue #76).
 * V1 is online only: nothing here is cached on the device, and every call either
 * returns the server's answer or throws.
 */

export type GamePlayer = { handle: string; flagSeed: string };
/** `days` is the flag's age for weathering; `hours` is this player's holding points on it (additive, #169). */
export type HeldPark = { parkId: string; since: string; days: number; hours: number };
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
  /** Manual reviews of founding photos: those waiting, and unseen decisions (additive, #153). */
  foundingReviews?: FoundingReviews;
};

export type VisitOutcome = "planted" | "took" | "held" | "already_today";
/** pointsEarned in parts: the outcome's base points and a take's day bonus (additive, #169). */
export type PointsBreakdown = { base: number; days: number };
export type VisitResult = {
  visitId: string;
  parkId: string;
  outcome: VisitOutcome;
  pointsEarned: number;
  pointsBreakdown: PointsBreakdown;
  previousHolder: GamePlayer | null;
  flagSince: string | null;
};

export type ParkFlag = { parkId: string; handle: string; flagSeed: string; since: string };
/** A founded park and its cover photo, sent with the flags (additive to the #76 contract, #126). */
export type ParkFounder = { parkId: string; handle: string | null; coverUrl: string | null };
export type FlagsResponse = { flags: ParkFlag[]; founders: ParkFounder[]; serverTime: string };
export type LeaderboardRow = { rank: number; handle: string; flagSeed: string; score: number; parksHeld: number };
export type LeaderboardResponse = { players: LeaderboardRow[]; serverTime: string };

export type GameErrorCode = "handle_taken" | "handle_rejected" | "handle_required" | "invalid_handle" | "park_not_found" | "visit_id_reused" | "invalid_request" | "unauthenticated" | "unavailable" | "offline";

const KNOWN_CODES = new Set<GameErrorCode>(["handle_taken", "handle_rejected", "handle_required", "invalid_handle", "park_not_found", "visit_id_reused", "invalid_request", "unauthenticated", "unavailable", "offline"]);
const OUTCOMES = new Set<VisitOutcome>(["planted", "took", "held", "already_today"]);
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
      return { parkId, since, days, hours: typeof park.hours === "number" ? count(park.hours) : days * 24 };
    }),
    takeovers: list(row.takeovers, (takeover) => {
      const parkId = text(takeover.parkId);
      const byHandle = text(takeover.byHandle);
      const byFlagSeed = text(takeover.byFlagSeed);
      const at = text(takeover.at);
      return parkId && byHandle && byFlagSeed && at ? { parkId, byHandle, byFlagSeed, at } : null;
    }),
    flagSeed: text(row.flagSeed) ?? parsePlayer(row.player)?.flagSeed ?? null,
    visitedToday: Array.isArray(row.visitedToday) ? row.visitedToday.filter((id): id is string => typeof id === "string" && id.length > 0) : [],
    visitedTodayUntil: instant(row.visitedTodayUntil),
    foundingReviews: parseFoundingReviews(row.foundingReviews),
  };
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
  };
}

export function parseFlags(body: unknown): FlagsResponse {
  const row = record(body) ?? {};
  return {
    flags: list(row.flags, (flag) => {
      const parkId = text(flag.parkId);
      const handle = text(flag.handle);
      const flagSeed = text(flag.flagSeed);
      const since = text(flag.since);
      return parkId && handle && flagSeed && since ? { parkId, handle, flagSeed, since } : null;
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
      return handle && flagSeed ? { rank: count(player.rank), handle, flagSeed, score: count(player.score), parksHeld: count(player.parksHeld) } : null;
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
  unauthenticated: "Sign in again to keep playing.",
  unavailable: "Parkdex is unavailable right now. Try again shortly.",
  offline: "You need a connection for this.",
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

export async function markTakeoversSeen(accountId: string, at: string): Promise<void> {
  await request(authenticated(accountId), "/api/game/takeovers/seen", { method: "POST", body: JSON.stringify({ at }) });
}

export async function fetchFlags(): Promise<FlagsResponse> {
  return parseFlags(await request(anyone, "/api/game/flags"));
}

export async function fetchGameLeaderboard(): Promise<LeaderboardResponse> {
  return parseLeaderboard(await request(anyone, "/api/game/leaderboard"));
}
