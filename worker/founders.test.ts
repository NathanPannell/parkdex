import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createFeedbackWorker, type WorkerEnvironment } from "./index.ts";
import type { AccountAuthStore, StoredSession } from "./accounts/auth-store.ts";
import { EXIF_GPS_JPEG } from "./fixtures/exif-gps-jpeg.ts";
import type { PhotoAnswers, PhotoChecker } from "./founderPhoto.ts";
import { DEFAULT_FLAG_THRESHOLDS, PHOTO_FLAGS } from "./founderPhoto.ts";
import { CHECKS_PER_HOUR, FOUNDED_PER_DAY, founderVisitId, REVIEW_KEEP_MS, REVIEWS_PER_DAY } from "./founders.ts";
import type {
  CatalogueParkRecord, CheckRecord, FoundedRecord, FounderInfo, FoundersStore, FoundExistingInput, FoundOsmInput, FoundResult, KeptAttempt, ParkSummaryRecord,
  RequestReviewResult, ReviewStatus,
} from "./founders-store.ts";
import type { MultiPolygon, OsmClient, OsmFeature, Position } from "./osmParks.ts";
import { pointInMultiPolygon } from "./osmParks.ts";
import { normalizeRoute, type RequestContext } from "./requestContext.ts";

const origin = "https://kip.example.test";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-10-08T17:00:00.000Z");
const bearer = "b".repeat(43);
const otherBearer = "o".repeat(43);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const env: WorkerEnvironment = {
  PUBLIC_APP_URL: origin,
  DATABASE_URL: "postgresql://unused:unused@ep-test.us-west-2.aws.neon.tech/unused",
  AUTH_SESSION_SECRET: "auth-test-secret-".repeat(4),
  SESSION_SECRET: "test-session-secret-which-is-long-enough",
  EMAIL_MODE: "disabled",
};

function session(id: string, token: string): StoredSession {
  return {
    id, email: `${id}@example.test`, emailVerified: true, displayName: "Player", providers: ["email"],
    sessionId: randomUUID(), tokenHash: hash(token), csrfHash: null, transport: "native",
    expiresAt: "2099-01-01T00:00:00Z", absoluteExpiresAt: "2099-02-01T00:00:00Z", reauthenticatedAt: null,
  };
}
const authStore = {
  async findSession(tokenHash: string) {
    if (tokenHash === hash(bearer)) return session(ACCOUNT, bearer);
    if (tokenHash === hash(otherBearer)) return session(OTHER, otherBearer);
    return null;
  },
} as unknown as AccountAuthStore;

const box = (west: number, south: number, east: number, north: number): Position[] =>
  [[west, south], [east, south], [east, north], [west, north], [west, south]];
const PATERSON_OUTLINE: MultiPolygon = { type: "MultiPolygon", coordinates: [[box(-123.062, 49.088, -123.058, 49.0902)]] };
const PATERSON: OsmFeature = {
  type: "way", id: 23938892, name: "Paterson Park", kind: "leisure=park", tags: { name: "Paterson Park", leisure: "park" }, geometry: PATERSON_OUTLINE, areaM2: 71_000,
};
const UNNAMED: OsmFeature = { ...PATERSON, id: 5, name: null, tags: { leisure: "garden" }, kind: "leisure=garden" };
const BEACON = "municipal-beacon-hill-park";
const BEACON_OUTLINE: MultiPolygon = { type: "MultiPolygon", coordinates: [[box(-123.37, 48.41, -123.36, 48.42)]] };
const INSIDE = { lat: 49.089, lng: -123.0601, accuracyM: 8 };
const IN_BEACON = { lat: 48.415, lng: -123.365, accuracyM: 8 };
const PHOTO = { mime: "image/jpeg", base64: Buffer.from(EXIF_GPS_JPEG).toString("base64"), width: 16, height: 12 };

/** The model's answers: each flag's yes, 0.01 unless given. */
function flagged(flags: Partial<Record<(typeof PHOTO_FLAGS)[number], number>> = {}): PhotoAnswers {
  return {
    model: "openai/gpt-6-luna-decisions",
    answers: Object.fromEntries(PHOTO_FLAGS.map((flag) => {
      const p = flags[flag] ?? 0.01;
      return [flag, { choice: p > 0.5 ? "yes" : "no", probabilities: { yes: p, no: 1 - p } }];
    })),
  };
}

class MemoryFoundersStore implements FoundersStore {
  catalogue = new Map<string, CatalogueParkRecord>([[BEACON, { id: BEACON, name: "Beacon Hill Park", category: "municipal", boundary: BEACON_OUTLINE }]]);
  hiddenIds = new Set<string>();
  handles = new Map<string, string>([[ACCOUNT, "sam"], [OTHER, "bee"]]);
  founded = new Map<string, { accountId: string; attemptId: string; sha256: string; bytes: Uint8Array; foundedAt: string; parkName: string; visit: FoundedRecord["visit"] }>();
  checks: Array<{ accountId: string; attemptId: string; parkId: string; osm: { type: string; id: number } | null; outcome: CheckRecord["outcome"]; flags: string[]; photoSha256: string; at: string; moderation: unknown }> = [];
  /** Photos of rejected checks (and older unsure ones), kept for a review, by attempt. */
  kept = new Map<string, { accountId: string; at: string; keep: KeptAttempt }>();
  requests: Array<{ id: string; accountId: string; attemptId: string; parkId: string; status: ReviewStatus; createdAt: string; seenAt: string | null }> = [];
  osmFoundings: FoundOsmInput[] = [];
  existingFoundings: FoundExistingInput[] = [];
  visits: Array<{ accountId: string; parkId: string; at: string }> = [];
  /** Runs before a founding transaction, to stage a race. */
  beforeFound?: () => void;

