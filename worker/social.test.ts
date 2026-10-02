import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createFeedbackWorker, type WorkerEnvironment } from "./index.ts";
import { HttpError } from "./validation.ts";
import type { AccountAuthStore, StoredSession } from "./accounts/auth-store.ts";
import {
  FRIEND_CODE_ALPHABET,
  generateFriendCode,
  handleSocialRequest,
  parseFriendCode,
  type AddFriendResult,
  type Leaderboard,
  type LeaderboardRow,
  type SocialProfile,
  type SocialStore,
} from "./social.ts";

const ME = "ae172e85-a8ab-4e1d-a032-901100000001";
const FRIEND = "ae172e85-a8ab-4e1d-a032-901100000002";
const STRANGER = "ae172e85-a8ab-4e1d-a032-901100000003";
const ORIGIN = "https://api.example.test";

type Claim = { parkId: string; thisMonth: boolean };

class MemorySocialStore implements SocialStore {
  readonly names = new Map<string, string | null>([[ME, "Nathan"], [FRIEND, "Robin"], [STRANGER, null]]);
  readonly codes = new Map<string, string>();
  readonly friendships = new Set<string>();
  readonly claims = new Map<string, Claim[]>();

  private pair(a: string, b: string) {
    return [a, b].sort().join(":");
  }

  private profile(accountId: string): SocialProfile | null {
    const friendCode = this.codes.get(accountId);
    return friendCode ? { accountId, friendCode, displayName: this.names.get(accountId) ?? null } : null;
  }

  private row(accountId: string): LeaderboardRow {
    const claims = this.claims.get(accountId) ?? [];
    return {
      accountId,
      displayName: this.names.get(accountId) ?? null,
      parksThisMonth: new Set(claims.filter((claim) => claim.thisMonth).map((claim) => claim.parkId)).size,
      totalParks: new Set(claims.map((claim) => claim.parkId)).size,
      friendsSince: null,
    };
  }

  private codeTaken(code: string) {
    return [...this.codes.values()].includes(code);
  }

  async ensureProfile(accountId: string, newCode: string) {
    if (!this.codes.has(accountId)) {
      if (this.codeTaken(newCode)) return null;
      this.codes.set(accountId, newCode);
    }
    return this.profile(accountId);
  }

  async rotateCode(accountId: string, newCode: string) {
    if (this.codeTaken(newCode)) return null;
    this.codes.set(accountId, newCode);
    return this.profile(accountId);
  }

  async setDisplayName(accountId: string, name: string) {
    this.names.set(accountId, name);
  }

  async addFriendByCode(accountId: string, code: string, limit: number): Promise<AddFriendResult> {
    const friendId = [...this.codes.entries()].find(([, value]) => value === code)?.[0];
    if (!friendId) return { status: "not_found" };
    if (friendId === accountId) return { status: "self" };
    const key = this.pair(accountId, friendId);
    if (this.friendships.has(key)) return { status: "existing", friend: this.row(friendId) };
    const count = [...this.friendships].filter((pair) => pair.includes(accountId)).length;
    if (count >= limit) return { status: "limit" };
    this.friendships.add(key);
    return { status: "added", friend: this.row(friendId) };
  }

  async removeFriend(accountId: string, friendId: string) {
    return this.friendships.delete(this.pair(accountId, friendId));
  }

