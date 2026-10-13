import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createFeedbackWorker, type WorkerEnvironment } from "./index.js";
import type { AccountAuthStore, StoredSession } from "./accounts/auth-store.js";
import { visitFromJson, type CrewRecord, type FoundingReviewRecord, type GameStore, type JoinCrewResult, type PlayerRecord, type RecordVisitResult, type VisitRecord } from "./game-store.js";
import { FOUNDING_DECISIONS_LIMIT, flagSeedFor, validateJoinBody, visitEvents, type GameEvent } from "./game.js";
import { normalizeCrewCode } from "./crewCodes.js";
import { normalizeRoute } from "./requestContext.js";

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
  visitId: VISIT, parkId: PARK, outcome: "took", pointsEarned: 7, pointsBreakdown: { base: 4, days: 3 }, previousHolder: { handle: "bee", flagSeed: "fedcba9876543210" },
  flagSince: "2026-10-08T17:00:00.000Z", visitedAt: "2026-10-08T17:00:00.000Z", fell: false, protected: null,
};
const CODE = "K7QX2M";
const crew: CrewRecord = {
  parkId: PARK, leader: { handle: "bee", flagSeed: "fedcba9876543210" },
  members: [
    { handle: "bee", flagSeed: "fedcba9876543210", joinedAt: "2026-10-08T16:30:00.000Z", leader: true },
    { handle: "sam", flagSeed: player.flagSeed, joinedAt: "2026-10-08T17:00:00.000Z", leader: false },
  ],
  size: 2, cap: 8, flagSince: "2026-10-08T16:30:00.000Z", protectedUntil: "2026-10-08T17:30:00.000Z",
  member: true, code: CODE, codeExpiresAt: "2026-10-08T17:30:00.000Z",
};
const joinedVisit: VisitRecord = {
  ...tookVisit, outcome: "joined", pointsEarned: 2, pointsBreakdown: { base: 2, days: 0 }, previousHolder: null, flagSince: "2026-10-08T16:30:00.000Z",
};
const loggedVisit: VisitRecord = {
  ...tookVisit, outcome: "logged", pointsEarned: 1, pointsBreakdown: { base: 1, days: 0 }, previousHolder: null, flagSince: null,
  protected: { until: "2026-10-08T17:30:00.000Z", leader: { handle: "bee", flagSeed: "fedcba9876543210" }, crewSize: 3 },
};

