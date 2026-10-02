import { neon } from "@neondatabase/serverless";
import { HttpError, readJsonBody } from "./validation.js";

/** Friends and the weekly friends leaderboard. Every route needs a signed-in account. */

// No 0/O, 1/I/L: codes get read aloud and typed from a screen.
export const FRIEND_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const FRIEND_CODE_LENGTH = 8;
const FRIEND_CODE = new RegExp(`^[${FRIEND_CODE_ALPHABET}]{${FRIEND_CODE_LENGTH}}$`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_FRIENDS = 200;
const FALLBACK_NAME = "Park explorer";

export interface SocialProfile {
  accountId: string;
  displayName: string | null;
  friendCode: string;
}

export interface LeaderboardRow {
  accountId: string;
  displayName: string | null;
  parksThisWeek: number;
  totalParks: number;
  friendsSince: string | null;
}

export interface Leaderboard {
  weekStart: string;
  rows: LeaderboardRow[];
}

export type AddFriendResult =
  | { status: "added" | "existing"; friend: LeaderboardRow }
  | { status: "not_found" | "self" | "limit" };

export interface SocialStore {
  /** Returns the profile, creating it with the given code when the account has none yet. */
  ensureProfile(accountId: string, newCode: string): Promise<SocialProfile | null>;
  rotateCode(accountId: string, newCode: string): Promise<SocialProfile | null>;
  setDisplayName(accountId: string, displayName: string): Promise<void>;
  addFriendByCode(accountId: string, code: string, limit: number): Promise<AddFriendResult>;
  removeFriend(accountId: string, friendId: string): Promise<boolean>;
  /** The account and its friends, with unique parks claimed since the start of this week. */
  leaderboard(accountId: string): Promise<Leaderboard>;
}

export interface SocialHandlers {
  json(data: unknown, status?: number): Response;
  accountId: string;
  store(): SocialStore;
  /** Injected so tests can force collisions. */
  newCode?(): string;
}

export function generateFriendCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(FRIEND_CODE_LENGTH));
  // 256 is not a multiple of 31; the bias is under 1% and harmless for an invite code.
  return Array.from(bytes, (byte) => FRIEND_CODE_ALPHABET[byte % FRIEND_CODE_ALPHABET.length]).join("");
}

/** Accepts a bare code or the QR link, in any case, with spaces or dashes. */
export function parseFriendCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const tail = value.trim().split("/").filter(Boolean).pop() ?? "";
  const code = tail.replace(/[\s-]/g, "").toUpperCase();
  return FRIEND_CODE.test(code) ? code : null;
}

function displayName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_request", "Invalid display name.");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || Array.from(name).length > 40 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new HttpError(400, "invalid_request", "Names need 1 to 40 characters.");
  }
  return name;
}

function exactKeys(body: unknown, keys: string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_request", "Invalid request.");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).length !== keys.length || !keys.every((key) => Object.hasOwn(input, key))) {
    throw new HttpError(400, "invalid_request", "Invalid request.");
  }
  return input;
}

function apiRow(row: LeaderboardRow, me: string) {
  return { ...row, displayName: row.displayName ?? FALLBACK_NAME, isMe: row.accountId === me };
}

/** Codes are random; retry a few times on the rare unique collision. */
async function withFreshCode(handlers: SocialHandlers, write: (code: string) => Promise<SocialProfile | null>): Promise<SocialProfile> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const profile = await write((handlers.newCode ?? generateFriendCode)());
    if (profile) return profile;
  }
  throw new HttpError(503, "service_unavailable", "Could not make a friend code. Try again.");
}

function profileBody(profile: SocialProfile) {
  return { displayName: profile.displayName ?? null, friendCode: profile.friendCode };
}

