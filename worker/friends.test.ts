import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createFeedbackWorker, type WorkerEnvironment } from "./index.js";
import type { AccountAuthStore, StoredSession } from "./accounts/auth-store.js";
import type { AddFriendResult, FriendsStore, FriendWeekRow } from "./friends-store.js";
import { addResultFromJson } from "./friends-store.js";
import { FRIEND_LIMIT, validateAddFriendBody } from "./friends.js";
import { classifySql } from "./db.js";
import { FRIEND_CODE_LENGTH, normalizeSocialCode, SOCIAL_CODE_ALPHABET } from "./socialCodes.js";

const origin = "https://kip.example.test";
const env: WorkerEnvironment = {
  PUBLIC_APP_URL: origin,
  DATABASE_URL: "postgresql://unused:unused@ep-test.us-west-2.aws.neon.tech/unused",
  AUTH_SESSION_SECRET: "auth-test-secret-".repeat(4),
  EMAIL_MODE: "disabled",
};
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-10-14T17:00:00.000Z");
const bearer = "b".repeat(43);
const cookieToken = "s".repeat(43);
const csrfToken = "c".repeat(43);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function session(transport: "native" | "web"): StoredSession {
  return {
    id: ACCOUNT, email: "player@example.test", emailVerified: true, displayName: "Player", providers: ["email"],
    sessionId: "22222222-2222-4222-8222-222222222222", tokenHash: hash(transport === "native" ? bearer : cookieToken),
    csrfHash: transport === "web" ? hash(csrfToken) : null, transport,
    expiresAt: "2099-01-01T00:00:00Z", absoluteExpiresAt: "2099-02-01T00:00:00Z", reauthenticatedAt: null,
  };
}

const authStore = {
  async findSession(tokenHash: string) {
    if (tokenHash === hash(bearer)) return session("native");
    if (tokenHash === hash(cookieToken)) return session("web");
    return null;
  },
} as unknown as AccountAuthStore;

const board: FriendWeekRow[] = [
  { rank: 1, handle: "bee", flagSeed: "fedcba9876543210", uniqueParks: 4, isMe: false },
  { rank: 2, handle: "sam", flagSeed: "0123456789abcdef", uniqueParks: 2, isMe: true },
];

class MemoryFriendsStore implements FriendsStore {
  code: string | null = "ABCD2345";
  addResult: AddFriendResult = { status: "added", friend: { handle: "bee", flagSeed: "fedcba9876543210" } };
  addCalls: Array<{ accountId: string; code: string; limit: number }> = [];
  removeCalls: Array<{ accountId: string; handle: string }> = [];
  weekCalls: string[] = [];
  removed = true;

  async friendCode() { return this.code; }
  async resetFriendCode() { return this.code === null ? null : "WXYZ6789"; }
  async addFriend(accountId: string, code: string, limit: number) {
    this.addCalls.push({ accountId, code, limit });
    return this.addResult;
  }
  async removeFriend(accountId: string, handle: string) {
    this.removeCalls.push({ accountId, handle });
    return this.removed;
  }
  async week(_accountId: string, now: string) {
    this.weekCalls.push(now);
    return { week: { start: "2026-10-12", end: "2026-10-18", resetsAt: "2026-10-19T07:00:00.000Z" }, players: board };
  }
}

function setup() {
  const store = new MemoryFriendsStore();
  const worker = createFeedbackWorker({
    auth: { createStore: () => authStore },
    friends: { createStore: () => store, now: () => NOW },
  });
  const call = (method: string, path: string, body?: unknown, auth: "bearer" | "cookie" | "cookie-no-csrf" | "none" = "bearer") => {
    const headers = new Headers({ origin });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (auth === "bearer") headers.set("authorization", `Bearer ${bearer}`);
    if (auth === "cookie" || auth === "cookie-no-csrf") headers.set("cookie", `kip_account_session=${cookieToken}; kip_account_csrf=${csrfToken}`);
    if (auth === "cookie") headers.set("x-csrf-token", csrfToken);
    if (auth !== "none") headers.set("x-kip-account-id", ACCOUNT);
    return worker.fetch(new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  };
  return { store, call };
}

async function code(response: Response): Promise<string> {
  return (await response.json() as { code: string }).code;
}

test("every friends route needs an account", async () => {
  const { call, store } = setup();
  for (const [method, path, body] of [["GET", "/api/friends"], ["POST", "/api/friends", { code: "ABCD2345" }], ["DELETE", "/api/friends/bee"], ["POST", "/api/friends/code"]] as const) {
    const response = await call(method, path, body, "none");
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(await code(response), "authentication_required");
  }
  assert.equal(store.addCalls.length, 0);
});

test("cookie writes need the CSRF token, reads only the session", async () => {
  const { call, store } = setup();
  assert.equal((await call("POST", "/api/friends", { code: "ABCD2345" }, "cookie-no-csrf")).status, 403);
  assert.equal((await call("DELETE", "/api/friends/bee", undefined, "cookie-no-csrf")).status, 403);
  assert.equal(store.addCalls.length + store.removeCalls.length, 0);
  assert.equal((await call("POST", "/api/friends", { code: "ABCD2345" }, "cookie")).status, 200);
  assert.equal((await call("GET", "/api/friends", undefined, "cookie-no-csrf")).status, 200);
});

test("the board returns the code, the week and the players with the server clock", async () => {
  const { call, store } = setup();
  const response = await call("GET", "/api/friends");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    code: "ABCD2345",
    week: { start: "2026-10-12", end: "2026-10-18", resetsAt: "2026-10-19T07:00:00.000Z" },
    players: board,
    serverTime: new Date(NOW).toISOString(),
  });
  assert.deepEqual(store.weekCalls, [new Date(NOW).toISOString()]);
});