class MemoryGameStore implements GameStore {
  players = new Map<string, PlayerRecord>([[ACCOUNT, player]]);
  owners = new Map<string, string>([["taken_one", "99999999-9999-4999-8999-999999999999"], ["sam", ACCOUNT]]);
  visitResult: RecordVisitResult = { status: "recorded", visit: tookVisit };
  visitCalls: Array<{ accountId: string; visitId: string; parkId: string; visitedAt: string }> = [];
  joinResult: JoinCrewResult = { status: "joined", visit: joinedVisit, crew };
  joinCalls: Array<{ accountId: string; code: string; visitId: string; now: string }> = [];
  crew: CrewRecord | null = crew;
  crewCalls: Array<{ parkId: string; accountId: string; now: string }> = [];
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
    return {
      score: 12, parks: [{ parkId: PARK, since: "2026-10-01T00:00:00.000Z", days: 7, hours: 185, crew: { size: 2, leader: false, protectedUntil: null } }],
      takeovers: [{ parkId: "regional-x", byHandle: "bee", byFlagSeed: "fedcba9876543210", at: "2026-10-07T00:00:00.000Z" }],
      visitedToday: [PARK], visitedTodayUntil: "2026-10-09T07:00:00.000Z", loggedToday: ["regional-y"],
    };
  }
  async markTakeoversSeen(_accountId: string, at: string) {
    this.seenAt = at;
    return { ...player, takeoversSeenAt: at };
  }
  async flags() {
    return [{ parkId: PARK, handle: "sam", flagSeed: player.flagSeed, since: "2026-10-01T00:00:00.000Z", crew: { size: 5, memberSeeds: ["1111111111111111", "2222222222222222", "3333333333333333"], protectedUntil: null } }];
  }
  async joinCrew(accountId: string, code: string, visitId: string, now: string) {
    this.joinCalls.push({ accountId, code, visitId, now });
    return this.joinResult;
  }
  async parkCrew(parkId: string, accountId: string, now: string) {
    this.crewCalls.push({ parkId, accountId, now });
    return this.crew;
  }
  async leaderboard() { return [{ rank: 1, handle: "sam", flagSeed: player.flagSeed, score: 12, parksHeld: 1 }]; }
  async founders() { return [{ parkId: PARK, handle: "sam", photoSha256: "a".repeat(64) }]; }
  async founderPoints() { return 24; }
  reviews: FoundingReviewRecord[] = [];
  async foundingReviews() { return this.reviews; }
  dexCalls: Array<{ accountId: string; now: string }> = [];
  async dex(accountId: string, now: string) {
    this.dexCalls.push({ accountId, now });
    return [
      { parkId: PARK, days: ["2026-10-01", "2026-10-08"], firstVisitAt: "2026-10-01T18:00:00.000Z", lastVisitAt: "2026-10-08T17:00:00.000Z", hidden: false },
      { parkId: "municipal-hidden", days: ["2026-09-30"], firstVisitAt: "2026-09-30T18:00:00.000Z", lastVisitAt: "2026-09-30T18:00:00.000Z", hidden: true },
    ];
  }
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
  for (const [method, path, body] of [["GET", "/api/game/me"], ["PUT", "/api/game/handle", { handle: "newname" }], ["POST", "/api/game/visits", { visitId: VISIT, parkId: PARK }], ["POST", "/api/game/takeovers/seen", { at: new Date(NOW).toISOString() }],
    ["POST", "/api/game/crews/join", { visitId: VISIT, code: CODE }], ["GET", `/api/game/parks/${PARK}/crew`]] as const) {
    const response = await call(method, path, body, "none");
    assert.equal(response.status, 401, path);
    assert.equal(await code(response), "authentication_required");
  }
  assert.equal(store.visitCalls.length, 0);
  assert.equal(store.joinCalls.length + store.crewCalls.length, 0);
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
  assert.equal((await call("GET", "/api/game/crews/join")).status, 405);
  assert.equal((await call("POST", `/api/game/parks/${PARK}/crew`, {})).status, 405);
  assert.equal((await call("GET", `/api/game/parks/${PARK}/crew/extra`)).status, 404);
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
    visitId: VISIT, parkId: PARK, outcome: "took", pointsEarned: 7, pointsBreakdown: { base: 4, days: 3 },
    previousHolder: { handle: "bee", flagSeed: "fedcba9876543210" }, flagSince: "2026-10-08T17:00:00.000Z", protected: null,
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

test("a visit during someone else's protected hour is logged with the crew details (#170)", async () => {
  const { call, store, events } = setup();
  store.visitResult = { status: "protected", visit: loggedVisit };
  const response = await call("POST", "/api/game/visits", { visitId: VISIT, parkId: PARK });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    visit: {
      visitId: VISIT, parkId: PARK, outcome: "logged", pointsEarned: 1, pointsBreakdown: { base: 1, days: 0 }, previousHolder: null, flagSince: null,
      protected: { until: "2026-10-08T17:30:00.000Z", leader: { handle: "bee", flagSeed: "fedcba9876543210" }, crewSize: 3 },
    },
  });
  assert.deepEqual(events, [{ name: "visit_logged_protected", accountId: ACCOUNT, parkId: PARK, pointsEarned: 1, crewSize: 3 }]);
  // A replayed logged visit answers the same and records nothing.
  store.visitResult = { status: "replayed", visit: loggedVisit };
  assert.equal((await call("POST", "/api/game/visits", { visitId: VISIT, parkId: PARK })).status, 200);
  assert.equal(events.length, 1);
});