export async function handleSocialRequest(request: Request, handlers: SocialHandlers): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/social" && !path.startsWith("/api/social/")) return null;
  const me = handlers.accountId.toLowerCase();
  const store = handlers.store();

  if (path === "/api/social/me") {
    if (request.method === "GET") {
      return handlers.json({ profile: profileBody(await withFreshCode(handlers, (code) => store.ensureProfile(me, code))) });
    }
    if (request.method === "PUT") {
      const body = exactKeys(await readJsonBody(request, 4 * 1024), ["displayName"]);
      await store.setDisplayName(me, displayName(body.displayName));
      return handlers.json({ profile: profileBody(await withFreshCode(handlers, (code) => store.ensureProfile(me, code))) });
    }
    throw new HttpError(405, "method_not_allowed", "Use GET or PUT.");
  }

  if (path === "/api/social/me/code") {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
    await withFreshCode(handlers, (code) => store.ensureProfile(me, code));
    return handlers.json({ profile: profileBody(await withFreshCode(handlers, (code) => store.rotateCode(me, code))) });
  }

  if (path === "/api/social/friends") {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
    const body = exactKeys(await readJsonBody(request, 4 * 1024), ["code"]);
    const code = parseFriendCode(body.code);
    if (!code) throw new HttpError(400, "invalid_code", "That friend code doesn't look right.");
    const result = await store.addFriendByCode(me, code, MAX_FRIENDS);
    if (result.status === "added" || result.status === "existing") {
      return handlers.json({ friend: apiRow(result.friend, me) }, result.status === "added" ? 201 : 200);
    }
    if (result.status === "self") throw new HttpError(400, "own_code", "That's your own code.");
    if (result.status === "limit") throw new HttpError(409, "friend_limit", `You can have up to ${MAX_FRIENDS} friends.`);
    throw new HttpError(404, "code_not_found", "No one has that friend code.");
  }

  const friend = /^\/api\/social\/friends\/([^/]+)$/.exec(path);
  if (friend) {
    if (request.method !== "DELETE") throw new HttpError(405, "method_not_allowed", "Use DELETE.");
    const friendId = friend[1].toLowerCase();
    if (!UUID.test(friendId)) throw new HttpError(404, "not_found", "Friend not found.");
    if (!await store.removeFriend(me, friendId)) throw new HttpError(404, "not_found", "Friend not found.");
    return handlers.json({ removed: friendId });
  }

  if (path === "/api/social/leaderboard") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    const board = await store.leaderboard(me);
    const rows = [...board.rows].sort((a, b) => b.parksThisWeek - a.parksThisWeek || b.totalParks - a.totalParks ||
      (a.displayName ?? FALLBACK_NAME).localeCompare(b.displayName ?? FALLBACK_NAME));
    return handlers.json({ weekStart: board.weekStart, rows: rows.map((row) => apiRow(row, me)) });
  }

  throw new HttpError(404, "not_found", "Social API route not found.");
}