test("players without a handle are asked for one", async () => {
  const { call, store } = setup();
  store.code = null;
  const board = await call("GET", "/api/friends");
  assert.equal(board.status, 409);
  assert.equal(await code(board), "handle_required");
  const reset = await call("POST", "/api/friends/code");
  assert.equal(reset.status, 409);
  assert.equal(await code(reset), "handle_required");
});

test("adding a friend normalizes the code and passes the friend limit", async () => {
  const { call, store } = setup();
  const response = await call("POST", "/api/friends", { code: "abcd-2345" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "added", friend: { handle: "bee", flagSeed: "fedcba9876543210" } });
  assert.deepEqual(store.addCalls, [{ accountId: ACCOUNT, code: "ABCD2345", limit: FRIEND_LIMIT }]);
  store.addResult = { status: "already_friends", friend: { handle: "bee", flagSeed: "fedcba9876543210" } };
  const replay = await call("POST", "/api/friends", { code: "ABCD2345" });
  assert.equal(replay.status, 200, "a resent offline add is not an error");
  assert.equal((await replay.json() as { status: string }).status, "already_friends");
});

test("friend code bodies are strictly validated before the store is touched", async () => {
  const { call, store } = setup();
  for (const body of [{}, { code: 12345678 }, { code: "ABCD2345", extra: true }, { code: "ABC" }, { code: "ABCD234O" }, { code: "ABCD2341" }, { code: "x".repeat(65) }, ["ABCD2345"]]) {
    const response = await call("POST", "/api/friends", body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(store.addCalls.length, 0);
  assert.equal(validateAddFriendBody({ code: " wxyz 6789 " }), "WXYZ6789");
});

test("add outcomes map to the documented errors", async () => {
  const cases: Array<[AddFriendResult, number, string]> = [
    [{ status: "code_not_found" }, 404, "friend_code_not_found"],
    [{ status: "own_code" }, 409, "own_friend_code"],
    [{ status: "too_many_friends" }, 409, "too_many_friends"],
    [{ status: "handle_required" }, 409, "handle_required"],
    [{ status: "account_unavailable" }, 410, "account_deleting"],
  ];
  for (const [result, status, errorCode] of cases) {
    const { call, store } = setup();
    store.addResult = result;
    const response = await call("POST", "/api/friends", { code: "ABCD2345" });
    assert.equal(response.status, status, result.status);
    assert.equal(await code(response), errorCode);
  }
});

test("removing a friend validates the handle and reports a missing friendship", async () => {
  const { call, store } = setup();
  assert.equal((await call("DELETE", "/api/friends/%40Bee")).status, 200);
  assert.deepEqual(store.removeCalls, [{ accountId: ACCOUNT, handle: "bee" }]);
  assert.equal((await call("DELETE", "/api/friends/no%20spaces")).status, 400);
  assert.equal((await call("DELETE", "/api/friends/%E0%A4%A")).status, 400);
  store.removed = false;
  const missing = await call("DELETE", "/api/friends/bee");
  assert.equal(missing.status, 404);
  assert.equal(await code(missing), "friend_not_found");
});

test("a new code replaces the old one", async () => {
  const { call } = setup();
  const response = await call("POST", "/api/friends/code");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { code: "WXYZ6789" });
});

test("routing rejects wrong methods and unknown friends paths", async () => {
  const { call } = setup();
  assert.equal((await call("PUT", "/api/friends", {})).status, 405);
  assert.equal((await call("GET", "/api/friends/code")).status, 405);
  assert.equal((await call("GET", "/api/friends/bee")).status, 405);
  assert.equal((await call("GET", "/api/friends/bee/more")).status, 404);
});

test("stored add results are parsed strictly", () => {
  assert.deepEqual(addResultFromJson('{"status":"added","friend":{"handle":"bee","flagSeed":"fedcba9876543210"}}'),
    { status: "added", friend: { handle: "bee", flagSeed: "fedcba9876543210" } });
  assert.deepEqual(addResultFromJson({ status: "code_not_found" }), { status: "code_not_found" });
  assert.throws(() => addResultFromJson({ status: "maybe" }));
});

test("social codes use the shared alphabet", () => {
  assert.equal(SOCIAL_CODE_ALPHABET.length, 31);
  for (const confusable of "01ILO") assert.ok(!SOCIAL_CODE_ALPHABET.includes(confusable), confusable);
  assert.equal(normalizeSocialCode("abc-def", 6), "ABCDEF", "crew codes reuse the same rules");
  assert.equal(normalizeSocialCode("ABCD2345", FRIEND_CODE_LENGTH), "ABCD2345");
  assert.equal(normalizeSocialCode("ABCD234", FRIEND_CODE_LENGTH), null);
  assert.equal(normalizeSocialCode("ABCDI234", FRIEND_CODE_LENGTH), null);
});

test("friends database functions that change data count as writes", () => {
  for (const name of ["ensure_friend_code", "reset_friend_code", "add_friend", "remove_friend"]) {
    assert.equal(classifySql(`SELECT kip_social.${name}($1::uuid, $2) AS result`).operation, "write", name);
  }
  assert.equal(classifySql("SELECT rank, handle FROM kip_social.friends_week($1::uuid, $2::timestamptz)").operation, "read");
});