  async leaderboard(accountId: string): Promise<Leaderboard> {
    const friends = [...this.friendships].filter((pair) => pair.includes(accountId))
      .map((pair) => pair.split(":").find((id) => id !== accountId)!);
    return { monthStart: "2026-10-01T07:00:00.000Z", rows: [accountId, ...friends].map((id) => this.row(id)) };
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

let codeCounter = 0;
async function call(...args: Parameters<typeof callRaw>): Promise<Response | null> {
  try {
    return await callRaw(...args);
  } catch (error) {
    if (error instanceof HttpError) return json({ code: error.code }, error.status);
    throw error;
  }
}

function callRaw(store: SocialStore, accountId: string, method: string, path: string, body?: unknown, newCode?: () => string) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return handleSocialRequest(request, {
    json,
    accountId,
    store: () => store,
    newCode: newCode ?? (() => {
      const n = codeCounter++;
      return `ABCDEF${FRIEND_CODE_ALPHABET[n % 31]}${FRIEND_CODE_ALPHABET[Math.floor(n / 31) % 31]}`;
    }),
  });
}

async function body(response: Response | null) {
  assert.ok(response);
  return await response.json() as Record<string, any>;
}

test("friend codes avoid look-alike characters and parse from links", () => {
  for (let i = 0; i < 50; i += 1) assert.match(generateFriendCode(), /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  assert.equal(parseFriendCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(parseFriendCode("https://parkdex.app/friend/ABCDEFGH"), "ABCDEFGH");
  assert.equal(parseFriendCode("https://parkdex.app/friend/ABCDEFGH/"), "ABCDEFGH");
  assert.equal(parseFriendCode("https://web.parkdex.app/friend/ABCDEFGH?n=Robin"), "ABCDEFGH");
  assert.equal(parseFriendCode("ABCDEFG0"), null);
  assert.equal(parseFriendCode("ABC"), null);
  assert.equal(parseFriendCode(42), null);
});

test("the profile is created once and keeps its code", async () => {
  const store = new MemorySocialStore();
  const first = await body(await call(store, ME, "GET", "/api/social/me"));
  const second = await body(await call(store, ME, "GET", "/api/social/me"));
  assert.equal(first.profile.displayName, "Nathan");
  assert.match(first.profile.friendCode, /^[A-Z2-9]{8}$/);
  assert.equal(second.profile.friendCode, first.profile.friendCode);
});

test("a code collision retries with a fresh code", async () => {
  const store = new MemorySocialStore();
  store.codes.set(FRIEND, "AAAAAAAA");
  const codes = ["AAAAAAAA", "AAAAAAAA", "BBBBBBBB"];
  const response = await body(await call(store, ME, "GET", "/api/social/me", undefined, () => codes.shift()!));
  assert.equal(response.profile.friendCode, "BBBBBBBB");
});

test("rotating the code stops the old one from adding you", async () => {
  const store = new MemorySocialStore();
  const before = (await body(await call(store, FRIEND, "GET", "/api/social/me"))).profile.friendCode;
  const after = (await body(await call(store, FRIEND, "POST", "/api/social/me/code"))).profile.friendCode;
  assert.notEqual(after, before);
  const stale = await call(store, ME, "POST", "/api/social/friends", { code: before });
  assert.equal(stale?.status, 404);
});

test("display names are trimmed and bounded", async () => {
  const store = new MemorySocialStore();
  const saved = await body(await call(store, ME, "PUT", "/api/social/me", { displayName: "  Trail   Runner " }));
  assert.equal(saved.profile.displayName, "Trail Runner");
  const tooLong = await call(store, ME, "PUT", "/api/social/me", { displayName: "x".repeat(41) });
  assert.equal(tooLong?.status, 400);
  const extra = await call(store, ME, "PUT", "/api/social/me", { displayName: "Ok", email: "x" });
  assert.equal(extra?.status, 400);
});

test("adding a friend by code is mutual, idempotent and rejects your own code", async () => {
  const store = new MemorySocialStore();
  const friendCode = (await body(await call(store, FRIEND, "GET", "/api/social/me"))).profile.friendCode;
  const myCode = (await body(await call(store, ME, "GET", "/api/social/me"))).profile.friendCode;

  const added = await call(store, ME, "POST", "/api/social/friends", { code: `https://parkdex.app/friend/${friendCode.toLowerCase()}` });
  assert.equal(added?.status, 201);
  assert.equal((await body(added)).friend.displayName, "Robin");
  assert.equal((await call(store, ME, "POST", "/api/social/friends", { code: friendCode }))?.status, 200);
  assert.equal((await call(store, ME, "POST", "/api/social/friends", { code: myCode }))?.status, 400);
  assert.equal((await call(store, ME, "POST", "/api/social/friends", { code: "ZZZZZZZZ" }))?.status, 404);
  assert.equal((await call(store, ME, "POST", "/api/social/friends", { code: "nope" }))?.status, 400);

  const theirBoard = await body(await call(store, FRIEND, "GET", "/api/social/leaderboard"));
  assert.deepEqual(theirBoard.rows.map((row: { displayName: string }) => row.displayName).sort(), ["Nathan", "Robin"]);
});

test("the leaderboard ranks unique parks this month, then all time, and marks you", async () => {
  const store = new MemorySocialStore();
  store.codes.set(FRIEND, "FFFFFFFF");
  store.codes.set(STRANGER, "SSSSSSSS");
  await call(store, ME, "POST", "/api/social/friends", { code: "FFFFFFFF" });
  await call(store, ME, "POST", "/api/social/friends", { code: "SSSSSSSS" });
  store.claims.set(ME, [{ parkId: "elk-lake", thisMonth: true }, { parkId: "elk-lake", thisMonth: true }, { parkId: "goldstream", thisMonth: false }]);
  store.claims.set(FRIEND, [{ parkId: "elk-lake", thisMonth: true }, { parkId: "thetis", thisMonth: true }]);
  store.claims.set(STRANGER, [{ parkId: "a", thisMonth: false }, { parkId: "b", thisMonth: false }, { parkId: "c", thisMonth: false }]);

  const board = await body(await call(store, ME, "GET", "/api/social/leaderboard"));
  assert.equal(board.monthStart, "2026-10-01T07:00:00.000Z");
  assert.deepEqual(board.rows.map((row: Record<string, unknown>) => [row.displayName, row.parksThisMonth, row.totalParks, row.isMe]), [
    ["Robin", 2, 2, false],
    ["Nathan", 1, 2, true],
    ["Park explorer", 0, 3, false],
  ]);
});

test("removing a friend takes them off both boards", async () => {
  const store = new MemorySocialStore();
  store.codes.set(FRIEND, "FFFFFFFF");
  await call(store, ME, "POST", "/api/social/friends", { code: "FFFFFFFF" });
  assert.equal((await call(store, FRIEND, "DELETE", `/api/social/friends/${ME}`))?.status, 200);
  assert.equal((await call(store, FRIEND, "DELETE", `/api/social/friends/${ME}`))?.status, 404);
  const board = await body(await call(store, ME, "GET", "/api/social/leaderboard"));
  assert.equal(board.rows.length, 1);
});

test("friend limits are enforced", async () => {
  const store = new MemorySocialStore();
  store.codes.set(FRIEND, "FFFFFFFF");
  for (let i = 0; i < 200; i += 1) store.friendships.add(`${ME}:x${i}`);
  const response = await call(store, ME, "POST", "/api/social/friends", { code: "FFFFFFFF" });
  assert.equal(response?.status, 409);
});

const env: WorkerEnvironment = {
  PUBLIC_APP_URL: ORIGIN,
  DATABASE_URL: "postgresql://unused:unused@ep-test.us-west-2.aws.neon.tech/unused",
  AUTH_SESSION_SECRET: "auth-test-secret-".repeat(4),
  KIP_RETENTION_SECRET: "retention-test-secret-".repeat(4),
  EMAIL_MODE: "disabled",
};

test("social routes require a signed-in account before touching storage", async () => {
  const worker = createFeedbackWorker({ createSocialStore() { assert.fail("unauthenticated social access"); } });
  for (const [method, path] of [["GET", "/api/social/me"], ["GET", "/api/social/leaderboard"], ["POST", "/api/social/friends"]]) {
    const response = await worker.fetch(new Request(ORIGIN + path, { method, headers: { origin: ORIGIN } }), env);
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("cookie social writes need the CSRF token", async () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const sessionToken = "s".repeat(43);
  const csrfToken = "c".repeat(43);
  const session: StoredSession = {
    id: ME, email: "owned@example.test", emailVerified: true, displayName: "Owned", providers: ["email"],
    sessionId: "22222222-2222-4222-8222-222222222222", tokenHash: hash(sessionToken), csrfHash: hash(csrfToken), transport: "web",
    expiresAt: "2099-01-01T00:00:00Z", absoluteExpiresAt: "2099-02-01T00:00:00Z", reauthenticatedAt: null,
  };
  const authStore = { findSession: async () => session } as unknown as AccountAuthStore;
  const store = new MemorySocialStore();
  store.codes.set(FRIEND, "FFFFFFFF");
  const worker = createFeedbackWorker({ auth: { createStore: () => authStore }, createSocialStore: () => store });
  const cookie = `kip_account_session=${sessionToken}; kip_account_csrf=${csrfToken}`;
  const request = (headers: Record<string, string>) => new Request(ORIGIN + "/api/social/friends", {
    method: "POST", headers: { origin: ORIGIN, cookie, "content-type": "application/json", "x-kip-account-id": ME, ...headers }, body: JSON.stringify({ code: "FFFFFFFF" }),
  });
  assert.equal((await worker.fetch(request({}), env)).status, 403);
  assert.equal((await worker.fetch(request({ "x-csrf-token": csrfToken }), env)).status, 201);
});
