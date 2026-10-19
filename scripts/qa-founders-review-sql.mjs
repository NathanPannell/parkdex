import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Manual review of founding photos (#153) against real PostgreSQL: the full migration inventory
// replayed twice, then the real API routes and the real operator dashboard routes with their SQL
// stores. Only sign-in, OpenStreetMap and the photo model are stand-ins. Covers keeping a rejected
// photo, asking for a review, approving it (publish, founder, cover, bonus, no visit), rejecting
// it, the supersede race against an instant founding, the daily limit, decisions in /api/game/me,
// retention and account deletion. Content triggers check every park, so this runs in its own
// throwaway kip_qa_ database.
const shared = process.env.PGDATABASE;
assert.ok(shared?.startsWith("kip_qa_") || shared === "kip_accounts_qa", "SQL QA requires a dedicated kip_qa_ database");
const owned = `kip_qa_reviews_${randomBytes(8).toString("hex")}`;
const admin = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: shared,
});
admin.on("error", () => undefined);
await admin.connect();
await admin.query(`CREATE DATABASE "${owned}"`);
process.env.PGDATABASE = owned;
const { applyMigration, dbUrl, pool } = await import("./qa-postgres-adapter.mjs");
const { createFeedbackWorker } = await import("../worker/index.ts");
const { publishStatements } = await import("../operator/server/drafts.ts");
const { createDashboardApi } = await import("../operator/server/api.ts");
const { EXIF_GPS_JPEG } = await import("../worker/fixtures/exif-gps-jpeg.ts");
const { DEFAULT_FLAG_THRESHOLDS, PHOTO_FLAGS } = await import("../worker/founderPhoto.ts");
const { createSqlFoundingReviewStore, purgeFoundingPhotos } = await import("../worker/founding-reviews.ts");
const { databaseSqlRunner } = await import("../worker/proposalReview.ts");
const { database } = await import("../worker/db.ts");

const root = new URL("../", import.meta.url);
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ORIGIN = "https://kip.example.test";
const OPERATOR = "https://operator.example.test";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const box = (west, south, east, north) => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];
const multi = (...rings) => ({ type: "MultiPolygon", coordinates: [rings] });
const osmBase = 800_000_000 + Math.floor(Math.random() * 90_000_000);

const MEADOW = {
  type: "way",
  id: osmBase,
  name: "Review Meadow",
  kind: "leisure=park",
  tags: { name: "Review Meadow", leisure: "park" },
  geometry: multi(box(-123.062, 49.088, -123.058, 49.0902)),
  areaM2: 71_000,
};
const IN_MEADOW = { lat: 49.089, lng: -123.0601, accuracyM: 8 };
const GREEN = "municipal-qa-review-green";
const IN_GREEN = { lat: 49.1015, lng: -123.0975, accuracyM: 12 };
const RACE = "municipal-qa-review-race";
const IN_RACE = { lat: 49.1115, lng: -123.0975, accuracyM: 6 };

// The model's answers: each flag's yes, 0.01 unless given.
const answers = (flags = {}) => ({
  model: "qa-model",
  answers: Object.fromEntries(
    PHOTO_FLAGS.map((flag) => [
      flag,
      { choice: (flags[flag] ?? 0.01) > 0.5 ? "yes" : "no", probabilities: { yes: flags[flag] ?? 0.01, no: 1 - (flags[flag] ?? 0.01) } },
    ]),
  ),
});
let photoAnswers = answers({ people: 0.97 });

