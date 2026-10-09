import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createFeedbackWorker, type WorkerEnvironment } from "./index.js";
import type { AccountAuthStore, StoredSession } from "./accounts/auth-store.js";
import type { GameStore, PlayerRecord, RecordVisitResult, VisitRecord } from "./game-store.js";
import { flagSeedFor, visitEvents, type GameEvent } from "./game.js";

const origin = "https://kip.example.test";
const env: WorkerEnvironment = {
  PUBLIC_APP_URL: origin,
  DATABASE_URL: "postgresql://unused:unused@ep-test.us-west-2.aws.neon.tech/unused",
  AUTH_SESSION_SECRET: "auth-test-secret-".repeat(4),
  EMAIL_MODE: "disabled",
};
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const VISIT = "33333333-3333-4333-8333-333333333333";
const PARK = "municipal-beacon-hill-park";
const NOW = Date.parse("2026-10-08T17:00:00.000Z");
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

const player: PlayerRecord = { handle: "sam", flagSeed: "0123456789abcdef", createdAt: "2026-10-01T00:00:00.000Z", takeoversSeenAt: null };
const tookVisit: VisitRecord = {
  visitId: VISIT, parkId: PARK, outcome: "took", pointsEarned: 4, previousHolder: { handle: "bee", flagSeed: "fedcba9876543210" },
  flagSince: "2026-10-08T17:00:00.000Z", visitedAt: "2026-10-08T17:00:00.000Z", fell: false,
};

class MemoryGameStore implements GameStore {
  players = new Map<string, PlayerRecord>([[ACCOUNT, player]]);
  owners = new Map<string, string>([["taken_one", "99999999-9999-4999-8999-999999999999"], ["sam", ACCOUNT]]);
  visitResult: RecordVisitResult = { status: "recorded", visit: tookVisit };
  visitCalls: Array<{ accountId: string; visitId: string; parkId: string; visitedAt: string }> = [];
  seenAt: string | null = null;

  async getPlayer(accountId: string) { return this.players.get(accountId) ?? null; }
  async handleOwner(handle: string, accountId: string) {
    const owner = this.owners.get(handle);
    return owner === undefined ? "none" as const : owner === accountId ? "self" as const : "other" as const;
  }
  async setHandle(accountId: string, handle: string) {
    const saved = { ...player, handle };
    this.players.set(accountId, saved);
    this.owners.set(handle, accountId);
    return { status: "saved" as const, player: saved };
  }
  async recordVisit(accountId: string, visitId: string, parkId: string, visitedAt: string) {
    this.visitCalls.push({ accountId, visitId, parkId, visitedAt });
    return this.visitResult;
  }
  async summary() {
    return { score: 12, parks: [{ parkId: PARK, since: "2026-10-01T00:00:00.000Z", days: 7 }], takeovers: [{ parkId: "regional-x", byHandle: "bee", byFlagSeed: "fedcba9876543210", at: "2026-10-07T00:00:00.000Z" }], visitedToday: [PARK] };
  }
  async markTakeoversSeen(_accountId: string, at: string) {
    this.seenAt = at;
    return { ...player, takeoversSeenAt: at };
  }
  async flags() { return [{ parkId: PARK, handle: "sam", flagSeed: player.flagSeed, since: "2026-10-01T00:00:00.000Z" }]; }
  async leaderboard() { return [{ rank: 1, handle: "sam", flagSeed: player.flagSeed, score: 12, parksHeld: 1 }]; }
  async founders() { return [{ parkId: PARK, handle: "sam", photoSha256: "a".repeat(64) }]; }
  async founderPoints() { return 10; }
}