  async catalogueParks(parkIds: string[]) {
    return new Map(parkIds.filter((id) => this.catalogue.has(id)).map((id) => [id, this.catalogue.get(id)!]));
  }
  async hidden(parkIds: string[]) { return new Set(parkIds.filter((id) => this.hiddenIds.has(id))); }
  async founders(parkIds: string[]) {
    const result = new Map<string, FounderInfo>();
    for (const id of parkIds) {
      const row = this.founded.get(id);
      if (row) result.set(id, { handle: this.handles.get(row.accountId) ?? null, foundedAt: row.foundedAt, photoSha256: row.sha256 });
    }
    return result;
  }
  async hasHandle(accountId: string) { return this.handles.has(accountId); }
  async usage(accountId: string, now: string) {
    const hour = Date.parse(now) - 3_600_000, day = Date.parse(now) - 86_400_000;
    return {
      checksLastHour: this.checks.filter((check) => check.accountId === accountId && Date.parse(check.at) > hour).length,
      foundedLastDay: [...this.founded.values()].filter((row) => row.accountId === accountId && Date.parse(row.foundedAt) > day).length,
    };
  }
  async attempt(accountId: string, attemptId: string) {
    const entry = [...this.founded.entries()].find(([, row]) => row.accountId === accountId && row.attemptId === attemptId);
    const check = this.checks.filter((row) => row.accountId === accountId && row.attemptId === attemptId && row.outcome !== "unavailable").at(-1);
    const kept = this.kept.get(attemptId);
    return {
      founded: entry ? { parkId: entry[0], parkName: entry[1].parkName, photoSha256: entry[1].sha256, founderPoints: 24, visit: entry[1].visit } : null,
      check: check ? { outcome: check.outcome, flags: check.flags, photoSha256: check.photoSha256, keptAt: kept?.accountId === accountId ? kept.at : null } : null,
    };
  }
  async recordCheck(input: Parameters<FoundersStore["recordCheck"]>[0]) {
    this.checks.push({ accountId: input.accountId, attemptId: input.attemptId, parkId: input.parkId, osm: input.osm, outcome: input.outcome, flags: input.flags, photoSha256: input.photoSha256, at: input.at, moderation: input.moderation });
    if (input.keep) this.kept.set(input.attemptId, { accountId: input.accountId, at: input.at, keep: input.keep });
  }
  private found(parkId: string, parkName: string, input: FoundOsmInput | FoundExistingInput): FoundResult {
    this.beforeFound?.();
    if (this.founded.has(parkId)) return { status: "already_founded" };
    const planted = !this.visits.some((visit) => visit.parkId === parkId);
    const visit = {
      visitId: input.visitId, parkId, outcome: planted ? "planted" as const : "took" as const,
      pointsEarned: planted ? 6 : 4, pointsBreakdown: { base: planted ? 6 : 4, days: 0 },
      previousHolder: planted ? null : { handle: "bee", flagSeed: "fedcba9876543210" }, flagSince: input.at, visitedAt: input.at, fell: false, protected: null,
    };
    this.visits.push({ accountId: input.accountId, parkId, at: input.at });
    for (const request of this.requests) if (request.parkId === parkId && request.status === "pending") request.status = "superseded";
    this.founded.set(parkId, {
      accountId: input.accountId, attemptId: input.attemptId, sha256: input.photo.sha256, bytes: new Uint8Array(Buffer.from(input.photo.base64, "base64")),
      foundedAt: input.at, parkName, visit,
    });
    return { status: "founded", record: { parkId, parkName, photoSha256: input.photo.sha256, founderPoints: 24, visit } };
  }
  async foundOsm(input: FoundOsmInput) {
    this.osmFoundings.push(input);
    if (this.catalogue.has(input.park.id)) return { status: "park_exists" as const };
    const result = this.found(input.park.id, input.park.name, input);
    if (result.status === "founded") this.catalogue.set(input.park.id, { id: input.park.id, name: input.park.name, category: input.park.category, boundary: input.park.geometry });
    return result;
  }
  async foundExisting(input: FoundExistingInput) {
    this.existingFoundings.push(input);
    const park = this.catalogue.get(input.parkId);
    if (!park) return { status: "park_missing" as const };
    return this.found(input.parkId, park.name, input);
  }
  async cover(parkId: string, sha256: string) {
    const row = this.founded.get(parkId);
    return row && row.sha256 === sha256 ? row.bytes : null;
  }
  async summary(parkId: string, accountId: string | null): Promise<ParkSummaryRecord | null> {
    if (!this.catalogue.has(parkId)) return null;
    const visits = this.visits.filter((visit) => visit.parkId === parkId);
    const founder = (await this.founders([parkId])).get(parkId) ?? null;
    return { founder, total: visits.length + 2, last30Days: visits.length + 1, mine: accountId ? visits.filter((visit) => visit.accountId === accountId).length : null };
  }
  async reviewAttempt(accountId: string, attemptId: string) {
    const request = this.requests.find((row) => row.accountId === accountId && row.attemptId === attemptId);
    const check = this.checks.filter((row) => row.accountId === accountId && row.attemptId === attemptId).at(-1);
    return {
      request: request ? { id: request.id, status: request.status } : null,
      check: check ? { outcome: check.outcome, flags: check.flags, parkId: check.parkId, osm: check.osm, kept: this.kept.get(attemptId)?.accountId === accountId } : null,
    };
  }
  async requestReview(input: Parameters<FoundersStore["requestReview"]>[0]): Promise<RequestReviewResult> {
    const day = (at: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date(at));
    if (this.requests.some((row) => row.attemptId === input.attemptId)) return "exists";
    if (this.kept.get(input.attemptId)?.accountId !== input.accountId) return "expired";
    if (this.founded.has(input.parkId)) return "already_founded";
    if (this.requests.some((row) => row.accountId === input.accountId && row.parkId === input.parkId && row.status === "pending")) return "pending";
    if (this.requests.filter((row) => row.accountId === input.accountId && day(row.createdAt) === day(input.at)).length >= input.perDay) return "limited";
    this.requests.push({ id: input.id, accountId: input.accountId, attemptId: input.attemptId, parkId: input.parkId, status: "pending", createdAt: input.at, seenAt: null });
    this.kept.delete(input.attemptId);
    return "created";
  }
  async markReviewsSeen(accountId: string, requestIds: string[], at: string) {
    const changed = this.requests.filter((row) => row.accountId === accountId && requestIds.includes(row.id) && row.status !== "pending" && !row.seenAt);
    for (const row of changed) row.seenAt = at;
    return changed.map((row) => row.id).sort();
  }
  runner(): never { throw new Error("not used"); }
}