const players = new Map();
const authStore = {
  async findSession(tokenHash) {
    const accountId = players.get(tokenHash);
    if (!accountId) return null;
    return {
      id: accountId,
      email: `${accountId}@example.test`,
      emailVerified: true,
      displayName: "QA",
      providers: ["email"],
      sessionId: randomUUID(),
      tokenHash,
      csrfHash: null,
      transport: "native",
      expiresAt: "2099-01-01T00:00:00Z",
      absoluteExpiresAt: "2099-02-01T00:00:00Z",
      reauthenticatedAt: null,
    };
  },
};
// 10:00 in Victoria.
let clock = Date.parse("2026-10-10T17:00:00.000Z");
const pending = [];
const worker = createFeedbackWorker({
  auth: { createStore: () => authStore },
  osmClient: {
    async search() {
      return [];
    },
    async feature(ref) {
      return ref.type === MEADOW.type && ref.id === MEADOW.id ? MEADOW : null;
    },
  },
  photoChecker: async () => photoAnswers,
  now: () => clock,
});
const env = {
  DATABASE_URL: dbUrl,
  PUBLIC_APP_URL: ORIGIN,
  AUTH_SESSION_SECRET: "auth-test-secret-".repeat(4),
  SESSION_SECRET: "qa-session-secret-which-is-long-enough",
  EMAIL_MODE: "disabled",
  CONTENT_CHANNEL: "staging",
};
// The operator dashboard's own routes and review store. The dashboard has its own copy of the
// Neon driver under operator/node_modules, which the adapter does not redirect, so the store
// gets the root driver's runner; the SQL is the same.
const dashboard = createDashboardApi({ now: () => clock, foundingReviewStore: () => createSqlFoundingReviewStore(databaseSqlRunner(dbUrl)) });
const operatorEnv = { DATABASE_URL: dbUrl, DASHBOARD_ENVIRONMENT: "staging" };

async function call(method, path, { token, body, headers: extra = {} } = {}) {
  const headers = new Headers({ origin: ORIGIN, ...extra });
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-kip-account-id", players.get(hash(token)));
  }
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, {
    waitUntil: (promise) => {
      pending.push(promise);
    },
  });
  await Promise.all(pending.splice(0));
  return response;
}

function operator(method, path, body) {
  const headers = new Headers();
  if (method !== "GET") headers.set("origin", OPERATOR);
  if (body !== undefined) headers.set("content-type", "application/json");
  return dashboard(new Request(OPERATOR + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), operatorEnv);
}

const photo = { mime: "image/jpeg", base64: Buffer.from(EXIF_GPS_JPEG).toString("base64"), width: 16, height: 12 };
const found = (token, target, position, attemptId = randomUUID()) => call("POST", "/api/parks/found", { token, body: { attemptId, position, target, photo } });
const review = (token, attemptId) => call("POST", "/api/parks/found/review", { token, body: { attemptId } });

async function account(name) {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO kip_account.accounts (id, normalized_email, password_hash) VALUES ($1, $2, $3)", [
    id,
    `reviews-${name}-${id.slice(0, 6)}@example.test`,
    "qa-hash",
  ]);
  await pool.query("INSERT INTO kip_game.players (account_id, handle, flag_seed, created_at) VALUES ($1, $2, kip_game.flag_seed($1), '2026-10-01T00:00:00Z')", [
    id,
    `qa_${name}_${id.slice(0, 4)}`,
  ]);
  players.set(hash(token), id);
  return { id, token, handle: `qa_${name}_${id.slice(0, 4)}` };
}