function setup(options: { fetch?: typeof fetch; envOverride?: Partial<WorkerEnvironment> } = {}) {
  const store = new MemoryGameStore();
  const events: GameEvent[] = [];
  const worker = createFeedbackWorker({
    auth: { createStore: () => authStore },
    game: { createStore: () => store, now: () => NOW, fetch: options.fetch, onEvent: (event) => { events.push(event); } },
  });
  const call = (method: string, path: string, body?: unknown, auth: "bearer" | "cookie" | "cookie-no-csrf" | "none" = "bearer") => {
    const headers = new Headers({ origin });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (auth === "bearer") headers.set("authorization", `Bearer ${bearer}`);
    if (auth === "cookie" || auth === "cookie-no-csrf") headers.set("cookie", `kip_account_session=${cookieToken}; kip_account_csrf=${csrfToken}`);
    if (auth === "cookie") headers.set("x-csrf-token", csrfToken);
    if (auth !== "none") headers.set("x-kip-account-id", ACCOUNT);
    return worker.fetch(new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ...options.envOverride });
  };
  return { store, events, call };
}

async function code(response: Response): Promise<string> {
  return (await response.json() as { code: string }).code;
}

test("authenticated game routes require an account and public routes do not", async () => {
  const { call, store } = setup();
  for (const [method, path, body] of [["GET", "/api/game/me"], ["PUT", "/api/game/handle", { handle: "newname" }], ["POST", "/api/game/visits", { visitId: VISIT, parkId: PARK }], ["POST", "/api/game/takeovers/seen", { at: new Date(NOW).toISOString() }]] as const) {
    const response = await call(method, path, body, "none");
    assert.equal(response.status, 401, path);
    assert.equal(await code(response), "authentication_required");
  }
  assert.equal(store.visitCalls.length, 0);
  assert.equal((await call("GET", "/api/game/flags", undefined, "none")).status, 200);
  assert.equal((await call("GET", "/api/game/leaderboard", undefined, "none")).status, 200);
});

test("cookie writes need the CSRF token", async () => {
  const { call, store } = setup();
  const rejected = await call("POST", "/api/game/visits", { visitId: VISIT, parkId: PARK }, "cookie-no-csrf");
  assert.equal(rejected.status, 403);
  assert.equal(store.visitCalls.length, 0);
  assert.equal((await call("POST", "/api/game/visits", { visitId: VISIT, parkId: PARK }, "cookie")).status, 200);
  assert.equal((await call("GET", "/api/game/me", undefined, "cookie-no-csrf")).status, 200, "reads only need the session");
});

test("routing rejects wrong methods and unknown game paths", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/api/game/visits")).status, 405);
  assert.equal((await call("POST", "/api/game/flags", {})).status, 405);
  assert.equal((await call("GET", "/api/game/nope")).status, 404);
});

