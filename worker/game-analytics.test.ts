import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createFeedbackWorker } from "./index.js";
import type { AccountAuthStore, StoredSession } from "./accounts/auth-store.js";
import type { GameStore, RecordVisitResult } from "./game-store.js";
import type { RequestContext } from "./requestContext.js";

const origin = "https://kip.example.test";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const INSTALLATION = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
const PARK = "municipal-beacon-hill-park";
const bearer = "b".repeat(43);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const session: StoredSession = {
  id: ACCOUNT,
  email: "player@example.test",
  emailVerified: true,
  displayName: "Player",
  providers: ["email"],
  sessionId: "22222222-2222-4222-8222-222222222222",
  tokenHash: hash(bearer),
  csrfHash: null,
  transport: "native",
  expiresAt: "2099-01-01T00:00:00Z",
  absoluteExpiresAt: "2099-02-01T00:00:00Z",
  reauthenticatedAt: null,
};
const authStore = {
  async findSession(tokenHash: string) {
    return tokenHash === hash(bearer) ? session : null;
  },
} as unknown as AccountAuthStore;

function visitResult(outcome: "took" | "planted", fell: boolean): RecordVisitResult {
  return {
    status: "recorded",
    visit: {
      visitId: "33333333-3333-4333-8333-333333333333",
      parkId: PARK,
      outcome,
      pointsEarned: outcome === "took" ? 4 : 6,
      pointsBreakdown: { base: outcome === "took" ? 4 : 6, days: 0 },
      previousHolder: null,
      flagSince: "2026-10-08T17:00:00.000Z",
      visitedAt: "2026-10-08T17:00:00.000Z",
      fell,
      protected: null,
    },
  };
}

function setup(result: RecordVisitResult) {
  const written: RequestContext[] = [];
  const pending: Promise<unknown>[] = [];
  const store = {
    async recordVisit() {
      return result;
    },
    async leaderboard() {
      return [];
    },
    async markTakeoversSeen() {
      return { handle: "sam", flagSeed: "0123456789abcdef", createdAt: "2026-10-01T00:00:00.000Z", takeoversSeenAt: null };
    },
  } as unknown as GameStore;
  const worker = createFeedbackWorker({
    auth: { createStore: () => authStore },
    game: { createStore: () => store, now: () => Date.parse("2026-10-08T17:00:00.000Z") },
    analytics: () => ({
      async write(context) {
        written.push(context);
      },
    }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const headers = new Headers({ origin, authorization: `Bearer ${bearer}`, "x-kip-account-id": ACCOUNT, "x-kip-installation-id": INSTALLATION });
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await worker.fetch(
      new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      {
        PUBLIC_APP_URL: origin,
        DATABASE_URL: "postgresql://unused:unused@ep-test.us-west-2.aws.neon.tech/unused",
        AUTH_SESSION_SECRET: "auth-test-secret-".repeat(4),
        EMAIL_MODE: "disabled",
      },
      {
        waitUntil: (promise) => {
          pending.push(promise);
        },
      },
    );
    await Promise.all(pending.splice(0));
    return response;
  };
  return { written, call };
}

test("a takeover that also closed a fallen flag records flag_fell and flag_taken for the account", async () => {
  const { written, call } = setup(visitResult("took", true));
  const response = await call("POST", "/api/game/visits", { visitId: "33333333-3333-4333-8333-333333333333", parkId: PARK });
  assert.equal(response.status, 200);
  assert.equal(written.length, 1);
  const [context] = written;
  assert.equal(context.accountId, ACCOUNT);
  assert.equal(context.installationId, INSTALLATION);
  assert.equal(context.route, "POST /api/game/visits");
  assert.deepEqual(
    context.events.map((event) => [event.type, event.parkId, event.properties]),
    [
      ["flag_fell", PARK, null],
      ["flag_taken", PARK, { points_earned: 4 }],
    ],
  );
});

test("leaderboard views and seen takeover messages are recorded", async () => {
  const { written, call } = setup(visitResult("planted", false));
  assert.equal((await call("GET", "/api/game/leaderboard")).status, 200);
  assert.equal((await call("POST", "/api/game/takeovers/seen", { at: "2026-10-08T16:00:00.000Z" })).status, 200);
  assert.deepEqual(
    written.map((context) => context.events.map((event) => event.type)),
    [["leaderboard_viewed"], ["takeover_message_seen"]],
  );
});
