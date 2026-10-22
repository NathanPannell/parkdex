import { HttpError, readJsonBody } from "./validation.js";
import { checkHandle, HANDLE_PATTERN, normalizeHandle, type HandleVerdict } from "./handles.js";
import type { ModerationEnv, ModerationFetch } from "./moderation.js";
import {
  createNeonGameStore,
  type BadgeUnlock,
  type FlagRecord,
  type FoundingReviewRecord,
  type GameStore,
  type LeaderboardRow,
  type PlayerRecord,
  type RecordVisitResult,
  type VisitRecord,
} from "./game-store.js";

/**
 * Flag game API (V1): handles, visits, flags, scores, leaderboard and takeover messages, plus
 * crews (#170): a protected hour after each plant or take, crew codes and crew joins, and badges
 * (#175): achievements unlocked by play, up to 3 of them worn as patches on the flag.
 * Visits and joins use the server clock; the client never sends a visit time.
 */

export interface GameEnv extends ModerationEnv {
  DATABASE_URL?: string;
}

export interface GameAuthContext {
  accountId: string;
}

export interface GameAuth {
  /** Resolves the signed-in account for reads, or throws the auth HttpError. */
  account(): Promise<GameAuthContext>;
  /** Resolves the signed-in account for writes (CSRF or bearer), or throws the auth HttpError. */
  mutation(): Promise<GameAuthContext>;
}

/** Named game events for the analytics piece. `flag_fell` comes with the visit that closed the fallen flag. */
export type GameEventName =
  | "flag_planted"
  | "flag_taken"
  | "flag_held"
  | "visit_already_today"
  | "flag_fell"
  | "leaderboard_viewed"
  | "takeover_message_seen"
  | "handle_set"
  // Crews (#170). Each carries the crew size.
  | "crew_joined"
  | "crew_code_shown"
  | "visit_logged_protected"
  // Badges (#175). badge_unlocked carries the badge ID; flag_patches_set the number worn.
  | "badge_unlocked"
  | "flag_patches_set";

export interface GameEvent {
  name: GameEventName;
  accountId: string | null;
  parkId?: string;
  pointsEarned?: number;
  crewSize?: number;
  badgeId?: string;
  patches?: number;
}

export interface GameDependencies {
  createStore?(env: GameEnv): GameStore;
  fetch?: ModerationFetch;
  now?(): number;
  /** Called after a successful route result. Errors are ignored so analytics cannot break play. */
  onEvent?(event: GameEvent): void | Promise<void>;
  checkHandle?(handle: string, env: GameEnv): Promise<HandleVerdict>;
  /** Origin of this API, for absolute cover photo URLs. Relative URLs without it. */
  publicOrigin?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CREW_PATH = /^\/api\/game\/parks\/([^/]+)\/crew$/;
/** Badge IDs (#175): lower-case words joined by hyphens, like the IDs in game_004_badges.sql. */
export const BADGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_FLAG_PATCHES = 3;
const MAX_BODY_BYTES = 4 * 1024;
/** Decided review requests listed until the app marks them seen. */
export const FOUNDING_DECISIONS_LIMIT = 20;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new HttpError(400, "invalid_request", "Invalid request.");
  }
  return value;
}

export function validateVisitBody(body: unknown): { visitId: string; parkId: string } {
  const value = exactKeys(body, ["visitId", "parkId"]);
  if (typeof value.visitId !== "string" || !UUID.test(value.visitId)) throw new HttpError(400, "invalid_request", "Invalid visit ID.");
  if (typeof value.parkId !== "string" || value.parkId.length > 160 || !PARK_ID.test(value.parkId)) {
    throw new HttpError(400, "invalid_request", "Invalid park ID.");
  }
  return { visitId: value.visitId.toLowerCase(), parkId: value.parkId };
}

const FLAG_SEED_PATTERN = /^[0-9a-f]{16}$/;

/**
 * `PUT /api/game/handle`: the handle, and optionally the flag the app already showed a signed-out
 * player (#onboarding). The flag is used only when the player is created; it never changes after.
 */