test("visit bodies are strictly validated before the store is touched", async () => {
  const { call, store } = setup();
  for (const body of [{}, { visitId: VISIT }, { visitId: VISIT, parkId: PARK, visitedAt: "2026-01-01T00:00:00Z" }, { visitId: "not-a-uuid", parkId: PARK }, { visitId: VISIT, parkId: "Bad Park" }, { visitId: VISIT, parkId: "a".repeat(161) }, [VISIT, PARK]]) {
    const response = await call("POST", "/api/game/visits", body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(store.visitCalls.length, 0);
});

test("a visit uses the server clock and returns the contract shape", async () => {
  const { call, store, events } = setup();
  const response = await call("POST", "/api/game/visits", { visitId: VISIT.toUpperCase(), parkId: PARK });
  assert.equal(response.status, 200);
  const body = await response.json() as { visit: Record<string, unknown> };
  assert.deepEqual(Object.keys(body), ["visit"]);
  assert.deepEqual(body.visit, {
    visitId: VISIT, parkId: PARK, outcome: "took", pointsEarned: 4,
    previousHolder: { handle: "bee", flagSeed: "fedcba9876543210" }, flagSince: "2026-10-08T17:00:00.000Z",
  });
  assert.deepEqual(store.visitCalls, [{ accountId: ACCOUNT, visitId: VISIT, parkId: PARK, visitedAt: new Date(NOW).toISOString() }]);
  assert.deepEqual(events.map((event) => event.name), ["flag_taken"]);
});

test("visit store outcomes map to the documented errors", async () => {
  const cases: Array<[RecordVisitResult, number, string]> = [
    [{ status: "park_not_found" }, 404, "park_not_found"],
    [{ status: "handle_required" }, 409, "handle_required"],
    [{ status: "conflict" }, 409, "visit_id_reused"],
    [{ status: "account_unavailable" }, 410, "account_deleting"],
  ];
  for (const [result, status, errorCode] of cases) {
    const { call, store } = setup();
    store.visitResult = result;
    const response = await call("POST", "/api/game/visits", { visitId: VISIT, parkId: PARK });
    assert.equal(response.status, status);
    assert.equal(await code(response), errorCode);
  }
});

test("visit events cover falls and skip replays", () => {
  const fell: RecordVisitResult = { status: "recorded", visit: { ...tookVisit, outcome: "planted", pointsEarned: 0, previousHolder: null, fell: true } };
  assert.deepEqual(visitEvents(fell, ACCOUNT).map((event) => event.name), ["flag_fell", "flag_planted"]);
  assert.deepEqual(visitEvents({ status: "replayed", visit: tookVisit }, ACCOUNT), []);
  assert.deepEqual(visitEvents({ status: "already_today", visit: { ...tookVisit, outcome: "already_today", pointsEarned: 0 } }, ACCOUNT).map((event) => event.name), ["visit_already_today"]);
  assert.deepEqual(visitEvents({ status: "handle_required" }, ACCOUNT), []);
});

test("handles are normalised, validated, checked against the blocklist and uniqueness", async () => {
  const { call } = setup();
  const saved = await call("PUT", "/api/game/handle", { handle: "  @Trail_Runner " });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { player: { handle: "trail_runner", flagSeed: player.flagSeed } });
  for (const handle of ["ab", "has space", "x".repeat(21), "dash-name", 12345]) {
    const response = await call("PUT", "/api/game/handle", { handle });
    assert.equal(response.status, 400, String(handle));
    assert.equal(await code(response), "invalid_handle");
  }
  assert.equal((await call("PUT", "/api/game/handle", { handle: "x", extra: true })).status, 400);
  const blocked = await call("PUT", "/api/game/handle", { handle: "Parkdex_Admin" });
  assert.equal(blocked.status, 422);
  assert.equal(await code(blocked), "handle_rejected");
  const taken = await call("PUT", "/api/game/handle", { handle: "taken_one" });
  assert.equal(taken.status, 409);
  assert.equal(await code(taken), "handle_taken");
});

test("handle moderation asks OpenRouter when the key is set and falls back when it fails", async () => {
  const requests: string[] = [];
  const rejecting = setup({
    envOverride: { OPENROUTER_API_KEY: "test-key" },
    fetch: async (url, init) => {
      requests.push(String(url));
      assert.deepEqual(JSON.parse(String(init?.body)).state, { handle: "jane_doe_555" });
      return new Response(JSON.stringify({ answers: { handle: { type: "choice", choice: "reject", confidence: 0.8, probabilities: { allow: 0.15, reject: 0.8, unsure: 0.05 } } } }));
    },
  });
  const rejected = await rejecting.call("PUT", "/api/game/handle", { handle: "jane_doe_555" });
  assert.equal(rejected.status, 422);
  assert.equal(await code(rejected), "handle_rejected");
  assert.deepEqual(requests, ["https://openrouter.ai/api/alpha/decisions"]);

  const failing = setup({ envOverride: { OPENROUTER_API_KEY: "test-key" }, fetch: async () => new Response("upstream down", { status: 502 }) });
  assert.equal((await failing.call("PUT", "/api/game/handle", { handle: "jane_doe_555" })).status, 200);

  let called = false;
  const keyless = setup({ fetch: async () => { called = true; return new Response("{}"); } });
  assert.equal((await keyless.call("PUT", "/api/game/handle", { handle: "jane_doe_555" })).status, 200);
  assert.equal(called, false);

  // Keeping the current handle never re-asks the model.
  const keep = setup({ envOverride: { OPENROUTER_API_KEY: "test-key" }, fetch: async () => { throw new Error("must not be called"); } });
  assert.equal((await keep.call("PUT", "/api/game/handle", { handle: "sam" })).status, 200);
});

test("me returns the player summary, or a flag seed and empty state before a handle", async () => {
  const { call, store } = setup();
  const response = await call("GET", "/api/game/me");
  assert.deepEqual(await response.json(), {
    player: { handle: "sam", flagSeed: player.flagSeed }, flagSeed: player.flagSeed, score: 12,
    parks: [{ parkId: PARK, since: "2026-10-01T00:00:00.000Z", days: 7 }],
    takeovers: [{ parkId: "regional-x", byHandle: "bee", byFlagSeed: "fedcba9876543210", at: "2026-10-07T00:00:00.000Z" }],
    founderPoints: 10,
    visitedToday: [PARK],
    serverTime: new Date(NOW).toISOString(),
  });
  store.players.clear();
  const empty = await (await call("GET", "/api/game/me")).json() as Record<string, unknown>;
  assert.deepEqual(empty, { player: null, flagSeed: await flagSeedFor(ACCOUNT), score: 0, parks: [], takeovers: [], visitedToday: [], founderPoints: 0, serverTime: new Date(NOW).toISOString() });
  assert.match(String(empty.flagSeed), /^[0-9a-f]{16}$/);
});

test("takeovers seen clamps the marker to server time and validates the body", async () => {
  const { call, store, events } = setup();
  const future = new Date(NOW + 86_400_000).toISOString();
  const response = await call("POST", "/api/game/takeovers/seen", { at: future });
  assert.equal(response.status, 200);
  assert.equal(store.seenAt, new Date(NOW).toISOString());
  assert.deepEqual(events.map((event) => event.name), ["takeover_message_seen"]);
  assert.equal((await call("POST", "/api/game/takeovers/seen", { at: "yesterday" })).status, 400);
  assert.equal((await call("POST", "/api/game/takeovers/seen", {})).status, 400);
});

test("public flags and leaderboard return the contract shape without account IDs", async () => {
  const { call, events } = setup();
  const flags = await (await call("GET", "/api/game/flags", undefined, "none")).json() as Record<string, unknown>;
  assert.deepEqual(flags, {
    flags: [{ parkId: PARK, handle: "sam", flagSeed: player.flagSeed, since: "2026-10-01T00:00:00.000Z" }],
    // Founded parks carry an absolute cover URL, so native builds can load it cross-origin.
    founders: [{ parkId: PARK, handle: "sam", coverUrl: `${origin}/api/parks/${PARK}/cover/${"a".repeat(64)}.jpg` }],
    serverTime: new Date(NOW).toISOString(),
  });
  const board = await (await call("GET", "/api/game/leaderboard", undefined, "none")).json() as Record<string, unknown>;
  assert.deepEqual(board, { players: [{ rank: 1, handle: "sam", flagSeed: player.flagSeed, score: 12, parksHeld: 1 }], serverTime: new Date(NOW).toISOString() });
  assert.doesNotMatch(JSON.stringify([flags, board]), new RegExp(ACCOUNT));
  assert.deepEqual(events.map((event) => event.name), ["leaderboard_viewed"]);
});

test("a game event hook failure never breaks a visit", async () => {
  const store = new MemoryGameStore();
  const worker = createFeedbackWorker({
    auth: { createStore: () => authStore },
    game: { createStore: () => store, now: () => NOW, onEvent: () => { throw new Error("analytics down"); } },
  });
  const response = await worker.fetch(new Request(origin + "/api/game/visits", {
    method: "POST",
    headers: { origin, "content-type": "application/json", authorization: `Bearer ${bearer}`, "x-kip-account-id": ACCOUNT },
    body: JSON.stringify({ visitId: VISIT, parkId: PARK }),
  }), env);
  assert.equal(response.status, 200);
});
