import { database } from "./db.js";

/** One row of the weekly friends board: the player or one of their friends. */
export interface FriendWeekRow {
  rank: number;
  handle: string;
  flagSeed: string;
  /** Distinct parks visited this game week (Monday to Sunday, America/Vancouver). */
  uniqueParks: number;
  isMe: boolean;
}

export interface FriendWeek {
  /** First and last local day of the week, as YYYY-MM-DD. */
  start: string;
  end: string;
  /** The instant the next week starts (Monday midnight in Victoria). */
  resetsAt: string;
}

export type FriendSummary = { handle: string; flagSeed: string };

export type AddFriendResult =
  | { status: "added" | "already_friends"; friend: FriendSummary }
  | { status: "own_code" | "code_not_found" | "handle_required" | "account_unavailable" | "too_many_friends" };

export interface FriendsStore {
  /** The player's friend code, created on first use. Null without an active account and a handle. */
  friendCode(accountId: string): Promise<string | null>;
  /** Replaces the player's code. Null without an active account and a handle. */
  resetFriendCode(accountId: string): Promise<string | null>;
  addFriend(accountId: string, code: string, limit: number): Promise<AddFriendResult>;
  /** True when a friendship ended. */
  removeFriend(accountId: string, handle: string): Promise<boolean>;
  week(accountId: string, now: string): Promise<{ week: FriendWeek; players: FriendWeekRow[] }>;
}

const ADD_STATUSES = new Set(["added", "already_friends", "own_code", "code_not_found", "handle_required", "account_unavailable", "too_many_friends"]);

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function addResultFromJson(value: unknown): AddFriendResult {
  const body = jsonValue(value) as { status?: unknown; friend?: { handle?: unknown; flagSeed?: unknown } };
  const status = String(body?.status);
  if (!ADD_STATUSES.has(status)) throw new Error("unexpected add_friend status");
  if (status === "added" || status === "already_friends") {
    return { status, friend: { handle: String(body.friend?.handle), flagSeed: String(body.friend?.flagSeed) } };
  }
  return { status: status as Exclude<AddFriendResult["status"], "added" | "already_friends"> };
}

export function createNeonFriendsStore(databaseUrl: string): FriendsStore {
  const sql = database(databaseUrl);
  const rows = async (text: string, params: unknown[]) => await sql.query(text, params) as Array<Record<string, unknown>>;
  const code = (row: Record<string, unknown> | undefined) => row?.code === null || row?.code === undefined ? null : String(row.code);

  return {
    async friendCode(accountId) {
      return code((await rows("SELECT kip_social.ensure_friend_code($1::uuid) AS code", [accountId]))[0]);
    },

    async resetFriendCode(accountId) {
      return code((await rows("SELECT kip_social.reset_friend_code($1::uuid) AS code", [accountId]))[0]);
    },

    async addFriend(accountId, friendCode, limit) {
      const result = await rows("SELECT kip_social.add_friend($1::uuid, $2, $3) AS result", [accountId, friendCode, limit]);
      return addResultFromJson(result[0]?.result);
    },

    async removeFriend(accountId, handle) {
      const result = await rows("SELECT kip_social.remove_friend($1::uuid, $2) AS removed", [accountId, handle]);
      return result[0]?.removed === true || result[0]?.removed === "t";
    },

    async week(accountId, now) {
      const [bounds, players] = await Promise.all([
        // Dates as text, so no driver turns a calendar day into a local-midnight instant.
        rows(`
          SELECT to_char(kip_social.week_start($1::timestamptz), 'YYYY-MM-DD') AS start,
            to_char(kip_social.week_start($1::timestamptz) + 6, 'YYYY-MM-DD') AS end_day,
            ((kip_social.week_start($1::timestamptz) + 7)::timestamp AT TIME ZONE 'America/Vancouver') AS resets_at`, [now]),
        rows("SELECT rank, handle, flag_seed, unique_parks, is_me FROM kip_social.friends_week($1::uuid, $2::timestamptz)", [accountId, now]),
      ]);
      return {
        week: { start: String(bounds[0]?.start), end: String(bounds[0]?.end_day), resetsAt: iso(bounds[0]?.resets_at) },
        players: players.map((row) => ({
          rank: Number(row.rank),
          handle: String(row.handle),
          flagSeed: String(row.flag_seed),
          uniqueParks: Number(row.unique_parks),
          isMe: row.is_me === true || row.is_me === "t",
        })),
      };
    },
  };
}
