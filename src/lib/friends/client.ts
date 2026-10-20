import { fetchAuthenticated } from "../accounts/authClient";

/**
 * Client for the friends routes (`/api/friends`, #64). Every call needs a signed-in player with
 * a handle. Adds that cannot be sent now wait in the outbox (`outbox.ts`).
 */

export type FriendSummary = { handle: string; flagSeed: string };
export type FriendRow = { rank: number; handle: string; flagSeed: string; uniqueParks: number; isMe: boolean };
/** The game week: Monday to Sunday in Victoria, as YYYY-MM-DD, and when the next one starts. */
export type FriendWeek = { start: string; end: string; resetsAt: string };
export type FriendsBoard = { code: string; week: FriendWeek; players: FriendRow[]; serverTime: string };
export type AddFriendStatus = "added" | "already_friends";
export type AddFriendResponse = { status: AddFriendStatus; friend: FriendSummary };

export type FriendsErrorCode =
  | "friend_code_not_found"
  | "own_friend_code"
  | "too_many_friends"
  | "invalid_friend_code"
  | "friend_not_found"
  | "crewmate_not_found"
  | "own_handle"
  | "handle_required"
  | "account_deleting"
  | "invalid_request"
  | "unauthenticated"
  | "unavailable"
  | "offline";

const KNOWN_CODES = new Set<FriendsErrorCode>([
  "friend_code_not_found",
  "own_friend_code",
  "too_many_friends",
  "invalid_friend_code",
  "friend_not_found",
  "crewmate_not_found",
  "own_handle",
  "handle_required",
  "account_deleting",
  "invalid_request",
  "unauthenticated",
  "unavailable",
  "offline",
]);

/** Errors that will not change by trying again later, so a queued add is dropped. */
const FINAL_ADD_ERRORS = new Set<FriendsErrorCode>([
  "friend_code_not_found",
  "own_friend_code",
  "too_many_friends",
  "invalid_friend_code",
  "invalid_request",
  "account_deleting",
]);

const MESSAGES: Record<FriendsErrorCode, string> = {
  friend_code_not_found: "No one has that friend code. Check it and try again.",
  own_friend_code: "That's your own friend code.",
  too_many_friends: "You or your friend already have 200 friends.",
  invalid_friend_code: "Friend codes are 8 letters and numbers.",
  friend_not_found: "You aren't friends with that player anymore.",
  crewmate_not_found: "You haven't been in a crew with that player.",
  own_handle: "That's your own handle.",
  handle_required: "Pick a handle before you add friends.",
  account_deleting: "This account is being deleted.",
  invalid_request: "Parkdex couldn't use that request.",
  unauthenticated: "Sign in again to see your friends.",
  unavailable: "Friends are unavailable right now. Try again shortly.",
  offline: "You need a connection for this.",
};

const REQUEST_TIMEOUT_MS = 10_000;

export class FriendsError extends Error {
  constructor(
    readonly code: FriendsErrorCode,
    readonly status: number,
    message: string = MESSAGES[code],
  ) {
    super(message);
    this.name = "FriendsError";
  }
}

export function friendsErrorMessage(error: unknown): string {
  return error instanceof FriendsError ? error.message : MESSAGES.unavailable;
}

export function isFinalAddError(error: unknown): boolean {
  return error instanceof FriendsError && FINAL_ADD_ERRORS.has(error.code);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseFriend(value: unknown): FriendSummary | null {
  const row = record(value);
  const handle = text(row?.handle);
  const flagSeed = text(row?.flagSeed);
  return handle && flagSeed ? { handle, flagSeed } : null;
}

export function parseBoard(body: unknown): FriendsBoard {
  const row = record(body) ?? {};
  const week = record(row.week) ?? {};
  const code = text(row.code);
  const start = text(week.start);
  const end = text(week.end);
  const resetsAt = text(week.resetsAt);
  if (!code || !start || !DAY.test(start) || !end || !DAY.test(end) || !resetsAt || !Number.isFinite(Date.parse(resetsAt))) {
    throw new FriendsError("unavailable", 200, "Parkdex sent an answer this version cannot read.");
  }
  const players = Array.isArray(row.players)
    ? row.players.flatMap((item) => {
        const player = record(item);
        const friend = parseFriend(player);
        return player && friend ? [{ ...friend, rank: count(player.rank), uniqueParks: count(player.uniqueParks), isMe: player.isMe === true }] : [];
      })
    : [];
  return { code, week: { start, end, resetsAt }, players, serverTime: text(row.serverTime) ?? new Date().toISOString() };
}

export function parseAddFriend(body: unknown): AddFriendResponse {
  const row = record(body);
  const friend = parseFriend(row?.friend);
  const status = row?.status;
  if (!friend || (status !== "added" && status !== "already_friends")) {
    throw new FriendsError("unavailable", 200, "Parkdex sent an answer this version cannot read.");
  }
  return { status, friend };
}

function errorCode(status: number, body: Record<string, unknown>): FriendsErrorCode {
  for (const value of [body.code, record(body.error)?.code]) {
    if (typeof value === "string" && KNOWN_CODES.has(value as FriendsErrorCode)) return value as FriendsErrorCode;
  }
  if (status === 401 || status === 403) return "unauthenticated";
  if (status === 400 || status === 422) return "invalid_request";
  return "unavailable";
}

async function request(accountId: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchAuthenticated(path, { ...init, headers, signal: controller.signal }, accountId);
  } catch (error) {
    // fetch rejects with a TypeError (or an abort on timeout) when no HTTP answer came back.
    if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) throw new FriendsError("offline", 0);
    throw new FriendsError("unavailable", 0);
  } finally {
    clearTimeout(timeout);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* Empty or non-JSON answer. */
  }
  if (!response.ok) throw new FriendsError(errorCode(response.status, record(body) ?? {}), response.status);
  return body;
}

export async function fetchFriendsBoard(accountId: string): Promise<FriendsBoard> {
  return parseBoard(await request(accountId, "/api/friends"));
}

export async function sendFriendCode(accountId: string, code: string): Promise<AddFriendResponse> {
  return parseAddFriend(await request(accountId, "/api/friends", { method: "POST", body: JSON.stringify({ code }) }));
}

/** Adds a player who was in a crew with this one, by handle (`POST /api/friends/crewmate`). */
export async function sendCrewmate(accountId: string, handle: string): Promise<AddFriendResponse> {
  return parseAddFriend(await request(accountId, "/api/friends/crewmate", { method: "POST", body: JSON.stringify({ handle }) }));
}

export async function removeFriend(accountId: string, handle: string): Promise<void> {
  await request(accountId, `/api/friends/${encodeURIComponent(handle)}`, { method: "DELETE" });
}

export async function resetFriendCode(accountId: string): Promise<string> {
  const code = text(record(await request(accountId, "/api/friends/code", { method: "POST" }))?.code);
  if (!code) throw new FriendsError("unavailable", 200, "Parkdex sent an answer this version cannot read.");
  return code;
}
