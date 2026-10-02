import { AuthHttpError, fetchAuthenticated } from "../accounts/authClient";

/**
 * Friends and the friends leaderboard. The server owns the truth; the phone keeps the
 * last answer so the screen still shows offline, and queues friend codes scanned without signal.
 */

export type SocialProfile = { displayName: string | null; friendCode: string };
export type LeaderboardRow = {
  accountId: string;
  displayName: string;
  parksThisMonth: number;
  totalParks: number;
  isMe: boolean;
};
export type Leaderboard = { monthStart: string; rows: LeaderboardRow[] };
export type SocialCache = { profile: SocialProfile | null; board: Leaderboard | null; fetchedAt: string | null };

// Matches worker/social.ts: no 0/O or 1/I/L, so codes survive being read aloud.
const FRIEND_CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

/** What a friend QR carries: the code, and the name to show before we're online. */
export type FriendLink = { code: string; name: string | null };

/**
 * The QR is an https link on this build's App Link host, so the phone's own camera app
 * opens Parkdex straight onto the Friends screen. The name is a hint for offline display only.
 */
export function friendLink(origin: string, code: string, name: string | null): string {
  const url = new URL(`/friend/${code}`, origin);
  if (name) url.searchParams.set("n", name.slice(0, 40));
  return url.href;
}

/** Reads a friend QR link, or a bare code, in any case, with spaces or dashes. */
export function parseFriendLink(value: string): FriendLink | null {
  if (value.length > 300) return null;
  const trimmed = value.trim();
  let path = trimmed;
  let name: string | null = null;
  if (/^https:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!/^\/friend\/[^/]+\/?$/.test(url.pathname)) return null;
      path = url.pathname;
      name = url.searchParams.get("n")?.trim().slice(0, 40) || null;
    } catch {
      return null;
    }
  }
  const tail = path.split("/").filter(Boolean).pop() ?? "";
  const code = tail.replace(/[\s-]/g, "").toUpperCase();
  return FRIEND_CODE.test(code) ? { code, name } : null;
}

export function parseFriendCode(value: string): string | null {
  return parseFriendLink(value)?.code ?? null;
}

/** Shown as ABCD-EFGH so it is easier to read out. */
export function formatFriendCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function cacheKey(accountId: string) {
  return `kip.social.v1.${accountId.toLowerCase()}`;
}

function pendingKey(accountId: string) {
  return `kip.social.pending.v1.${accountId.toLowerCase()}`;
}

export function readSocialCache(accountId: string): SocialCache {
  const empty: SocialCache = { profile: null, board: null, fetchedAt: null };
  try {
    const raw = storage()?.getItem(cacheKey(accountId));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<SocialCache>;
    return { profile: parsed.profile ?? null, board: parsed.board ?? null, fetchedAt: parsed.fetchedAt ?? null };
  } catch {
    return empty;
  }
}

export function writeSocialCache(accountId: string, cache: SocialCache): void {
  try { storage()?.setItem(cacheKey(accountId), JSON.stringify(cache)); } catch { /* The live answer still shows. */ }
}

/** Friends saved on this phone and not yet sent. Guests save under "guest" until they sign in. */
export type PendingFriend = FriendLink & { savedAt: string };
export const GUEST_OWNER = "guest";

export function readPendingFriends(owner: string): PendingFriend[] {
  try {
    const parsed = JSON.parse(storage()?.getItem(pendingKey(owner)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PendingFriend => typeof entry === "object" && entry !== null &&
      typeof (entry as PendingFriend).code === "string" && FRIEND_CODE.test((entry as PendingFriend).code))
      .map((entry) => ({ code: entry.code, name: typeof entry.name === "string" ? entry.name : null, savedAt: String(entry.savedAt ?? "") }));
  } catch {
    return [];
  }
}

function writePendingFriends(owner: string, entries: PendingFriend[]): void {
  const unique = new Map<string, PendingFriend>();
  for (const entry of entries) if (!unique.has(entry.code)) unique.set(entry.code, entry);
  try {
    if (unique.size) storage()?.setItem(pendingKey(owner), JSON.stringify([...unique.values()]));
    else storage()?.removeItem(pendingKey(owner));
  } catch { /* Best effort. */ }
}

export function saveFriend(owner: string, friend: FriendLink): void {
  writePendingFriends(owner, [...readPendingFriends(owner), { ...friend, savedAt: new Date().toISOString() }]);
}

export function dropPendingFriend(owner: string, code: string): void {
  writePendingFriends(owner, readPendingFriends(owner).filter((pending) => pending.code !== code));
}

/** Friends a guest scanned become the new account's to send once they sign in. */
export function adoptGuestFriends(accountId: string): number {
  const guest = readPendingFriends(GUEST_OWNER);
  if (!guest.length) return 0;
  writePendingFriends(accountId, [...readPendingFriends(accountId), ...guest]);
  writePendingFriends(GUEST_OWNER, []);
  return guest.length;
}

async function request<T>(accountId: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetchAuthenticated(path, { ...init, headers }, accountId);
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { /* Empty or non-JSON error. */ }
  if (!response.ok) {
    const message = typeof body.message === "string" ? body.message : "Friends are unavailable right now.";
    throw new AuthHttpError(response.status, message.slice(0, 240));
  }
  return body as T;
}

export async function fetchProfile(accountId: string): Promise<SocialProfile> {
  return (await request<{ profile: SocialProfile }>(accountId, "/api/social/me")).profile;
}

export async function saveDisplayName(accountId: string, displayName: string): Promise<SocialProfile> {
  return (await request<{ profile: SocialProfile }>(accountId, "/api/social/me", { method: "PUT", body: JSON.stringify({ displayName }) })).profile;
}

export async function rotateFriendCode(accountId: string): Promise<SocialProfile> {
  return (await request<{ profile: SocialProfile }>(accountId, "/api/social/me/code", { method: "POST", body: "{}" })).profile;
}

export async function addFriend(accountId: string, code: string): Promise<LeaderboardRow> {
  return (await request<{ friend: LeaderboardRow }>(accountId, "/api/social/friends", { method: "POST", body: JSON.stringify({ code }) })).friend;
}

export async function removeFriend(accountId: string, friendId: string): Promise<void> {
  await request(accountId, `/api/social/friends/${encodeURIComponent(friendId)}`, { method: "DELETE" });
}

export async function fetchLeaderboard(accountId: string): Promise<Leaderboard> {
  return request<Leaderboard>(accountId, "/api/social/leaderboard");
}

/** A 4xx means the code itself is wrong; anything else is worth trying again later. */
export function isPermanentFriendError(error: unknown): boolean {
  return error instanceof AuthHttpError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429;
}

export type FlushResult = { added: LeaderboardRow[]; rejected: { friend: PendingFriend; message: string }[] };

/** Sends friends saved offline or as a guest. Codes the server rejects are dropped and reported. */
export async function flushPendingFriends(accountId: string): Promise<FlushResult> {
  const result: FlushResult = { added: [], rejected: [] };
  for (const friend of readPendingFriends(accountId)) {
    try {
      result.added.push(await addFriend(accountId, friend.code));
      dropPendingFriend(accountId, friend.code);
    } catch (error) {
      if (!isPermanentFriendError(error)) break;
      dropPendingFriend(accountId, friend.code);
      result.rejected.push({ friend, message: error instanceof Error ? error.message : "That code didn't work." });
    }
  }
  return result;
}
