import { HttpError, readJsonBody } from "./validation.js";
import { HANDLE_PATTERN, normalizeHandle } from "./handles.js";
import { createNeonFriendsStore, type FriendsStore } from "./friends-store.js";
import { FRIEND_CODE_LENGTH, normalizeSocialCode } from "./socialCodes.js";
import type { GameAuth } from "./game.js";

/**
 * Friends (#64): friend codes, mutual friendships and a weekly board of distinct parks visited.
 * Friends are flag game players, so every route needs a handle. The app hides all of this behind
 * the `friends` feature flag; the routes themselves are always on, like the rest of the API.
 *
 * - `GET /api/friends`: the player's code (created on first use), this week's bounds and the board
 * - `POST /api/friends` `{ code }`: add a friend. Replays answer `already_friends`, so the app can
 *   resend codes typed or scanned offline.
 * - `DELETE /api/friends/:handle`: end a friendship for both players
 * - `POST /api/friends/code`: replace the player's code; the old QR and links stop working
 */

export interface FriendsEnv {
  DATABASE_URL?: string;
}

export interface FriendsDependencies {
  createStore?(env: FriendsEnv): FriendsStore;
  now?(): number;
}

/** Most friends one player can have. */
export const FRIEND_LIMIT = 200;
const MAX_BODY_BYTES = 1024;

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

function getStore(env: FriendsEnv, dependencies: FriendsDependencies): FriendsStore {
  if (dependencies.createStore) return dependencies.createStore(env);
  if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "Friends are unavailable.");
  return createNeonFriendsStore(env.DATABASE_URL);
}

function requireMethod(request: Request, method: string): void {
  if (request.method !== method) throw new HttpError(405, "method_not_allowed", "Method not allowed.");
}

const handleRequired = () => new HttpError(409, "handle_required", "Choose a handle before adding friends.");

export function validateAddFriendBody(body: unknown): string {
  const value = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!value || Object.keys(value).length !== 1 || typeof value.code !== "string") {
    throw new HttpError(400, "invalid_request", "Invalid request.");
  }
  const code = normalizeSocialCode(value.code, FRIEND_CODE_LENGTH);
  if (!code) throw new HttpError(400, "invalid_friend_code", "Friend codes are 8 letters and numbers.");
  return code;
}

async function getFriends(env: FriendsEnv, auth: GameAuth, dependencies: FriendsDependencies, now: number): Promise<Response> {
  const { accountId } = await auth.account();
  const store = getStore(env, dependencies);
  const code = await store.friendCode(accountId);
  if (!code) throw handleRequired();
  const serverTime = new Date(now).toISOString();
  const { week, players } = await store.week(accountId, serverTime);
  return json({ code, week, players, serverTime });
}

async function postFriend(request: Request, env: FriendsEnv, auth: GameAuth, dependencies: FriendsDependencies): Promise<Response> {
  const { accountId } = await auth.mutation();
  const code = validateAddFriendBody(await readJsonBody(request, MAX_BODY_BYTES));
  const result = await getStore(env, dependencies).addFriend(accountId, code, FRIEND_LIMIT);
  switch (result.status) {
    case "added":
    case "already_friends":
      return json({ status: result.status, friend: result.friend });
    case "code_not_found":
      throw new HttpError(404, "friend_code_not_found", "No player has that friend code.");
    case "own_code":
      throw new HttpError(409, "own_friend_code", "That's your own friend code.");
    case "too_many_friends":
      throw new HttpError(409, "too_many_friends", `Players can have up to ${FRIEND_LIMIT} friends.`);
    case "handle_required":
      throw handleRequired();
    case "account_unavailable":
      throw new HttpError(410, "account_deleting", "This account is being deleted.");
  }
}

async function deleteFriend(handleSegment: string, env: FriendsEnv, auth: GameAuth, dependencies: FriendsDependencies): Promise<Response> {
  const { accountId } = await auth.mutation();
  let handle: string;
  try {
    handle = normalizeHandle(decodeURIComponent(handleSegment));
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid handle.");
  }
  if (!HANDLE_PATTERN.test(handle)) throw new HttpError(400, "invalid_request", "Invalid handle.");
  const removed = await getStore(env, dependencies).removeFriend(accountId, handle);
  if (!removed) throw new HttpError(404, "friend_not_found", "You aren't friends with that player.");
  return json({ removed: true });
}

async function postCode(env: FriendsEnv, auth: GameAuth, dependencies: FriendsDependencies): Promise<Response> {
  const { accountId } = await auth.mutation();
  const code = await getStore(env, dependencies).resetFriendCode(accountId);
  if (!code) throw handleRequired();
  return json({ code });
}

/** Routes `/api/friends` and below. Returns null for other paths. Throws HttpError for the shared error format. */
export async function handleFriendsRequest(
  request: Request,
  env: FriendsEnv,
  auth: GameAuth,
  dependencies: FriendsDependencies = {},
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/friends" && !path.startsWith("/api/friends/")) return null;
  const now = dependencies.now?.() ?? Date.now();
  if (path === "/api/friends") {
    if (request.method === "GET") return getFriends(env, auth, dependencies, now);
    requireMethod(request, "POST");
    return postFriend(request, env, auth, dependencies);
  }
  if (path === "/api/friends/code") {
    requireMethod(request, "POST");
    return postCode(env, auth, dependencies);
  }
  const friend = /^\/api\/friends\/([^/]{1,64})$/.exec(path);
  if (friend) {
    requireMethod(request, "DELETE");
    return deleteFriend(friend[1], env, auth, dependencies);
  }
  throw new HttpError(404, "not_found", "API route not found.");
}