export function validateHandleBody(body: unknown): { handle: string; flagSeed: string | null } {
  const value = exactKeys(body, record(body) && Object.hasOwn(body, "flagSeed") ? ["handle", "flagSeed"] : ["handle"]);
  if (typeof value.handle !== "string" || value.handle.length > 64)
    throw new HttpError(400, "invalid_handle", "Handles are 3 to 20 letters, numbers or underscores.");
  const handle = normalizeHandle(value.handle);
  if (!HANDLE_PATTERN.test(handle)) throw new HttpError(400, "invalid_handle", "Handles are 3 to 20 letters, numbers or underscores.");
  if (value.flagSeed !== undefined && (typeof value.flagSeed !== "string" || !FLAG_SEED_PATTERN.test(value.flagSeed)))
    throw new HttpError(400, "invalid_request", "Invalid request.");
  return { handle, flagSeed: (value.flagSeed as string | undefined) ?? null };
}

/** `PUT /api/game/me/patches`: up to 3 different badge IDs, in the order they are sewn on. */
export function validatePatchesBody(body: unknown): string[] {
  const value = exactKeys(body, ["patches"]);
  const patches = value.patches;
  if (!Array.isArray(patches) || patches.length > MAX_FLAG_PATCHES) {
    throw new HttpError(400, "invalid_patches", "Choose up to 3 badges.");
  }
  if (!patches.every((patch): patch is string => typeof patch === "string" && patch.length <= 40 && BADGE_ID.test(patch))) {
    throw new HttpError(400, "invalid_patches", "Unknown badge.");
  }
  if (new Set(patches).size !== patches.length) throw new HttpError(400, "invalid_patches", "Each badge can be sewn on once.");
  return patches;
}

export function validateSeenBody(body: unknown, now: number): string {
  const value = exactKeys(body, ["at"]);
  if (typeof value.at !== "string" || value.at.length > 64 || !Number.isFinite(Date.parse(value.at))) {
    throw new HttpError(400, "invalid_request", "Invalid time.");
  }
  // A client clock ahead of the server must not hide takeovers that have not happened yet.
  return new Date(Math.min(Date.parse(value.at), now)).toISOString();
}

function apiPlayer(player: PlayerRecord) {
  return { handle: player.handle, flagSeed: player.flagSeed };
}

/** The visit as `POST /api/game/visits` returns it. */
export function apiVisit(visit: VisitRecord) {
  return {
    visitId: visit.visitId,
    parkId: visit.parkId,
    outcome: visit.outcome,
    pointsEarned: visit.pointsEarned,
    pointsBreakdown: visit.pointsBreakdown,
    previousHolder: visit.previousHolder,
    flagSince: visit.flagSince,
    // Additive (#170): why a visit was logged, or null.
    protected: visit.protected,
  };
}

/** Badges a request unlocked, as visit, join and founding responses list them (additive, #175). */
export function apiNewBadges(badges: BadgeUnlock[] | undefined) {
  return (badges ?? []).map((badge) => ({ id: badge.id, unlockedAt: badge.unlockedAt }));
}

/** One `badge_unlocked` event per new badge, with the park of the visit that unlocked it. */
export function badgeEvents(badges: BadgeUnlock[] | undefined, accountId: string, parkId?: string): GameEvent[] {
  return (badges ?? []).map((badge) => ({ name: "badge_unlocked", accountId, parkId, badgeId: badge.id }));
}

/** The analytics events a visit result stands for. Replays emit nothing because they changed nothing. */
export function visitEvents(result: RecordVisitResult, accountId: string): GameEvent[] {
  if (result.status !== "recorded" && result.status !== "protected" && result.status !== "already_today") return [];
  const { visit } = result;
  const events: GameEvent[] = [];
  if (visit.fell) events.push({ name: "flag_fell", accountId, parkId: visit.parkId });
  if (visit.outcome === "logged") {
    events.push({ name: "visit_logged_protected", accountId, parkId: visit.parkId, pointsEarned: visit.pointsEarned, crewSize: visit.protected?.crewSize });
    return events;
  }
  const name: GameEventName =
    visit.outcome === "planted" ? "flag_planted" : visit.outcome === "took" ? "flag_taken" : visit.outcome === "held" ? "flag_held" : "visit_already_today";
  events.push({ name, accountId, parkId: visit.parkId, pointsEarned: visit.pointsEarned });
  return events;
}