function text(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowFrom(row: Record<string, unknown>): LeaderboardRow {
  return {
    accountId: text(row.account_id).toLowerCase(),
    displayName: row.display_name === null || row.display_name === undefined ? null : text(row.display_name),
    parksThisWeek: Number(row.parks_this_week ?? 0),
    totalParks: Number(row.total_parks ?? 0),
    friendsSince: row.friends_since === null || row.friends_since === undefined ? null : text(row.friends_since),
  };
}

// Weeks start Monday at midnight Pacific, where the parks are.
const WEEK_START = "(date_trunc('week', now() AT TIME ZONE 'America/Vancouver') AT TIME ZONE 'America/Vancouver')";

export function createNeonSocialStore(databaseUrl: string): SocialStore {
  const sql = neon(databaseUrl);

  async function profile(accountId: string): Promise<SocialProfile | null> {
    const rows = await sql.query(`
      SELECT p.account_id, p.friend_code, a.display_name
      FROM kip_social.profiles p JOIN kip_account.accounts a ON a.id = p.account_id
      WHERE p.account_id = $1::uuid`, [accountId]);
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? { accountId, friendCode: text(row.friend_code), displayName: row.display_name === null ? null : text(row.display_name) } : null;
  }

  async function boardRows(accountIds: string[], friendsOf: string): Promise<LeaderboardRow[]> {
    const rows = await sql.query(`
      SELECT a.id AS account_id, a.display_name,
        COUNT(DISTINCT c.park_id) FILTER (WHERE c.claimed_at >= ${WEEK_START}) AS parks_this_week,
        COUNT(DISTINCT c.park_id) AS total_parks,
        f.created_at AS friends_since
      FROM kip_account.accounts a
      LEFT JOIN kip_account.claims c ON c.account_id = a.id
      LEFT JOIN kip_social.friendships f
        ON f.account_low = LEAST(a.id, $2::uuid) AND f.account_high = GREATEST(a.id, $2::uuid)
      WHERE a.id = ANY($1::uuid[]) AND a.deletion_state = 'active'
      GROUP BY a.id, a.display_name, f.created_at`, [accountIds, friendsOf]);
    return rows.map((row) => rowFrom(row as Record<string, unknown>));
  }

  return {
    async ensureProfile(accountId, newCode) {
      await sql.query(`
        INSERT INTO kip_social.profiles (account_id, friend_code)
        SELECT a.id, $2 FROM kip_account.accounts a WHERE a.id = $1::uuid AND a.deletion_state = 'active'
        ON CONFLICT DO NOTHING`, [accountId, newCode]);
      // DO NOTHING covers both an existing profile and a code collision; a missing row means collision.
      return profile(accountId);
    },

    async rotateCode(accountId, newCode) {
      const rows = await sql.query(`
        UPDATE kip_social.profiles SET friend_code = $2, updated_at = now()
        WHERE account_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM kip_social.profiles WHERE friend_code = $2)
        RETURNING account_id`, [accountId, newCode]);
      return rows.length ? profile(accountId) : null;
    },

    async setDisplayName(accountId, name) {
      await sql.query(`UPDATE kip_account.accounts SET display_name = $2, updated_at = now() WHERE id = $1::uuid`, [accountId, name]);
    },

    async addFriendByCode(accountId, code, limit) {
      const target = await sql.query(`
        SELECT p.account_id FROM kip_social.profiles p JOIN kip_account.accounts a ON a.id = p.account_id
        WHERE p.friend_code = $1 AND a.deletion_state = 'active'`, [code]);
      if (!target[0]) return { status: "not_found" };
      const friendId = text((target[0] as Record<string, unknown>).account_id).toLowerCase();
      if (friendId === accountId) return { status: "self" };
      const inserted = await sql.query(`
        WITH counts AS (
          SELECT COUNT(*) AS n FROM kip_social.friendships
          WHERE account_low = $1::uuid OR account_high = $1::uuid
        )
        INSERT INTO kip_social.friendships (account_low, account_high)
        SELECT LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid) FROM counts WHERE counts.n < $3
        ON CONFLICT DO NOTHING
        RETURNING created_at`, [accountId, friendId, limit]);
      const [friend] = await boardRows([friendId], accountId);
      if (!friend) return { status: "not_found" };
      if (inserted.length) return { status: "added", friend };
      return friend.friendsSince ? { status: "existing", friend } : { status: "limit" };
    },

    async removeFriend(accountId, friendId) {
      const rows = await sql.query(`
        DELETE FROM kip_social.friendships
        WHERE account_low = LEAST($1::uuid, $2::uuid) AND account_high = GREATEST($1::uuid, $2::uuid)
        RETURNING account_low`, [accountId, friendId]);
      return rows.length > 0;
    },

    async leaderboard(accountId) {
      const friends = await sql.query(`
        SELECT CASE WHEN account_low = $1::uuid THEN account_high ELSE account_low END AS friend_id
        FROM kip_social.friendships WHERE account_low = $1::uuid OR account_high = $1::uuid`, [accountId]);
      const ids = [accountId, ...friends.map((row) => text((row as Record<string, unknown>).friend_id).toLowerCase())];
      const [week] = await sql.query(`SELECT ${WEEK_START} AS week_start`);
      return { weekStart: text((week as Record<string, unknown>).week_start), rows: await boardRows(ids, accountId) };
    },
  };
}