function osmClient(features: OsmFeature[]): OsmClient {
  return {
    async search() { return []; },
    async feature(ref) { return features.find((feature) => feature.type === ref.type && feature.id === ref.id) ?? null; },
  };
}

function setup(options: { answers?: PhotoAnswers | null | "unconfigured"; features?: OsmFeature[]; catalogueNearby?: { id: string; name: string; lat: number; lng: number; boundary: MultiPolygon | null }[] } = {}) {
  const store = new MemoryFoundersStore();
  const written: RequestContext[] = [];
  const pending: Promise<unknown>[] = [];
  const photoCalls: Parameters<PhotoChecker>[0][] = [];
  const answers = options.answers === undefined ? flagged() : options.answers;
  const checker: PhotoChecker = async (input) => {
    photoCalls.push(input);
    return answers === "unconfigured" ? null : answers;
  };
  const worker = createFeedbackWorker({
    auth: { createStore: () => authStore },
    createFoundersStore: () => store,
    createProposalReviewStore: () => ({ nearbyParks: async () => (options.catalogueNearby ?? []).map((park) => ({ ...park, region: "South Coast" })) }) as never,
    osmClient: osmClient(options.features ?? [PATERSON, UNNAMED]),
    photoChecker: answers === "unconfigured" ? null : checker,
    now: () => NOW,
    analytics: () => ({ async write(context) { written.push(context); } }),
  });
  const call = async (method: string, path: string, body?: unknown, auth: "bearer" | "other" | "none" = "bearer", headers: Record<string, string> = {}) => {
    const requestHeaders = new Headers({ origin, ...headers });
    if (body !== undefined) requestHeaders.set("content-type", "application/json");
    if (auth !== "none") {
      requestHeaders.set("authorization", `Bearer ${auth === "bearer" ? bearer : otherBearer}`);
      requestHeaders.set("x-kip-account-id", auth === "bearer" ? ACCOUNT : OTHER);
    }
    const response = await worker.fetch(new Request(origin + path, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) }), env,
      { waitUntil: (promise) => { pending.push(promise); } });
    await Promise.all(pending.splice(0));
    return response;
  };
  const found = (overrides: Record<string, unknown> = {}, auth: "bearer" | "other" | "none" = "bearer") =>
    call("POST", "/api/parks/found", { attemptId: randomUUID(), position: INSIDE, target: { osm: { type: "way", id: PATERSON.id } }, photo: PHOTO, ...overrides }, auth);
  return { store, written, photoCalls, call, found };
}

