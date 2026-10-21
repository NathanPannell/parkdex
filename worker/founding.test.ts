import assert from "node:assert/strict";
import test from "node:test";
import { foundingFailure, foundingStatements, type FoundingPlan } from "./founding.ts";

const common = {
  accountId: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  visitId: "33333333-3333-4333-8333-333333333333",
  at: "2026-10-10T18:00:00.000Z",
  photo: { sha256: "a".repeat(64), base64: "AAAA", width: 16, height: 12 },
  moderation: { version: 1 },
};
const existing: FoundingPlan = { kind: "existing", ...common, parkId: "municipal-beacon-hill-park", osm: { type: "way", id: 7 } };
const REQUEST = "44444444-4444-4444-8444-444444444444";

const texts = (statements: { text: string }[]) => statements.map((statement) => statement.text.replace(/\s+/g, " "));

test("an instant founding records the visit and closes pending reviews of the park and its outline", async () => {
  const statements = await foundingStatements(existing, { visit: true, reviewRequestId: null });
  const text = texts(statements);
  assert.match(text[0], /pg_advisory_xact_lock/);
  assert.ok(text.some((line) => /'already_founded'/.test(line)));
  assert.ok(text.some((line) => /'park_hidden'/.test(line)));
  assert.ok(!text.some((line) => /review_not_pending/.test(line)));
  const supersede = statements.find((statement) => /SET status = 'superseded'/.test(statement.text))!;
  assert.deepEqual(supersede.params, ["municipal-beacon-hill-park", common.at, "way", 7, null]);
  assert.match(text.at(-2)!, /kip_game.record_visit/, "the visit comes after the founder row");
  // Then the badges it unlocked (#175), in the same transaction, so the founder badge is announced.
  assert.match(text.at(-1)!, /kip_game.award_badges\(\$1::uuid, \$2::timestamptz, \$3::uuid\) AS badges_unlocked/);
  assert.deepEqual(statements.at(-1)!.params, [common.accountId, common.at, common.visitId]);
  assert.ok(text.indexOf(supersede.text.replace(/\s+/g, " ")) > text.findIndex((line) => /INSERT INTO kip_founders.parks/.test(line)));
});

test("a reviewed founding locks and approves its request, skips the visit and runs the caller's statements last", async () => {
  const after = [{ text: "INSERT INTO kip_analytics.events VALUES ($1)", params: ["x"] }];
  const statements = await foundingStatements(existing, { visit: false, reviewRequestId: REQUEST, after });
  const text = texts(statements);
  assert.match(text[0], /pg_advisory_xact_lock/, "the park lock comes before the request's row lock, as in every founding");
  assert.match(text[1], /FROM kip_founders.review_requests WHERE id = \$1::uuid FOR UPDATE/);
  assert.ok(text.some((line) => /'review_not_pending'/.test(line)));
  assert.ok(text.some((line) => /'account_unavailable'/.test(line)));
  assert.ok(!text.some((line) => /record_visit/.test(line)), "no visit and no flag");
  assert.ok(!text.some((line) => /award_badges/.test(line)), "badges unlock when the player next reads /api/game/me");
  const supersede = statements.find((statement) => /SET status = 'superseded'/.test(statement.text))!;
  assert.equal(supersede.params[4], REQUEST, "the approved request is not superseded");
  const approve = statements.findIndex((statement) => /SET status = 'approved'/.test(statement.text));
  assert.ok(approve > statements.indexOf(supersede));
  assert.deepEqual(statements[approve].params, [REQUEST, common.at, "municipal-beacon-hill-park"]);
  assert.equal(statements.at(-1), after[0]);
});

test("guards raised in the transaction map to founding results", () => {
  const cases: Array<[string, string]> = [
    ["review_not_pending", "review_not_pending"],
    ["account_unavailable", "account_unavailable"],
    ["already_founded", "already_founded"],
    ['duplicate key value violates unique constraint "parks_pkey"', "already_founded"],
    ["park_exists", "park_exists"],
    ["park_hidden", "park_hidden"],
    ["park_missing", "park_missing"],
    ["draft_changed", "blocked"],
    ["visit_conflict", "visit_failed"],
  ];
  for (const [message, status] of cases) assert.equal(foundingFailure(new Error(message)), status, message);
  assert.equal(foundingFailure(new Error("connection reset")), null);
});