async function publishPark(id, name, ring) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb)
       VALUES ($1, '{}'::jsonb, $2, $3::jsonb, $4, $4, 'municipal', 'South Coast', $5, $6, 'forest', 'circle', 'common', 1, 'A QA park.') RETURNING updated_at`,
      [id, "a".repeat(64), JSON.stringify(multi(ring)), name, ring[0][1], ring[0][0]],
    );
    for (const statement of publishStatements(id, new Date(rows[0].updated_at).toISOString(), null)) await client.query(statement.text, statement.params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const count = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].count);
const score = async (accountId) =>
  (await pool.query("SELECT score FROM kip_game.player_scores($1) WHERE account_id = $2", [new Date(clock).toISOString(), accountId])).rows[0]?.score;
const json = async (response) => response.json();
const requestRow = async (id) =>
  (await pool.query("SELECT *, octet_length(photo_bytes) AS size FROM kip_founders.review_requests WHERE id = $1", [id])).rows[0];

/** A rejected founding photo and the review request made from it. */
async function rejectedRequest(player, target, position) {
  const attemptId = randomUUID();
  const checked = await json(await found(player.token, target, position, attemptId));
  assert.equal(checked.outcome, "rejected", JSON.stringify(checked));
  const response = await review(player.token, attemptId);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await json(response);
  assert.equal(body.status, "pending");
  return { attemptId, requestId: body.requestId };
}

try {
  const config = JSON.parse(readFileSync(new URL("deployment.json", root), "utf8"));
  const inventory = [
    config.migrationPath,
    ...config.contentSync.supportingMigrationPaths,
    ...config.optionalMigrationPaths,
    ...config.contentSync.migrationPaths,
    ...config.independentMigrationPaths,
  ];
  const position = (name) => inventory.indexOf(`database/migrations/${name}`);
  assert.ok(position("founders_002_reviews.sql") > position("founders_001_init.sql"), "founders_002 replays after founders_001");
  for (const path of inventory) await applyMigration(fileURLToPath(new URL(path, root)));
  for (const path of inventory) await applyMigration(fileURLToPath(new URL(path, root)));
  const constraints = (
    await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'kip_analytics.events'::regclass AND conname IN ('events_event_type_v2_check', 'events_shape_v2_check')`)
  ).rows;
  assert.equal(constraints.length, 2);
  for (const row of constraints) {
    for (const type of ["park_founded", "founder_photo_checked", "founding_review_requested", "founding_review_decided", "flag_planted", "park_viewed"])
      assert.match(row.def, new RegExp(type), `${row.conname} keeps ${type}`);
  }
  await pool.query(
    "INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'Victoria', -123.36, 48.43), (1, 'Nanaimo', -123.94, 49.17) ON CONFLICT DO NOTHING",
  );
  await publishPark(GREEN, "QA Review Green", box(-123.1, 49.1, -123.095, 49.103));
  await publishPark(RACE, "QA Review Race", box(-123.1, 49.11, -123.095, 49.113));
  log("the migration replays after founders_001 and keeps every analytics event type");

  const a = await account("a");
  const b = await account("b");
  const c = await account("c");

  // A rejected photo is kept for a day without its metadata, with the position and the outline.
  const attemptId = randomUUID();
  const rejected = await json(await found(a.token, { osm: { type: "way", id: MEADOW.id } }, IN_MEADOW, attemptId));
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.reviewableUntil, new Date(clock + DAY).toISOString());
  const kept = (await pool.query("SELECT *, encode(photo_bytes, 'escape') AS text FROM kip_founders.check_photos WHERE attempt_id = $1", [attemptId])).rows[0];
  assert.deepEqual(
    [kept.account_id, kept.park_name, kept.latitude, kept.longitude, kept.accuracy_m],
    [a.id, "Review Meadow", IN_MEADOW.lat, IN_MEADOW.lng, IN_MEADOW.accuracyM],
  );
  assert.deepEqual(kept.osm_feature.geometry, MEADOW.geometry);
  assert.ok(!kept.text.includes("GPSLatitude") && !kept.text.includes("QA Camera Maker"), "kept without metadata");
  assert.deepEqual((await json(await found(a.token, { osm: { type: "way", id: MEADOW.id } }, IN_MEADOW, attemptId))).reviewableUntil, rejected.reviewableUntil);

  const meadow = await json(await review(a.token, attemptId));
  assert.equal(meadow.status, "pending");
  const stored = await requestRow(meadow.requestId);
  assert.deepEqual(
    [stored.account_id, stored.attempt_id, stored.park_id, stored.osm_type, Number(stored.osm_id), stored.outcome, stored.flags, stored.status],
    [a.id, attemptId, `osm-way-${MEADOW.id}`, "way", MEADOW.id, "reject", ["people"], "pending"],
  );
  assert.equal(
    stored.photo_sha256,
    hash((await pool.query("SELECT photo_bytes FROM kip_founders.review_requests WHERE id = $1", [meadow.requestId])).rows[0].photo_bytes),
  );
  assert.equal(stored.moderation.answers.people.probabilities.yes, 0.97);
  assert.equal(stored.moderation.answers.verdict, undefined, "only the flags are asked");
  assert.deepEqual(stored.moderation.flagThresholds, { ...DEFAULT_FLAG_THRESHOLDS });
  assert.equal(await count("SELECT count(*) FROM kip_founders.check_photos WHERE attempt_id = $1", [attemptId]), 0, "the request holds the only copy");
  assert.deepEqual(await json(await review(a.token, attemptId)), meadow, "the same attempt answers the same request");
  log("a rejected photo is kept for a day and a review request moves it, with the position, target and answers");

  // A rival request for the same park, and the per-account rules.
  clock += 60_000;
  const rival = await rejectedRequest(b, { osm: { type: "way", id: MEADOW.id } }, IN_MEADOW);
  const second = await json(await found(a.token, { osm: { type: "way", id: MEADOW.id } }, IN_MEADOW));
  assert.equal(second.outcome, "rejected");
  const duplicateAttempt = (await pool.query("SELECT attempt_id FROM kip_founders.check_photos WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1", [a.id]))
    .rows[0].attempt_id;
  const duplicate = await review(a.token, duplicateAttempt);
  assert.equal(duplicate.status, 409);
  assert.equal((await json(duplicate)).code, "review_pending");
  await assert.rejects(
    pool.query(
      `INSERT INTO kip_founders.review_requests (id, account_id, attempt_id, check_id, park_id, park_name, latitude, longitude, accuracy_m, photo_bytes, photo_sha256, photo_width, photo_height, outcome, checked_at)
     SELECT $1, account_id, $2, check_id, park_id, park_name, latitude, longitude, accuracy_m, photo_bytes, photo_sha256, photo_width, photo_height, 'reject', now()
     FROM kip_founders.review_requests WHERE id = $3`,
      [randomUUID(), randomUUID(), meadow.requestId],
    ),
    /review_requests_one_pending_idx/,
    "the unique index backs up one pending request per park",
  );
  log("one pending request per account and park, in the API and the table");

  // Approval through the operator dashboard: publish, founder, cover, bonus, no visit.
  const queue = await json(await operator("GET", "/api/parks/review"));
  assert.equal(queue.available, true, JSON.stringify(queue));
  assert.deepEqual(
    queue.requests.map((row) => row.id),
    [meadow.requestId, rival.requestId],
  );
  assert.deepEqual(queue.counts, { pending: 2, approved: 0, rejected: 0, superseded: 0 });
  const detail = (await json(await operator("GET", `/api/parks/review/${meadow.requestId}`))).request;
  assert.equal(detail.handle, a.handle);
  assert.deepEqual(detail.position, IN_MEADOW);
  assert.deepEqual(detail.geometry, MEADOW.geometry);
  assert.equal(detail.otherPending, 1);
  assert.deepEqual([detail.moderation.threshold, detail.moderation.flagThresholds], [null, { ...DEFAULT_FLAG_THRESHOLDS }]);
  // A request stored before the verdict question was dropped still reads, with its verdict and threshold.
  await pool.query(`UPDATE kip_founders.review_requests SET moderation = $2::jsonb WHERE id = $1`, [
    rival.requestId,
    JSON.stringify({
      version: 1,
      model: "qa-model",
      threshold: 0.8,
      answers: { verdict: { choice: "reject", probabilities: { approve: 0.1, reject: 0.9 } }, ...answers({ people: 0.97 }).answers },
      flags: ["people"],
    }),
  ]);
  const olderDetail = (await json(await operator("GET", `/api/parks/review/${rival.requestId}`))).request;
  assert.deepEqual(
    [olderDetail.moderation.threshold, olderDetail.moderation.flagThresholds, olderDetail.moderation.answers.verdict.probabilities.approve],
    [0.8, null, 0.1],
  );
  const operatorPhoto = await operator("GET", `/api/parks/review/${meadow.requestId}/photo`);
  assert.equal(operatorPhoto.status, 200);
  assert.equal(hash(Buffer.from(await operatorPhoto.arrayBuffer())), stored.photo_sha256);
  const scoreBefore = await score(a.id);
  const visitsBefore = await count("SELECT count(*) FROM kip_game.visits WHERE account_id = $1", [a.id]);
  clock += HOUR;
  const approved = await operator("POST", `/api/parks/review/${meadow.requestId}/approve`);
  assert.equal(approved.status, 200, await approved.clone().text());
  const parkId = `osm-way-${MEADOW.id}`;
  assert.deepEqual(await json(approved), { ok: true, parkId, parkName: "Review Meadow", source: "osm_new" });
  const founder = (await pool.query("SELECT * FROM kip_founders.parks WHERE park_id = $1", [parkId])).rows[0];
  assert.deepEqual(
    [founder.account_id, founder.attempt_id, founder.source, founder.photo_sha256, founder.founded_at.toISOString()],
    [a.id, attemptId, "osm_new", stored.photo_sha256, new Date(clock).toISOString()],
  );
  assert.equal(founder.moderation.review.requestId, meadow.requestId);
  assert.equal(
    (await pool.query("SELECT founder_account_id FROM kip_proposals.parks WHERE published_park_id = $1", [parkId])).rows[0].founder_account_id,
    a.id,
  );
  assert.equal(await score(a.id), scoreBefore + 24, "the founder bonus counts");
  assert.equal(await count("SELECT count(*) FROM kip_game.visits WHERE account_id = $1", [a.id]), visitsBefore, "no visit is recorded");
  assert.equal(await count("SELECT count(*) FROM kip_game.tenures WHERE park_id = $1", [parkId]), 0, "no flag is planted");
  const after = await requestRow(meadow.requestId);
  assert.deepEqual([after.status, after.founded_park_id, after.decided_at.toISOString()], ["approved", parkId, new Date(clock).toISOString()]);
  assert.equal((await requestRow(rival.requestId)).status, "superseded", "the rival request closed in the same transaction");
  const decided = (
    await pool.query(
      "SELECT event_type, account_id, park_id, route, environment, properties FROM kip_analytics.events WHERE event_type IN ('founding_review_decided', 'park_founded') AND park_id = $1 ORDER BY event_type",
      [parkId],
    )
  ).rows;
  assert.deepEqual(
    decided.map((row) => [row.event_type, row.account_id, row.route, row.environment]),
    [
      ["founding_review_decided", a.id, "POST /operator/parks/review/:id/approve", "staging"],
      ["park_founded", a.id, "POST /operator/parks/review/:id/approve", "staging"],
    ],
  );
  assert.equal(decided[0].properties.decision, "approved");
  assert.equal(decided[1].properties.via, "review");
  const cover = await call("GET", `/api/parks/${parkId}/cover/${stored.photo_sha256}.jpg`);
  assert.equal(cover.status, 200, "the approved photo is the public cover");
  const twice = await operator("POST", `/api/parks/review/${meadow.requestId}/approve`);
  assert.equal(twice.status, 409);
  assert.equal((await json(twice)).error.code, "review_decided");
  log("approval founds the park in one transaction with the photo as cover and the bonus, no visit or flag, and supersedes rivals");

  // The player sees each decision once.
  const me = await json(await call("GET", "/api/game/me", { token: a.token }));
  assert.deepEqual(me.foundingReviews.pending, []);
  assert.deepEqual(me.foundingReviews.decided, [
    {
      requestId: meadow.requestId,
      status: "approved",
      parkId,
      parkName: "Review Meadow",
      reason: null,
      coverUrl: `${ORIGIN}/api/parks/${parkId}/cover/${stored.photo_sha256}.jpg`,
      founderHandle: a.handle,
      decidedAt: new Date(clock).toISOString(),
    },
  ]);
  const meB = await json(await call("GET", "/api/game/me", { token: b.token }));
  assert.deepEqual(
    meB.foundingReviews.decided.map((row) => [row.status, row.founderHandle, row.coverUrl]),
    [["superseded", a.handle, null]],
  );
  const seen = await json(await call("POST", "/api/parks/found/review/seen", { token: a.token, body: { requestIds: [meadow.requestId, rival.requestId] } }));
  assert.deepEqual(seen, { seen: [meadow.requestId] }, "only the caller's own decisions");
  assert.deepEqual((await json(await call("GET", "/api/game/me", { token: a.token }))).foundingReviews, { pending: [], decided: [] });
  log("me lists decisions until the app marks them seen");

  // Rejection with a preset reason.
  const green = await rejectedRequest(c, { parkId: GREEN }, IN_GREEN);
  const meC = await json(await call("GET", "/api/game/me", { token: c.token }));
  assert.deepEqual(
    meC.foundingReviews.pending.map((row) => [row.requestId, row.parkId, row.osm, row.parkName]),
    [[green.requestId, GREEN, null, "QA Review Green"]],
  );
  const refused = await operator("POST", `/api/parks/review/${green.requestId}/reject`, { reasonCode: "people" });
  assert.equal(refused.status, 200, await refused.clone().text());
  const greenRow = await requestRow(green.requestId);
  assert.deepEqual([greenRow.status, greenRow.reason_code, greenRow.decision_reason], ["rejected", "people", "There are people in the photo."]);
  assert.equal(await count("SELECT count(*) FROM kip_founders.parks WHERE park_id = $1", [GREEN]), 0);
  assert.equal(
    await count(
      "SELECT count(*) FROM kip_analytics.events WHERE event_type = 'founding_review_decided' AND properties->>'decision' = 'rejected' AND properties->>'reason_code' = 'people'",
    ),
    1,
  );
  assert.deepEqual(
    (await json(await call("GET", "/api/game/me", { token: c.token }))).foundingReviews.decided.map((row) => [row.status, row.reason]),
    [["rejected", "There are people in the photo."]],
  );
  assert.equal((await operator("POST", `/api/parks/review/${green.requestId}/approve`)).status, 409);
  log("rejection stores the reason the player reads and founds nothing");

  // The supersede race: an instant founding closes a pending request in its own transaction,
  // and an approval racing an instant founding leaves exactly one founder.
  photoAnswers = answers({ lighting: 0.9 });
  const raced = await rejectedRequest(c, { parkId: GREEN }, IN_GREEN);
  photoAnswers = answers();
  const instant = await found(b.token, { parkId: GREEN }, IN_GREEN);
  assert.equal(instant.status, 200, await instant.clone().text());
  assert.equal((await requestRow(raced.requestId)).status, "superseded");
  assert.equal((await requestRow(raced.requestId)).decided_at.toISOString(), new Date(clock).toISOString());
  const late = await operator("POST", `/api/parks/review/${raced.requestId}/approve`);
  assert.equal(late.status, 409);
  assert.equal((await json(late)).error.code, "review_decided");

  photoAnswers = answers({ people: 0.9 });
  const racers = await Promise.all([account("r1"), account("r2")]);
  const contested = await rejectedRequest(racers[0], { parkId: RACE }, IN_RACE);
  photoAnswers = answers();
  const [operatorResponse, instantResponse] = await Promise.all([
    operator("POST", `/api/parks/review/${contested.requestId}/approve`),
    found(racers[1].token, { parkId: RACE }, IN_RACE),
  ]);
  assert.deepEqual([operatorResponse.status, instantResponse.status].sort(), [200, 409]);
  assert.equal(await count("SELECT count(*) FROM kip_founders.parks WHERE park_id = $1", [RACE]), 1);
  const winner = (await pool.query("SELECT account_id FROM kip_founders.parks WHERE park_id = $1", [RACE])).rows[0].account_id;
  const contestedStatus = (await requestRow(contested.requestId)).status;
  assert.equal(contestedStatus, winner === racers[0].id ? "approved" : "superseded", "the request agrees with whoever founded the park");
  log("an instant founding supersedes pending requests in its transaction, and a race leaves one founder");

  // Three requests a Victoria day.
  photoAnswers = answers({ lighting: 0.9 });
  const limiter = await account("limit");
  for (const name of ["QA Limit One", "QA Limit Two", "QA Limit Three", "QA Limit Four"]) {
    const id = `municipal-qa-review-${name.toLowerCase().replace(/\s+/g, "-")}`;
    const index = ["QA Limit One", "QA Limit Two", "QA Limit Three", "QA Limit Four"].indexOf(name);
    await publishPark(id, name, box(-123.2, 49.2 + index * 0.01, -123.195, 49.203 + index * 0.01));
    const attempt = randomUUID();
    assert.equal(
      (await json(await found(limiter.token, { parkId: id }, { lat: 49.2015 + index * 0.01, lng: -123.1975, accuracyM: 5 }, attempt))).outcome,
      "rejected",
    );
    const response = await review(limiter.token, attempt);
    if (index < 3) assert.equal(response.status, 200, name);
    else {
      assert.equal(response.status, 429);
      assert.equal((await json(response)).code, "rate_limited_review");
      // 07:00 UTC is midnight in Victoria: the next local day allows more.
      clock = Date.parse("2026-10-11T07:00:00.000Z");
      assert.equal((await review(limiter.token, attempt)).status, 200, "a new Victoria day");
    }
  }
  const requested = await count("SELECT count(*) FROM kip_analytics.events WHERE event_type = 'founding_review_requested' AND account_id = $1", [limiter.id]);
  assert.equal(requested, 4);
  log("3 requests a Victoria day, and founding_review_requested is stored");

  // Retention: kept check photos after a day, decided requests' photos after 90 days.
  photoAnswers = answers({ people: 0.97 });
  const stale = randomUUID();
  await found(c.token, { osm: { type: "way", id: MEADOW.id } }, IN_MEADOW, stale);
  assert.equal(await count("SELECT count(*) FROM kip_founders.check_photos WHERE attempt_id = $1", [stale]), 0, "a founded park keeps nothing for review");
  const keptAttempt = randomUUID();
  await publishPark("municipal-qa-review-kept", "QA Kept Green", box(-123.3, 49.3, -123.295, 49.303));
  await found(c.token, { parkId: "municipal-qa-review-kept" }, { lat: 49.3015, lng: -123.2975, accuracyM: 5 }, keptAttempt);
  assert.equal(await count("SELECT count(*) FROM kip_founders.check_photos WHERE attempt_id = $1", [keptAttempt]), 1);
  // What the daily retention route runs (worker/index.ts), through database() like the API.
  const sql = database(dbUrl);
  const purge = () => purgeFoundingPhotos((text, params) => sql.query(text, params), clock);
  clock += DAY - 1000;
  await purge();
  assert.equal(await count("SELECT count(*) FROM kip_founders.check_photos WHERE attempt_id = $1", [keptAttempt]), 1, "still inside the day");
  clock += 2000;
  const purged = await purge();
  assert.ok(purged.deleted >= 1, JSON.stringify(purged));
  assert.equal(await count("SELECT count(*) FROM kip_founders.check_photos WHERE attempt_id = $1", [keptAttempt]), 0);
  assert.equal(await count("SELECT count(*) FROM kip_founders.photo_checks WHERE attempt_id = $1", [keptAttempt]), 1, "the check itself stays for analytics");
  const expired = await review(c.token, keptAttempt);
  assert.equal(expired.status, 410);
  assert.equal((await json(expired)).code, "photo_expired");

  const pendingIds = (await pool.query("SELECT id FROM kip_founders.review_requests WHERE status = 'pending'")).rows.map((row) => row.id);
  assert.ok(pendingIds.length > 0);
  clock += 91 * DAY;
  const old = await purge();
  assert.ok(old.deleted >= 3, JSON.stringify(old));
  const greenPurged = await requestRow(green.requestId);
  assert.deepEqual([greenPurged.size, greenPurged.photo_purged_at?.toISOString()], [null, new Date(clock).toISOString()]);
  assert.equal((await requestRow(meadow.requestId)).size, null, "the approved request drops its copy");
  assert.equal(
    await count("SELECT count(*) FROM kip_founders.parks WHERE park_id = $1 AND photo_sha256 = $2", [parkId, stored.photo_sha256]),
    1,
    "the approved photo lives on as the cover",
  );
  assert.equal(
    await count("SELECT count(*) FROM kip_founders.review_requests WHERE id = ANY($1::uuid[]) AND photo_bytes IS NOT NULL", [pendingIds]),
    pendingIds.length,
    "pending requests keep their photo",
  );
  assert.equal((await operator("GET", `/api/parks/review/${green.requestId}/photo`)).status, 404);
  assert.deepEqual(await purgeFoundingPhotos((text, params) => pool.query(text, params).then((result) => result.rows), clock), {
    deleted: 0,
    remainingExpired: 0,
  });
  log("retention deletes kept photos after a day and decided requests' photos after 90 days, never a pending one");

  await pool.query("DELETE FROM kip_account.accounts WHERE id = $1", [c.id]);
  assert.equal(await count("SELECT count(*) FROM kip_founders.review_requests WHERE account_id = $1", [c.id]), 0);
  assert.equal(await count("SELECT count(*) FROM kip_founders.check_photos WHERE account_id = $1", [c.id]), 0);
  log("deleting an account removes its requests and kept photos");
} finally {
  await Promise.all(pending.splice(0)).catch(() => undefined);
  // pool.end() resolves before its connections close; the adapter ignores the server ending them
  // when the database is dropped WITH (FORCE) below.
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${owned}" WITH (FORCE)`);
  await admin.end();
}