async function body(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test("founding an OpenStreetMap park publishes it, stores the photo without metadata, records the visit and pays the bonus", async () => {
  const { store, written, photoCalls, found } = setup();
  const attemptId = randomUUID();
  const response = await found({ attemptId });
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(result.outcome, "founded");
  assert.deepEqual(result.park, { id: "osm-way-23938892", name: "Paterson Park" });
  assert.match(result.coverUrl, new RegExp(`^${origin}/api/parks/osm-way-23938892/cover/[0-9a-f]{64}\\.jpg$`));
  assert.equal(result.founderPoints, 24);
  assert.deepEqual(Object.keys(result.visit).sort(), ["flagSince", "outcome", "parkId", "pointsBreakdown", "pointsEarned", "previousHolder", "protected", "visitId"]);
  assert.equal(result.visit.outcome, "planted");
  assert.equal(result.visit.visitId, await founderVisitId(attemptId));

  // The model and the store only ever see the photo without its EXIF, XMP and comment.
  const seen = Buffer.from(photoCalls[0].jpeg).toString("latin1");
  assert.ok(!seen.includes("QA Camera Maker") && !seen.includes("GPSLatitude") && !seen.includes("QA secret comment"));
  assert.equal(photoCalls[0].parkName, "Paterson Park");
  const stored = store.founded.get("osm-way-23938892")!;
  assert.ok(!Buffer.from(stored.bytes).toString("latin1").includes("QA Camera Maker"));
  assert.equal(stored.sha256, createHash("sha256").update(stored.bytes).digest("hex"));

  // The park is published at a point inside the outline, never at the founder's position.
  const [founding] = store.osmFoundings;
  assert.ok(pointInMultiPolygon([founding.park.lng, founding.park.lat], PATERSON_OUTLINE));
  assert.notDeepEqual([founding.park.lng, founding.park.lat], [INSIDE.lng, INSIDE.lat]);
  assert.equal(founding.park.region, "British Columbia");
  assert.equal(founding.park.category, "municipal");
  assert.deepEqual(founding.osm, { type: "way", id: PATERSON.id });
  assert.equal(founding.proposal.moderation.version, 2);
  assert.deepEqual(founding.proposal.moderation.flagThresholds, DEFAULT_FLAG_THRESHOLDS);
  assert.equal("threshold" in founding.proposal.moderation, false, "there is no overall approve threshold");
  assert.deepEqual(store.checks[0].moderation, {
    version: 2, checkedAt: new Date(NOW).toISOString(), model: "openai/gpt-6-luna-decisions", flagThresholds: DEFAULT_FLAG_THRESHOLDS, answers: flagged().answers, flags: [],
  });
  assert.ok(!JSON.stringify(founding.proposal.moderation).includes(String(INSIDE.lat)), "the audit record never holds the position");
  assert.deepEqual(store.checks.map((check) => [check.outcome, check.parkId]), [["approve", "osm-way-23938892"]]);

  assert.deepEqual(written[0].events.map((event) => [event.type, event.parkId, event.properties]), [
    ["founder_photo_checked", "osm-way-23938892", { outcome: "approve", flags: "", source: "osm_new" }],
    ["park_founded", "osm-way-23938892", { source: "osm_new" }],
    ["flag_planted", "osm-way-23938892", { points_earned: 6 }],
  ]);
  assert.equal(written[0].route, "POST /api/parks/found");
});

test("a retry with the same attempt returns the founding without a second check", async () => {
  const { store, photoCalls, found } = setup();
  const attemptId = randomUUID();
  const first = await body(await found({ attemptId }));
  const again = await found({ attemptId });
  assert.equal(again.status, 200);
  assert.deepEqual(await body(again), first);
  assert.equal(photoCalls.length, 1);
  assert.equal(store.osmFoundings.length, 1);
  const otherPhoto = await found({ attemptId, photo: { ...PHOTO, base64: Buffer.from(stripTail(EXIF_GPS_JPEG)).toString("base64") } });
  assert.equal(otherPhoto.status, 409);
  assert.equal((await body(otherPhoto)).code, "attempt_id_reused");
});

/** The same image with one different scan byte, so it hashes differently. */
function stripTail(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[copy.length - 3] ^= 0x01;
  return copy;
}

test("a second founder of the same park gets 409 already_founded, also when they race", async () => {
  const { store, found } = setup();
  assert.equal((await found()).status, 200);
  const second = await found({}, "other");
  assert.equal(second.status, 409);
  assert.deepEqual(await body(second), { error: { code: "already_founded", message: "This park already has a founder: @sam." }, code: "already_founded", message: "This park already has a founder: @sam." });

  // A race: the other player's founding commits between this request's checks and its transaction.
  const race = setup();
  race.store.beforeFound = () => {
    race.store.beforeFound = undefined;
    race.store.founded.set("osm-way-23938892", { accountId: OTHER, attemptId: randomUUID(), sha256: "f".repeat(64), bytes: new Uint8Array(), foundedAt: new Date(NOW).toISOString(), parkName: "Paterson Park", visit: null });
  };
  const raced = await race.found();
  assert.equal(raced.status, 409);
  assert.equal((await body(raced)).message, "This park already has a founder: @bee.");
  assert.equal(store.founded.size, 1);
});

test("founding a park already in Parkdex records the founder, the visit and the photo without publishing anything", async () => {
  const { store, found } = setup();
  const response = await found({ target: { parkId: BEACON }, position: IN_BEACON });
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.deepEqual(result.park, { id: BEACON, name: "Beacon Hill Park" });
  assert.equal(store.osmFoundings.length, 0);
  assert.equal(store.existingFoundings[0].parkId, BEACON);
});

test("an OpenStreetMap outline that is already a Parkdex park is founded as that park", async () => {
  const catalogueNearby = [{ id: "municipal-delta-paterson", name: "Paterson Park", lat: 49.089, lng: -123.06, boundary: PATERSON_OUTLINE }];
  const { store, found } = setup({ catalogueNearby });
  store.catalogue.set("municipal-delta-paterson", { id: "municipal-delta-paterson", name: "Paterson Park", category: "municipal", boundary: PATERSON_OUTLINE });
  const result = await body(await found());
  assert.deepEqual(result.park, { id: "municipal-delta-paterson", name: "Paterson Park" });
  assert.equal(store.osmFoundings.length, 0);
});

test("the position must be in the park, precise enough, and the park must exist and be visible", async () => {
  const { store, found, photoCalls } = setup();
  const outside = await found({ position: { lat: 49.089, lng: -123.0626, accuracyM: 8 } });
  assert.equal(outside.status, 422);
  assert.equal((await body(outside)).code, "not_in_park");
  // About 30 m west of the edge counts with a 35 m fix.
  assert.equal((await found({ position: { lat: 49.089, lng: -123.0624, accuracyM: 35 } })).status, 200);
  const imprecise = await found({ target: { parkId: BEACON }, position: { ...IN_BEACON, accuracyM: 150 } });
  assert.equal(imprecise.status, 422);
  assert.equal((await body(imprecise)).code, "location_imprecise");
  assert.equal((await found({ target: { parkId: "municipal-nowhere" } })).status, 404);
  assert.equal((await found({ target: { osm: { type: "way", id: 999 } } })).status, 404);
  assert.equal((await body(await found({ target: { osm: { type: "way", id: UNNAMED.id } } }))).code, "unnamed_park");
  store.hiddenIds.add(BEACON);
  const hidden = await found({ target: { parkId: BEACON }, position: IN_BEACON });
  assert.equal(hidden.status, 404);
  assert.equal(photoCalls.length, 1, "only the founding inside the park asked the model");
});

test("a rejected photo names each flag above its threshold in plain words; an older unsure check asks for another angle", async () => {
  const rejected = setup({ answers: flagged({ people: 0.99, lighting: 0.85, not_park: 0.9 }) });
  const response = await rejected.found();
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    outcome: "rejected",
    flags: [
      { code: "people", message: "We spotted people. Take one without anyone in it." },
      { code: "lighting", message: "It's too dark or blurry. Take one in good light and hold the phone steady." },
    ],
    message: "We spotted people. Take one without anyone in it.",
    reviewableUntil: new Date(NOW + REVIEW_KEEP_MS).toISOString(),
  });
  assert.equal(rejected.store.founded.size, 0);
  assert.deepEqual(rejected.store.checks.map((check) => [check.outcome, check.flags]), [["reject", ["people", "lighting"]]]);
  assert.deepEqual(rejected.written[0].events.map((event) => [event.type, event.properties]), [["founder_photo_checked", { outcome: "reject", flags: "people,lighting", source: "osm_new" }]]);

  // Fairly likely flags at or below their thresholds approve; nothing is unsure any more.
  const likely = setup({ answers: flagged({ people: 0.8, lighting: 0.7, not_park: 0.95, not_photo: 0.9, personal_info: 0.6 }) });
  assert.equal((await body(await likely.found())).outcome, "founded");

  // A retry of a check stored as unsure, before the verdict question was dropped, answers as before.
  const older = setup({ answers: flagged({ people: 0.97 }) });
  const olderAttempt = randomUUID();
  await older.found({ attemptId: olderAttempt });
  Object.assign(older.store.checks[0], { outcome: "unsure", flags: [] });
  assert.deepEqual(await body(await older.found({ attemptId: olderAttempt })), { outcome: "unsure", flags: [], message: "We couldn't tell. Try another angle.", reviewableUntil: new Date(NOW + REVIEW_KEEP_MS).toISOString() });
  assert.equal(older.photoCalls.length, 1);

  // A retry of a rejected attempt answers the same without a second check.
  const attemptId = randomUUID();
  await rejected.found({ attemptId });
  const calls = rejected.photoCalls.length;
  assert.equal((await body(await rejected.found({ attemptId }))).outcome, "rejected");
  assert.equal(rejected.photoCalls.length, calls);
});