test("visit events cover falls and skip replays", () => {
  const fell: RecordVisitResult = { status: "recorded", visit: { ...tookVisit, outcome: "planted", pointsEarned: 6, pointsBreakdown: { base: 6, days: 0 }, previousHolder: null, fell: true } };
  assert.deepEqual(visitEvents(fell, ACCOUNT).map((event) => event.name), ["flag_fell", "flag_planted"]);
  assert.deepEqual(visitEvents({ status: "replayed", visit: tookVisit }, ACCOUNT), []);
  assert.deepEqual(visitEvents({ status: "already_today", visit: { ...tookVisit, outcome: "already_today", pointsEarned: 0, pointsBreakdown: { base: 0, days: 0 } } }, ACCOUNT).map((event) => event.name), ["visit_already_today"]);
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
    // days drives flag weathering; hours is the holding points so far (#169).
    // crew is additive (#170): a member's park is held like the leader's.
    parks: [{ parkId: PARK, since: "2026-10-01T00:00:00.000Z", days: 7, hours: 185, crew: { size: 2, leader: false, protectedUntil: null } }],
    takeovers: [{ parkId: "regional-x", byHandle: "bee", byFlagSeed: "fedcba9876543210", at: "2026-10-07T00:00:00.000Z" }],
    founderPoints: 24,
    foundingReviews: { pending: [], decided: [] },
    visitedToday: [PARK],
    visitedTodayUntil: "2026-10-09T07:00:00.000Z",
    loggedToday: ["regional-y"],
    serverTime: new Date(NOW).toISOString(),
  });
  store.players.clear();
  const empty = await (await call("GET", "/api/game/me")).json() as Record<string, unknown>;
  assert.deepEqual(empty, {
    player: null, flagSeed: await flagSeedFor(ACCOUNT), score: 0, parks: [], takeovers: [], visitedToday: [], visitedTodayUntil: null, loggedToday: [], founderPoints: 0,
    foundingReviews: { pending: [], decided: [] }, serverTime: new Date(NOW).toISOString(),
  });
  assert.match(String(empty.flagSeed), /^[0-9a-f]{16}$/);
});

