import { AuthHttpError, fetchAuthenticated } from "../accounts/authClient";

/**
 * Friends and the weekly friends leaderboard. The server owns the truth; the phone keeps the
 * last answer so the screen still shows offline, and queues friend codes scanned without signal.
 */

export type SocialProfile = { displayName: string | null; friendCode: string };
export type LeaderboardRow = {
  accountId: string;
  displayName: string;
  parksThisWeek: number;
  totalParks: number;
  isMe: boolean;
};
export type Leaderboard = { weekStart: string; rows: LeaderboardRow[] };
export type SocialCache = { profile: SocialProfile | null; board: Leaderboard | null; fetchedAt: string | null };

// Matches worker/social.ts: no 0/O or 1/I/L, so codes survive being read aloud.
const FRIEND_CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
export const FRIEND_LINK_BASE = "https://parkdex.app/friend/";

export function friendLink(code: string): string {
  return FRIEND_LINK_BASE + code;
}

/** Accepts a bare code or the QR link, in any case, with spaces or dashes. */
export function parseFriendCode(value: string): string | null {
  if (value.length > 200) return null;
  const tail = value.trim().split("/").filter(Boolean).pop() ?? "";
  const code = tail.replace(/[\s-]/g, "").toUpperCase();
  return FRIEND_CODE.test(code) ? code : null;
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

export function readPendingCodes(accountId: string): string[] {
  try {
    const parsed = JSON.parse(storage()?.getItem(pendingKey(accountId)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((code): code is string => typeof code === "string" && FRIEND_CODE.test(code)) : [];
  } catch {
    return [];
  }
}

function writePendingCodes(accountId: string, codes: string[]): void {
  try { storage()?.setItem(pendingKey(accountId), JSON.stringify([...new Set(codes)])); } catch { /* Best effort. */ }
}

export function queueFriendCode(accountId: string, code: string): void {
  writePendingCodes(accountId, [...readPendingCodes(accountId), code]);
}

export function dropPendingCode(accountId: string, code: string): void {
  writePendingCodes(accountId, readPendingCodes(accountId).filter((pending) => pending !== code));
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

export type FlushResult = { added: LeaderboardRow[]; rejected: { code: string; message: string }[] };

/** Sends friend codes scanned offline. Codes the server rejects are dropped and reported. */
export async function flushPendingCodes(accountId: string): Promise<FlushResult> {
  const result: FlushResult = { added: [], rejected: [] };
  for (const code of readPendingCodes(accountId)) {
    try {
      result.added.push(await addFriend(accountId, code));
      dropPendingCode(accountId, code);
    } catch (error) {
      if (!isPermanentFriendError(error)) break;
      dropPendingCode(accountId, code);
      result.rejected.push({ code, message: error instanceof Error ? error.message : "That code didn't work." });
    }
  }
  return result;
}