test("an unreachable or unconfigured model is a retryable 503 and the attempt can be retried", async () => {
  for (const answers of [null, "unconfigured"] as const) {
    const { store, found } = setup({ answers });
    const attemptId = randomUUID();
    const response = await found({ attemptId });
    assert.equal(response.status, 503);
    assert.deepEqual(await body(response), {
      error: { code: "photo_check_unavailable", message: "We couldn't check your photo. Try again in a moment." },
      code: "photo_check_unavailable", message: "We couldn't check your photo. Try again in a moment.",
    });
    assert.deepEqual(store.checks.map((check) => check.outcome), ["unavailable"]);
    assert.equal(store.founded.size, 0);
  }
});

test("founding needs a signed-in account with a handle", async () => {
  const { store, found } = setup();
  assert.equal((await found({}, "none")).status, 401);
  store.handles.delete(ACCOUNT);
  const noHandle = await found();
  assert.equal(noHandle.status, 409);
  assert.equal((await body(noHandle)).code, "handle_required");
});

test("the body is validated strictly and the photo must be a real JPEG of the stated size", async () => {
  const { found, call, photoCalls } = setup();
  const cases: [Record<string, unknown>, number, string][] = [
    [{ attemptId: "nope" }, 400, "invalid_request"],
    [{ extra: true }, 400, "invalid_request"],
    [{ target: { osm: { type: "node", id: 1 } } }, 400, "invalid_request"],
    [{ target: { osm: { type: "way", id: 1 }, parkId: BEACON } }, 400, "invalid_request"],
    [{ target: { parkId: "Bad Id" } }, 400, "invalid_request"],
    [{ position: { lat: 49, lng: -123 } }, 400, "invalid_position"],
    [{ photo: { ...PHOTO, mime: "image/png" } }, 400, "invalid_photo"],
    [{ photo: { ...PHOTO, base64: "not base64!" } }, 400, "invalid_photo"],
    [{ photo: { ...PHOTO, base64: Buffer.from("GIF89a").toString("base64") } }, 400, "invalid_photo"],
    [{ photo: { ...PHOTO, width: 17 } }, 400, "invalid_photo"],
    [{ photo: { ...PHOTO, width: 4096 } }, 413, "photo_too_large"],
    [{ photo: { ...PHOTO, extra: 1 } }, 400, "invalid_request"],
  ];
  for (const [overrides, status, code] of cases) {
    const response = await found(overrides);
    assert.equal(response.status, status, JSON.stringify(overrides).slice(0, 80));
    assert.equal((await body(response)).code, code, JSON.stringify(overrides).slice(0, 80));
  }
  const big = await found({ photo: { ...PHOTO, base64: "A".repeat(2_100_000) } });
  assert.equal(big.status, 413);
  assert.equal((await call("GET", "/api/parks/found")).status, 405);
  assert.equal(photoCalls.length, 0);
});