test("me lists pending founding reviews and unseen decisions in the documented shape (#153)", async () => {
  const { call, store } = setup();
  const base = { osm: null, reason: null, founderHandle: null, founderIsPlayer: false, coverSha256: null, decidedAt: null, createdAt: "2026-10-08T10:00:00.000Z" };
  store.reviews = [
    { ...base, requestId: "r-pending", status: "pending", parkId: "osm-way-5", osm: { type: "way", id: 5 }, parkName: "Paterson Park" },
    { ...base, requestId: "r-approved", status: "approved", parkId: PARK, parkName: "Beacon Hill Park", founderHandle: "sam", founderIsPlayer: true, coverSha256: "b".repeat(64), decidedAt: "2026-10-08T12:00:00.000Z" },
    { ...base, requestId: "r-rejected", status: "rejected", parkId: "regional-x", parkName: "X Park", reason: "There are people in the photo.", decidedAt: "2026-10-08T13:00:00.000Z" },
    { ...base, requestId: "r-superseded", status: "superseded", parkId: "regional-y", parkName: "Y Park", founderHandle: "bee", coverSha256: "c".repeat(64), decidedAt: "2026-10-08T14:00:00.000Z" },
    // Approved, but the operator has since removed this player as founder: no stale cover.
    { ...base, requestId: "r-cleared", status: "approved", parkId: "regional-z", parkName: "Z Park", decidedAt: "2026-10-08T15:00:00.000Z" },
  ];
  const { foundingReviews } = await (await call("GET", "/api/game/me")).json() as { foundingReviews: Record<string, unknown> };
  assert.deepEqual(foundingReviews, {
    pending: [{ requestId: "r-pending", parkId: "osm-way-5", osm: { type: "way", id: 5 }, parkName: "Paterson Park", createdAt: "2026-10-08T10:00:00.000Z" }],
    decided: [
      { requestId: "r-approved", status: "approved", parkId: PARK, parkName: "Beacon Hill Park", reason: null, coverUrl: `${origin}/api/parks/${PARK}/cover/${"b".repeat(64)}.jpg`, founderHandle: "sam", decidedAt: "2026-10-08T12:00:00.000Z" },
      { requestId: "r-rejected", status: "rejected", parkId: "regional-x", parkName: "X Park", reason: "There are people in the photo.", coverUrl: null, founderHandle: null, decidedAt: "2026-10-08T13:00:00.000Z" },
      { requestId: "r-superseded", status: "superseded", parkId: "regional-y", parkName: "Y Park", reason: null, coverUrl: null, founderHandle: "bee", decidedAt: "2026-10-08T14:00:00.000Z" },
      { requestId: "r-cleared", status: "approved", parkId: "regional-z", parkName: "Z Park", reason: null, coverUrl: null, founderHandle: null, decidedAt: "2026-10-08T15:00:00.000Z" },
    ],
  });
  store.reviews = Array.from({ length: FOUNDING_DECISIONS_LIMIT + 5 }, (_, index) => ({ ...base, requestId: `r${index}`, status: "rejected" as const, parkId: PARK, parkName: "B", reason: "No.", decidedAt: base.createdAt }));
  const limited = await (await call("GET", "/api/game/me")).json() as { foundingReviews: { decided: unknown[] } };
  assert.equal(limited.foundingReviews.decided.length, FOUNDING_DECISIONS_LIMIT);
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
    // The leader is the flag's handle and seed; crew adds up to 3 more seeds and the size (#170).
    flags: [{ parkId: PARK, handle: "sam", flagSeed: player.flagSeed, since: "2026-10-01T00:00:00.000Z", crew: { size: 5, memberSeeds: ["1111111111111111", "2222222222222222", "3333333333333333"], protectedUntil: null } }],
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

test("stored visits parse their points breakdown, and game_001's shape falls back to the base", () => {
  const stored = { visitId: VISIT.toUpperCase(), parkId: PARK, outcome: "took", pointsEarned: 7, previousHolder: null, flagSince: null, visitedAt: "2026-10-08T17:00:00Z", fell: false };
  assert.deepEqual(visitFromJson({ ...stored, pointsBreakdown: { base: 4, days: 3 } }).pointsBreakdown, { base: 4, days: 3 });
  assert.deepEqual(visitFromJson(stored).pointsBreakdown, { base: 7, days: 0 });
  assert.equal(visitFromJson(stored).visitId, VISIT);
});

test("stored crew outcomes and protected details parse (#170)", () => {
  const stored = { visitId: VISIT, parkId: PARK, outcome: "logged", pointsEarned: 1, pointsBreakdown: { base: 1, days: 0 }, previousHolder: null, flagSince: null, visitedAt: "2026-10-08T17:00:00Z", fell: false };
  assert.equal(visitFromJson(stored).protected, null, "game_002's shape has no protected field");
  const logged = visitFromJson({ ...stored, protected: { until: "2026-10-08T17:30:00Z", leader: { handle: "bee", flagSeed: "fedcba9876543210" }, crewSize: 2 } });
  assert.deepEqual(logged.protected, { until: "2026-10-08T17:30:00.000Z", leader: { handle: "bee", flagSeed: "fedcba9876543210" }, crewSize: 2 });
  assert.equal(visitFromJson({ ...stored, outcome: "joined" }).outcome, "joined");
  assert.throws(() => visitFromJson({ ...stored, outcome: "stolen" }));
});

test("crew codes are normalised to the friend code alphabet", () => {
  assert.equal(normalizeCrewCode("k7q-x2m"), CODE);
  assert.equal(normalizeCrewCode(" K7Q X2M "), CODE);
  for (const bad of ["K7QX2", "K7QX2MM", "K7QX2O", "K7QX21", "K7QXIM", "K7QXLM", "", "x".repeat(65)]) assert.equal(normalizeCrewCode(bad), null, bad);
  assert.deepEqual(validateJoinBody({ visitId: VISIT.toUpperCase(), code: "k7qx2m" }), { visitId: VISIT, code: CODE });
});

test("join bodies are strictly validated before the store is touched", async () => {
  const { call, store } = setup();
  for (const body of [{}, { visitId: VISIT }, { code: CODE }, { visitId: VISIT, code: CODE, parkId: PARK }, { visitId: "nope", code: CODE }, { visitId: VISIT, code: "ABC" }, { visitId: VISIT, code: 123456 }, [VISIT, CODE]]) {
    const response = await call("POST", "/api/game/crews/join", body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const badCode = await call("POST", "/api/game/crews/join", { visitId: VISIT, code: "OOOOOO" });
  assert.equal(await code(badCode), "invalid_code");
  assert.equal(store.joinCalls.length, 0);
  assert.equal((await call("POST", "/api/game/crews/join", { visitId: VISIT, code: CODE }, "cookie-no-csrf")).status, 403);
  assert.equal(store.joinCalls.length, 0);
});

test("joining a crew uses the server clock, returns the visit and crew, and records crew_joined", async () => {
  const { call, store, events } = setup();
  const response = await call("POST", "/api/game/crews/join", { visitId: VISIT, code: "k7q-x2m" });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["status", "visit", "crew"]);
  assert.equal(body.status, "joined");
  assert.deepEqual(body.visit, {
    visitId: VISIT, parkId: PARK, outcome: "joined", pointsEarned: 2, pointsBreakdown: { base: 2, days: 0 }, previousHolder: null,
    flagSince: "2026-10-08T16:30:00.000Z", protected: null,
  });
  assert.deepEqual(body.crew, crew);
  assert.deepEqual(store.joinCalls, [{ accountId: ACCOUNT, code: CODE, visitId: VISIT, now: new Date(NOW).toISOString() }]);
  assert.deepEqual(events, [{ name: "crew_joined", accountId: ACCOUNT, parkId: PARK, pointsEarned: 2, crewSize: 2 }]);

  store.joinResult = { status: "replayed", visit: joinedVisit, crew };
  const replay = await (await call("POST", "/api/game/crews/join", { visitId: VISIT, code: CODE })).json() as Record<string, unknown>;
  assert.equal(replay.status, "joined", "a replay answers like the first join");
  store.joinResult = { status: "already_member", crew };
  const member = await call("POST", "/api/game/crews/join", { visitId: VISIT, code: CODE });
  assert.equal(member.status, 200);
  assert.deepEqual(await member.json(), { status: "already_member", visit: null, crew });
  assert.equal(events.length, 1, "replays and existing members record nothing");
});

test("join refusals map to the documented errors", async () => {
  const cases: Array<[JoinCrewResult, number, string]> = [
    [{ status: "code_not_found" }, 404, "code_not_found"],
    [{ status: "code_expired" }, 410, "code_expired"],
    [{ status: "crew_full" }, 409, "crew_full"],
    [{ status: "already_today" }, 409, "already_today"],
    [{ status: "handle_required" }, 409, "handle_required"],
    [{ status: "account_unavailable" }, 410, "account_deleting"],
    [{ status: "park_not_found" }, 404, "park_not_found"],
    [{ status: "conflict" }, 409, "visit_id_reused"],
  ];
  for (const [result, status, errorCode] of cases) {
    const { call, store, events } = setup();
    store.joinResult = result;
    const response = await call("POST", "/api/game/crews/join", { visitId: VISIT, code: CODE });
    assert.equal(response.status, status, result.status);
    assert.equal(await code(response), errorCode);
    assert.equal(events.length, 0);
  }
});

test("park crew details show the code to members only and record crew_code_shown", async () => {
  const { call, store, events } = setup();
  const response = await call("GET", `/api/game/parks/${PARK}/crew`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { parkId: PARK, crew, serverTime: new Date(NOW).toISOString() });
  assert.deepEqual(store.crewCalls, [{ parkId: PARK, accountId: ACCOUNT, now: new Date(NOW).toISOString() }]);
  assert.deepEqual(events, [{ name: "crew_code_shown", accountId: ACCOUNT, parkId: PARK, crewSize: 2 }]);

  store.crew = { ...crew, member: false, code: null, codeExpiresAt: null };
  assert.equal(((await (await call("GET", `/api/game/parks/${PARK}/crew`)).json()) as { crew: CrewRecord }).crew.code, null);
  store.crew = null;
  assert.deepEqual(await (await call("GET", `/api/game/parks/${PARK}/crew`)).json(), { parkId: PARK, crew: null, serverTime: new Date(NOW).toISOString() });
  assert.equal(events.length, 1, "only a response with a code counts as shown");
  assert.equal((await call("GET", "/api/game/parks/Bad%20Park/crew")).status, 400);
});

test("crew routes group by park in analytics, never one route per park", () => {
  assert.equal(normalizeRoute("GET", `/api/game/parks/${PARK}/crew`), "GET /api/game/parks/:park/crew");
  assert.equal(normalizeRoute("POST", "/api/game/crews/join"), "POST /api/game/crews/join");
});

test("GET /api/game/dex lists visited parks with their visit days for the signed-in account", async () => {
  const { store, call } = setup();
  assert.equal((await call("GET", "/api/game/dex", undefined, "none")).status, 401);
  const response = await call("GET", "/api/game/dex", undefined, "cookie-no-csrf");
  assert.equal(response.status, 200, "reads only need the session");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    parks: [
      { parkId: PARK, visits: 2, days: ["2026-10-01", "2026-10-08"], firstVisitAt: "2026-10-01T18:00:00.000Z", lastVisitAt: "2026-10-08T17:00:00.000Z", hidden: false },
      { parkId: "municipal-hidden", visits: 1, days: ["2026-09-30"], firstVisitAt: "2026-09-30T18:00:00.000Z", lastVisitAt: "2026-09-30T18:00:00.000Z", hidden: true },
    ],
    serverTime: new Date(NOW).toISOString(),
  });
  assert.deepEqual(store.dexCalls, [{ accountId: ACCOUNT, now: new Date(NOW).toISOString() }]);
  assert.equal((await call("POST", "/api/game/dex", {})).status, 405);
});

test("GET /api/game/dex answers 503 where the store cannot list a Dex", async () => {
  const { store, call } = setup();
  (store as { dex?: unknown }).dex = undefined;
  const response = await call("GET", "/api/game/dex");
  assert.equal(response.status, 503);
});