/** Same derivation as `kip_game.flag_seed`, so the app can show a flag before a handle exists. */
export async function flagSeedFor(accountId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`kip-flag:${accountId.toLowerCase()}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function emit(dependencies: GameDependencies, events: GameEvent[]): Promise<void> {
  if (!dependencies.onEvent) return;
  for (const event of events) {
    try {
      await dependencies.onEvent(event);
    } catch {
      /* Analytics never blocks play. */
    }
  }
}

function getStore(env: GameEnv, dependencies: GameDependencies): GameStore {
  if (dependencies.createStore) return dependencies.createStore(env);
  if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "The flag game is unavailable.");
  return createNeonGameStore(env.DATABASE_URL);
}

function requireMethod(request: Request, method: string): void {
  if (request.method !== method) throw new HttpError(405, "method_not_allowed", "Method not allowed.");
}

async function putHandle(request: Request, env: GameEnv, auth: GameAuth, dependencies: GameDependencies): Promise<Response> {
  const { accountId } = await auth.mutation();
  const { handle, flagSeed } = validateHandleBody(await readJsonBody(request, MAX_BODY_BYTES));
  const store = getStore(env, dependencies);
  const owner = await store.handleOwner(handle, accountId);
  if (owner === "other") throw new HttpError(409, "handle_taken", "That handle is taken.");
  if (owner === "none") {
    const verdict = await (dependencies.checkHandle?.(handle, env) ?? checkHandle(handle, env, dependencies.fetch));
    if (!verdict.allowed) throw new HttpError(422, "handle_rejected", "Choose a different handle.");
  }
  const saved = await store.setHandle(accountId, handle, flagSeed);
  if (saved.status !== "saved") {
    if (saved.status === "taken") throw new HttpError(409, "handle_taken", "That handle is taken.");
    throw new HttpError(410, "account_deleting", "This account is being deleted.");
  }
  if (owner === "none") await emit(dependencies, [{ name: "handle_set", accountId }]);
  return json({ player: apiPlayer(saved.player) });
}

async function postVisit(request: Request, env: GameEnv, auth: GameAuth, dependencies: GameDependencies, now: number): Promise<Response> {
  const { accountId } = await auth.mutation();
  const { visitId, parkId } = validateVisitBody(await readJsonBody(request, MAX_BODY_BYTES));
  const result = await getStore(env, dependencies).recordVisit(accountId, visitId, parkId, new Date(now).toISOString());
  if (!("visit" in result)) {
    if (result.status === "park_not_found") throw new HttpError(404, "park_not_found", "That park is not in the catalogue.");
    if (result.status === "handle_required") throw new HttpError(409, "handle_required", "Choose a handle before planting flags.");
    if (result.status === "account_unavailable") throw new HttpError(410, "account_deleting", "This account is being deleted.");
    throw new HttpError(409, "visit_id_reused", "This visit ID was already used for another park.");
  }
  await emit(dependencies, [...visitEvents(result, accountId), ...(result.status === "replayed" ? [] : badgeEvents(result.badges, accountId, parkId))]);
  // Additive (#175): the badges this visit unlocked. A replay lists them again.
  return json({ visit: apiVisit(result.visit), newBadges: apiNewBadges(result.badges) });
}

/**
 * Crews are retired (docs/crews.md). Installed builds that still show the crew UI get the answer
 * they already treat as final: `code_expired`, which they word as "can't take new people", with no
 * retry. Nobody joins, nothing is read or written, and existing crews keep holding their parks.
 */
function postJoinCrew(): never {
  throw new HttpError(410, "code_expired", "Crews have ended. Take the park on your own once its protected hour is over.");
}

/** No crew is shown any more, so installed builds never show a crew code to share (docs/crews.md). */
function getParkCrew(parkId: string, now: number): Response {
  if (parkId.length > 160 || !PARK_ID.test(parkId)) throw new HttpError(400, "invalid_request", "Invalid park ID.");
  return json({ parkId, crew: null, serverTime: new Date(now).toISOString() });
}

/** Pending requests and unseen decisions, as `GET /api/game/me` lists them (docs/park-founders.md). */
export function apiFoundingReviews(records: FoundingReviewRecord[], origin: string) {
  return {
    pending: records
      .filter((record) => record.status === "pending")
      .map((record) => ({
        requestId: record.requestId,
        parkId: record.parkId,
        osm: record.osm,
        parkName: record.parkName,
        createdAt: record.createdAt,
      })),
    decided: records
      .filter((record) => record.status !== "pending")
      .slice(0, FOUNDING_DECISIONS_LIMIT)
      .map((record) => ({
        requestId: record.requestId,
        status: record.status,
        parkId: record.parkId,
        parkName: record.parkName,
        reason: record.status === "rejected" ? record.reason : null,
        // The cover only while this player is still the founder, so a later operator change shows nothing stale.
        coverUrl:
          record.status === "approved" && record.founderIsPlayer && record.coverSha256
            ? `${origin}/api/parks/${record.parkId}/cover/${record.coverSha256}.jpg`
            : null,
        founderHandle: record.status === "rejected" ? null : record.founderHandle,
        decidedAt: record.decidedAt,
      })),
  };
}

async function getMe(env: GameEnv, auth: GameAuth, dependencies: GameDependencies, now: number): Promise<Response> {
  const { accountId } = await auth.account();
  const store = getStore(env, dependencies);
  const player = await store.getPlayer(accountId);
  const flagSeed = player?.flagSeed ?? (await flagSeedFor(accountId));
  if (!player) {
    return json({
      player: null,
      flagSeed,
      score: 0,
      parks: [],
      takeovers: [],
      visitedToday: [],
      visitedTodayUntil: null,
      loggedToday: [],
      founderPoints: 0,
      foundingReviews: { pending: [], decided: [] },
      badges: [],
      flagPatches: [],
      newBadges: [],
      serverTime: new Date(now).toISOString(),
    });
  }
  const serverTime = new Date(now).toISOString();
  // Every badge rule is checked again on read: holding badges unlock with time, and crew and
  // operator-approved founding badges through other people's actions.
  const newBadges = (await store.awardBadges?.(accountId, serverTime)) ?? [];
  const [summary, founderPoints, reviews, badges] = await Promise.all([
    store.summary(accountId, serverTime),
    store.founderPoints?.(accountId, serverTime) ?? Promise.resolve(0),
    store.foundingReviews?.(accountId) ?? Promise.resolve([]),
    store.badges?.(accountId, serverTime) ?? Promise.resolve({ badges: [], patches: [] }),
  ]);
  await emit(dependencies, badgeEvents(newBadges, accountId));
  // founderPoints is already part of score; the app can show it separately.
  return json({
    player: apiPlayer(player),
    flagSeed,
    ...summary,
    founderPoints,
    foundingReviews: apiFoundingReviews(reviews, dependencies.publicOrigin ?? ""),
    // Additive (#175): every badge with its progress, the badges worn on the flag, and the ones this read unlocked.
    badges: badges.badges,
    flagPatches: badges.patches,
    newBadges: apiNewBadges(newBadges),
    serverTime,
  });
}

/**
 * My Dex (#174): the parks this account has visited, with every visit day and the first and last
 * visit. A compact list the app joins with its catalogue and its own photos.
 */
async function getDex(env: GameEnv, auth: GameAuth, dependencies: GameDependencies, now: number): Promise<Response> {
  const { accountId } = await auth.account();
  const store = getStore(env, dependencies);
  if (!store.dex) throw new HttpError(503, "service_unavailable", "My Dex is unavailable.");
  const serverTime = new Date(now).toISOString();
  const parks = await store.dex(accountId, serverTime);
  return json({
    parks: parks.map((park) => ({
      parkId: park.parkId,
      visits: park.days.length,
      days: park.days,
      firstVisitAt: park.firstVisitAt,
      lastVisitAt: park.lastVisitAt,
      hidden: park.hidden,
    })),
    serverTime,
  });
}

async function putPatches(request: Request, env: GameEnv, auth: GameAuth, dependencies: GameDependencies): Promise<Response> {
  const { accountId } = await auth.mutation();
  const patches = validatePatchesBody(await readJsonBody(request, MAX_BODY_BYTES));
  const store = getStore(env, dependencies);
  if (!store.setFlagPatches) throw new HttpError(503, "service_unavailable", "Badges are unavailable.");
  const result = await store.setFlagPatches(accountId, patches);
  switch (result.status) {
    case "saved":
      await emit(dependencies, [{ name: "flag_patches_set", accountId, patches: result.patches.length }]);
      return json({ patches: result.patches });
    case "locked":
      throw new HttpError(409, "badge_locked", "You can only sew on badges you have earned.");
    case "handle_required":
      throw new HttpError(409, "handle_required", "Choose a handle first.");
    case "account_unavailable":
      throw new HttpError(410, "account_deleting", "This account is being deleted.");
    default:
      throw new HttpError(400, "invalid_patches", "Choose up to 3 different badges.");
  }
}

async function postTakeoversSeen(request: Request, env: GameEnv, auth: GameAuth, dependencies: GameDependencies, now: number): Promise<Response> {
  const { accountId } = await auth.mutation();
  const at = validateSeenBody(await readJsonBody(request, MAX_BODY_BYTES), now);
  const player = await getStore(env, dependencies).markTakeoversSeen(accountId, at);
  if (!player) throw new HttpError(409, "handle_required", "Choose a handle first.");
  await emit(dependencies, [{ name: "takeover_message_seen", accountId }]);
  return json({ takeoversSeenAt: player.takeoversSeenAt });
}

async function getFlags(env: GameEnv, dependencies: GameDependencies, now: number): Promise<Response> {
  const serverTime = new Date(now).toISOString();
  const store = getStore(env, dependencies);
  const [flags, founders] = await Promise.all([store.flags(serverTime), store.founders?.() ?? Promise.resolve([])]);
  const origin = dependencies.publicOrigin ?? "";
  return json({
    // Additive (#175): each holder's patches.
    flags: flags.map((flag: FlagRecord) => ({ ...flag, patches: flag.patches ?? [] })),
    // Founded parks with their cover photo, so the map can show covers without a request per park.
    founders: founders.map((founder) => ({
      parkId: founder.parkId,
      handle: founder.handle,
      coverUrl: `${origin}/api/parks/${founder.parkId}/cover/${founder.photoSha256}.jpg`,
    })),
    serverTime,
  });
}

async function getLeaderboard(env: GameEnv, dependencies: GameDependencies, now: number): Promise<Response> {
  const serverTime = new Date(now).toISOString();
  const players = await getStore(env, dependencies).leaderboard(serverTime);
  await emit(dependencies, [{ name: "leaderboard_viewed", accountId: null }]);
  return json({ players: players.map((row: LeaderboardRow) => ({ ...row, patches: row.patches ?? [] })), serverTime });
}

/** Routes `/api/game/*`. Returns null for other paths. Throws HttpError for the shared error format. */
export async function handleGameRequest(request: Request, env: GameEnv, auth: GameAuth, dependencies: GameDependencies = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/game" && !path.startsWith("/api/game/")) return null;
  const now = dependencies.now?.() ?? Date.now();
  const crewPath = CREW_PATH.exec(path);
  if (crewPath) {
    requireMethod(request, "GET");
    return getParkCrew(crewPath[1], now);
  }
  switch (path) {
    case "/api/game/handle":
      requireMethod(request, "PUT");
      return putHandle(request, env, auth, dependencies);
    case "/api/game/visits":
      requireMethod(request, "POST");
      return postVisit(request, env, auth, dependencies, now);
    case "/api/game/me":
      requireMethod(request, "GET");
      return getMe(env, auth, dependencies, now);
    case "/api/game/me/patches":
      requireMethod(request, "PUT");
      return putPatches(request, env, auth, dependencies);
    case "/api/game/dex":
      requireMethod(request, "GET");
      return getDex(env, auth, dependencies, now);
    case "/api/game/takeovers/seen":
      requireMethod(request, "POST");
      return postTakeoversSeen(request, env, auth, dependencies, now);
    case "/api/game/flags":
      requireMethod(request, "GET");
      return getFlags(env, dependencies, now);
    case "/api/game/leaderboard":
      requireMethod(request, "GET");
      return getLeaderboard(env, dependencies, now);
    case "/api/game/crews/join":
      requireMethod(request, "POST");
      return postJoinCrew();
    default:
      throw new HttpError(404, "not_found", "API route not found.");
  }
}