test("rate limits: 20 photo checks an hour and 5 foundings a day", async () => {
  const hourly = setup({ answers: flagged({ people: 0.97 }) });
  for (let index = 0; index < CHECKS_PER_HOUR; index += 1) assert.equal((await hourly.found()).status, 200);
  const limited = await hourly.found();
  assert.equal(limited.status, 429);
  assert.equal((await body(limited)).code, "rate_limited_founding");
  assert.equal(hourly.photoCalls.length, CHECKS_PER_HOUR);

  const daily = setup();
  for (let index = 0; index < FOUNDED_PER_DAY; index += 1) {
    daily.store.founded.set(`community-qa-${index}`, { accountId: ACCOUNT, attemptId: randomUUID(), sha256: "a".repeat(64), bytes: new Uint8Array(), foundedAt: new Date(NOW - 3_600_000).toISOString(), parkName: "QA", visit: null });
  }
  assert.equal((await daily.found()).status, 429);
});

test("the cover photo is public, immutable and cached by its hash; unknown, mismatched and hidden ones are 404", async () => {
  const { store, found, call } = setup();
  const { coverUrl } = await body(await found());
  const path = new URL(coverUrl).pathname;
  const response = await call("GET", path, undefined, "none");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const sha = path.split("/").at(-1)!.replace(".jpg", "");
  assert.equal(response.headers.get("etag"), `"${sha}"`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
  assert.ok(!Buffer.from(bytes).toString("latin1").includes("GPSLatitude"));
  assert.equal((await call("GET", path, undefined, "none", { "if-none-match": `"${sha}"` })).status, 304);
  assert.equal((await call("GET", path.replace(sha, "0".repeat(64)), undefined, "none")).status, 404);
  assert.equal((await call("GET", "/api/parks/municipal-nowhere/cover/" + sha + ".jpg", undefined, "none")).status, 404);
  store.hiddenIds.add("osm-way-23938892");
  assert.equal((await call("GET", path, undefined, "none")).status, 404);
});

test("the park summary has public counts, the founder and the cover, plus your own visits when signed in", async () => {
  const { found, call } = setup();
  await found();
  const anonymous = await call("GET", "/api/parks/osm-way-23938892/summary", undefined, "none");
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.headers.get("cache-control"), "public, max-age=60");
  const summary = await body(anonymous);
  assert.deepEqual(Object.keys(summary).sort(), ["coverUrl", "founder", "parkId", "visits"]);
  assert.equal(summary.parkId, "osm-way-23938892");
  assert.deepEqual(summary.founder, { handle: "sam", foundedAt: new Date(NOW).toISOString() });
  assert.match(summary.coverUrl, /\/api\/parks\/osm-way-23938892\/cover\/[0-9a-f]{64}\.jpg$/);
  assert.deepEqual(summary.visits, { total: 3, last30Days: 2, mine: null });

  const mine = await call("GET", "/api/parks/osm-way-23938892/summary");
  assert.equal(mine.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await body(mine)).visits, { total: 3, last30Days: 2, mine: 1 });
  // An expired or unknown session still gets the public summary.
  const stale = await call("GET", "/api/parks/osm-way-23938892/summary", undefined, "none", { authorization: `Bearer ${"x".repeat(43)}` });
  assert.equal(stale.status, 200);
  assert.equal((await body(stale)).visits.mine, null);

  const noFounder = await body(await call("GET", `/api/parks/${BEACON}/summary`, undefined, "none"));
  assert.deepEqual([noFounder.founder, noFounder.coverUrl], [null, null]);
  assert.equal((await call("GET", "/api/parks/municipal-nowhere/summary", undefined, "none")).status, 404);
  // Park IDs are grouped in analytics routes.
  assert.equal(normalizeRoute("GET", "/api/parks/osm-way-23938892/summary"), "GET /api/parks/:park/summary");
  assert.equal(normalizeRoute("GET", "/api/parks/osm-way-23938892/cover/" + "a".repeat(64) + ".jpg"), "GET /api/parks/:park/cover/:x");
  assert.equal(normalizeRoute("POST", "/api/parks/found"), "POST /api/parks/found");
});

// ---------------------------------------------------------------- manual review (#153)

const people = () => flagged({ people: 0.97 });

test("a rejected photo is kept for a day with its position and target; approved and unanswered ones are not", async () => {
  const rejected = setup({ answers: people() });
  const attemptId = randomUUID();
  const first = await body(await rejected.found({ attemptId }));
  assert.equal(first.reviewableUntil, new Date(NOW + REVIEW_KEEP_MS).toISOString());
  const kept = rejected.store.kept.get(attemptId)!;
  assert.equal(kept.at, new Date(NOW).toISOString());
  assert.deepEqual(kept.keep.position, INSIDE);
  assert.equal(kept.keep.parkName, "Paterson Park");
  assert.deepEqual(kept.keep.osmFeature?.geometry, PATERSON_OUTLINE, "the outline checked, so an approval publishes what the player stood in");
  const photo = Buffer.from(kept.keep.photo.base64, "base64");
  assert.ok(!photo.toString("latin1").includes("GPSLatitude") && !photo.toString("latin1").includes("QA Camera Maker"), "kept without metadata");
  assert.equal(kept.keep.photo.sha256, createHash("sha256").update(photo).digest("hex"));
  // A retry answers the same, including how long the photo is kept.
  assert.deepEqual(await body(await rejected.found({ attemptId })), first);

  const dark = setup({ answers: flagged({ lighting: 0.9 }) });
  const catalogue = await body(await dark.found({ target: { parkId: BEACON }, position: IN_BEACON }));
  assert.equal(catalogue.outcome, "rejected");
  assert.equal([...dark.store.kept.values()][0].keep.osmFeature, null, "a catalogue park keeps no outline; its boundary is in the catalogue");

  const approved = setup();
  await approved.found();
  assert.equal(approved.store.kept.size, 0);
  const unavailable = setup({ answers: null });
  await unavailable.found();
  assert.equal(unavailable.store.kept.size, 0);
});

test("asking for a review reuses the stored attempt, answers pending, and the same attempt answers the same request", async () => {
  const { store, found, call, written } = setup({ answers: people() });
  const attemptId = randomUUID();
  await found({ attemptId });
  const response = await call("POST", "/api/parks/found/review", { attemptId: attemptId.toUpperCase() });
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.deepEqual(Object.keys(result).sort(), ["requestId", "status"]);
  assert.equal(result.status, "pending");
  assert.deepEqual(store.requests.map((row) => [row.id, row.attemptId, row.parkId, row.status]), [[result.requestId, attemptId, "osm-way-23938892", "pending"]]);
  assert.equal(store.kept.size, 0, "the request holds the photo now");
  const event = written.find((context) => context.route === "POST /api/parks/found/review")!.events;
  assert.deepEqual(event.map((item) => [item.type, item.parkId, item.properties]), [["founding_review_requested", "osm-way-23938892", { outcome: "reject", source: "osm_new" }]]);

  const again = await call("POST", "/api/parks/found/review", { attemptId });
  assert.deepEqual(await body(again), { status: "pending", requestId: result.requestId });
  store.requests[0].status = "rejected";
  assert.deepEqual(await body(await call("POST", "/api/parks/found/review", { attemptId })), { status: "rejected", requestId: result.requestId });
  assert.equal(store.requests.length, 1);
  assert.equal(normalizeRoute("POST", "/api/parks/found/review/seen"), "POST /api/parks/found/review/seen");
});

test("a review needs sign-in, a handle, a strict body and the caller's own rejected or unsure attempt with its photo", async () => {
  const { store, found, call } = setup({ answers: people() });
  const attemptId = randomUUID();
  await found({ attemptId });
  const review = (body: unknown, auth: "bearer" | "other" | "none" = "bearer") => call("POST", "/api/parks/found/review", body, auth);
  assert.equal((await review({ attemptId }, "none")).status, 401);
  for (const bad of [{}, { attemptId: "nope" }, { attemptId, note: "please" }, [attemptId]]) {
    const response = await review(bad);
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.equal((await body(response)).code, "invalid_request");
  }
  assert.equal((await call("GET", "/api/parks/found/review")).status, 405);
  const other = await review({ attemptId }, "other");
  assert.equal(other.status, 404, "another player's attempt is not found");
  assert.equal((await body(other)).code, "attempt_not_found");
  assert.equal((await body(await review({ attemptId: randomUUID() }))).code, "attempt_not_found");
  store.handles.delete(ACCOUNT);
  assert.equal((await body(await review({ attemptId }))).code, "handle_required");
  store.handles.set(ACCOUNT, "sam");

  // The photo is gone after a day.
  store.kept.delete(attemptId);
  const expired = await review({ attemptId });
  assert.equal(expired.status, 410);
  assert.equal((await body(expired)).code, "photo_expired");

  // Approved and unanswered checks cannot be appealed.
  const approved = setup();
  const approvedAttempt = randomUUID();
  await approved.found({ attemptId: approvedAttempt, target: { parkId: BEACON }, position: IN_BEACON });
  const notReviewable = await approved.call("POST", "/api/parks/found/review", { attemptId: approvedAttempt });
  assert.equal(notReviewable.status, 409);
  assert.equal((await body(notReviewable)).code, "not_reviewable");
  const unavailable = setup({ answers: null });
  const unavailableAttempt = randomUUID();
  await unavailable.found({ attemptId: unavailableAttempt });
  assert.equal((await body(await unavailable.call("POST", "/api/parks/found/review", { attemptId: unavailableAttempt }))).code, "not_reviewable");
  assert.equal(store.requests.length + approved.store.requests.length + unavailable.store.requests.length, 0);

  // A check stored as unsure, before the verdict question was dropped, can still be appealed.
  const older = setup({ answers: people() });
  const olderAttempt = randomUUID();
  await older.found({ attemptId: olderAttempt });
  Object.assign(older.store.checks[0], { outcome: "unsure", flags: [] });
  assert.equal((await body(await older.call("POST", "/api/parks/found/review", { attemptId: olderAttempt }))).status, "pending");
});

test("a review is refused for a founded or hidden park and a second pending request; 3 a Victoria day", async () => {
  const { store, found, call } = setup({ answers: people() });
  const attempt = async (overrides: Record<string, unknown> = {}) => {
    const attemptId = randomUUID();
    await found({ attemptId, ...overrides });
    return attemptId;
  };
  const review = (attemptId: string) => call("POST", "/api/parks/found/review", { attemptId });

  const first = await attempt();
  assert.equal((await review(first)).status, 200);
  const second = await review(await attempt());
  assert.equal(second.status, 409);
  assert.equal((await body(second)).code, "review_pending");

  // Decided requests free the park again, but the day's limit still counts them.
  store.requests[0].status = "rejected";
  assert.equal((await review(await attempt())).status, 200);
  store.requests[1].status = "rejected";
  assert.equal((await review(await attempt())).status, 200);
  store.requests[2].status = "rejected";
  assert.equal(store.requests.length, REVIEWS_PER_DAY);
  const limited = await review(await attempt());
  assert.equal(limited.status, 429);
  assert.equal((await body(limited)).code, "rate_limited_review");
  // Yesterday's requests in Victoria do not count: 06:59 UTC is still the day before there.
  for (const row of store.requests) row.createdAt = "2026-10-08T06:59:00.000Z";
  assert.equal((await review(await attempt())).status, 200);

  const hidden = await attempt({ target: { parkId: BEACON }, position: IN_BEACON });
  store.hiddenIds.add(BEACON);
  const hiddenResponse = await review(hidden);
  assert.equal(hiddenResponse.status, 404);
  assert.equal((await body(hiddenResponse)).code, "park_not_found");
  store.hiddenIds.delete(BEACON);

  store.founded.set(BEACON, { accountId: OTHER, attemptId: randomUUID(), sha256: "f".repeat(64), bytes: new Uint8Array(), foundedAt: new Date(NOW).toISOString(), parkName: "Beacon Hill Park", visit: null });
  const founded = await review(hidden);
  assert.equal(founded.status, 409);
  assert.deepEqual(await body(founded), { error: { code: "already_founded", message: "This park already has a founder: @bee." }, code: "already_founded", message: "This park already has a founder: @bee." });
});

test("an instant founding closes pending reviews of that park as superseded", async () => {
  const rejected = setup({ answers: people() });
  const attemptId = randomUUID();
  await rejected.found({ attemptId, target: { parkId: BEACON }, position: IN_BEACON });
  await rejected.call("POST", "/api/parks/found/review", { attemptId });
  // Another player founds it instantly; the memory store mirrors the shared transaction's supersede.
  rejected.store.founded.clear();
  const store = rejected.store;
  const result = await store.foundExisting({
    accountId: OTHER, attemptId: randomUUID(), visitId: randomUUID(), parkId: BEACON, at: new Date(NOW).toISOString(),
    photo: { sha256: "a".repeat(64), base64: "", width: 1, height: 1 }, moderation: {},
  });
  assert.equal(result.status, "founded");
  assert.equal(store.requests[0].status, "superseded");
});

test("decisions are marked seen with a strict body; pending and other players' requests are left alone", async () => {
  const { store, call } = setup();
  const mine = randomUUID(), pending = randomUUID(), theirs = randomUUID();
  store.requests.push(
    { id: mine, accountId: ACCOUNT, attemptId: randomUUID(), parkId: BEACON, status: "approved", createdAt: new Date(NOW).toISOString(), seenAt: null },
    { id: pending, accountId: ACCOUNT, attemptId: randomUUID(), parkId: "osm-way-1", status: "pending", createdAt: new Date(NOW).toISOString(), seenAt: null },
    { id: theirs, accountId: OTHER, attemptId: randomUUID(), parkId: BEACON, status: "rejected", createdAt: new Date(NOW).toISOString(), seenAt: null },
  );
  const seen = (requestIds: unknown, auth: "bearer" | "none" = "bearer") => call("POST", "/api/parks/found/review/seen", { requestIds }, auth);
  assert.equal((await seen([mine], "none")).status, 401);
  for (const bad of [[], ["nope"], Array.from({ length: 51 }, () => randomUUID()), mine]) assert.equal((await seen(bad)).status, 400);
  const response = await seen([mine.toUpperCase(), pending, theirs]);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { seen: [mine] });
  assert.deepEqual(store.requests.map((row) => row.seenAt), [new Date(NOW).toISOString(), null, null]);
  assert.deepEqual(await body(await seen([mine])), { seen: [] }, "seen once");
});
