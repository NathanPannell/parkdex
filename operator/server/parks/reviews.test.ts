import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEW_REASONS } from "../../../worker/founding-reviews.ts";
import type { OsmFeature } from "../../../worker/osmParks.ts";
import { createDashboardApi, type DashboardEnv } from "../api.ts";
import { memoryParks } from "./memory.ts";
import { demoModeration, demoPhoto, type MemoryReview } from "./reviewMemory.ts";
import { analyticsEnvironment } from "./reviews.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused", DASHBOARD_ENVIRONMENT: "production" };
const AT = "2026-10-10T18:00:00.000Z";
const ring = (x: number, y: number): [number, number][] => [[x, y], [x + 0.004, y], [x + 0.004, y + 0.004], [x, y + 0.004], [x, y]];
const outline = (x: number, y: number) => ({ type: "MultiPolygon" as const, coordinates: [[ring(x, y)]] });
const MEADOW: OsmFeature = { type: "way", id: 4242, name: "Review Meadow", kind: "leisure=park", tags: { leisure: "park", name: "Review Meadow" }, geometry: outline(-123.4, 48.45), areaM2: 90_000 };
const IDS = {
  meadow: "11111111-1111-4111-8111-111111111111",
  meadowRival: "22222222-2222-4222-8222-222222222222",
  beacon: "33333333-3333-4333-8333-333333333333",
  founded: "44444444-4444-4444-8444-444444444444",
};

function setup() {
  const { live, manager, reviews, dependencies } = memoryParks();
  live.parks.set("beacon-hill", {
    id: "beacon-hill", name: "Beacon Hill Park", short: "Beacon Hill", category: "municipal", region: "Capital", lat: 48.412, lng: -123.36,
    biome: "forest", shape: "circle", rarity: "common", scene: null, seed: 7, blurb: "", geometry: outline(-123.362, 48.41),
  });
  live.parks.set("cattle-point", { ...live.parks.get("beacon-hill")!, id: "cattle-point", name: "Cattle Point", geometry: outline(-123.3, 48.43) });
  manager.founders.set("cattle-point", { handle: "tidepool_t", foundedAt: "2026-10-09T10:00:00.000Z", source: "existing", photo: demoPhoto(0, "plain"), width: 1280, height: 840 });
  const base: Omit<MemoryReview, "id" | "accountId" | "handle" | "parkId" | "parkName" | "feature" | "createdAt"> = {
    status: "pending", outcome: "reject", flags: ["people"], position: { lat: 48.452, lng: -123.398, accuracyM: 9 }, photo: demoPhoto(1, "people"),
    width: 1280, height: 840, moderation: demoModeration({ verdict: 0.08, people: 0.91 }), checkedAt: "2026-10-10T09:58:00.000Z",
    decidedAt: null, reasonCode: null, reason: null, foundedParkId: null, seenAt: null,
  };
  reviews.requests.push(
    { ...base, id: IDS.meadowRival, accountId: "b", handle: "rival", parkId: "osm-way-4242", parkName: "Review Meadow", feature: MEADOW, createdAt: "2026-10-10T11:00:00.000Z" },
    { ...base, id: IDS.meadow, accountId: "a", handle: "trail_tia", parkId: "osm-way-4242", parkName: "Review Meadow", feature: MEADOW, createdAt: "2026-10-10T10:00:00.000Z" },
    { ...base, id: IDS.beacon, accountId: "c", handle: "fern_gully", parkId: "beacon-hill", parkName: "Beacon Hill Park", feature: null, outcome: "unsure", flags: [], createdAt: "2026-10-10T12:00:00.000Z" },
    { ...base, id: IDS.founded, accountId: "d", handle: "owl_eyes", parkId: "cattle-point", parkName: "Cattle Point", feature: null, createdAt: "2026-10-10T13:00:00.000Z" },
  );
  const api = createDashboardApi({ ...dependencies, now: () => Date.parse(AT) });
  const call = (path: string, init: { method?: string; body?: unknown; origin?: string } = {}) => {
    const headers = new Headers();
    const method = init.method ?? "GET";
    if (method !== "GET") headers.set("origin", init.origin ?? ORIGIN);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return api(new Request(`${ORIGIN}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env);
  };
  return { live, manager, reviews, call };
}

const json = async <T = Record<string, any>>(response: Response) => await response.json() as T;

test("the queue lists requests oldest first, filters by status and counts each status", async () => {
  const { call, reviews } = setup();
  const pending = await json(await call("/api/parks/review"));
  assert.equal(pending.available, true);
  assert.deepEqual(pending.requests.map((row: { id: string }) => row.id), [IDS.meadow, IDS.meadowRival, IDS.beacon, IDS.founded]);
  assert.deepEqual(pending.counts, { pending: 4, approved: 0, rejected: 0, superseded: 0 });
  assert.deepEqual(Object.keys(pending.requests[0]).sort(), [
    "checkedAt", "createdAt", "decidedAt", "flags", "foundedParkId", "handle", "hasPhoto", "id", "osm", "outcome", "parkId", "parkName", "photoSha256", "reason", "reasonCode", "status",
  ]);
  assert.deepEqual((await json(await call("/api/parks/review?status=approved"))).requests, []);
  assert.equal((await json(await call("/api/parks/review?status=all"))).requests.length, 4);
  assert.equal((await call("/api/parks/review?status=nope")).status, 400);
  assert.deepEqual(await json(await call("/api/parks/review/count")), { available: true, pending: 4 });

  reviews.available = false;
  assert.deepEqual(await json(await call("/api/parks/review")), { available: false, counts: { pending: 0, approved: 0, rejected: 0, superseded: 0 }, requests: [] });
  assert.deepEqual(await json(await call("/api/parks/review/count")), { available: false, pending: 0 });
});

test("a request shows its photo, the check's answers, the position and the outline it was checked against", async () => {
  const { call } = setup();
  const { request } = await json(await call(`/api/parks/review/${IDS.meadow}`));
  assert.equal(request.handle, "trail_tia");
  assert.deepEqual(request.position, { lat: 48.452, lng: -123.398, accuracyM: 9 });
  assert.deepEqual(request.geometry, MEADOW.geometry);
  assert.deepEqual(request.osm, { type: "way", id: 4242 });
  assert.equal(request.moderation.answers.people.probabilities.yes, 0.91);
  assert.deepEqual(request.park, { inParkdex: false, hidden: false, founder: null });
  assert.equal(request.otherPending, 1);
  const photo = await call(`/api/parks/review/${IDS.meadow}/photo`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("cache-control"), "private, no-store");
  assert.match(photo.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal((await call(`/api/parks/review/${IDS.beacon}`).then(json)).request.geometry.type, "MultiPolygon", "a catalogue park shows its boundary");
  assert.equal((await call("/api/parks/review/not-a-uuid")).status, 404);
  assert.equal((await call("/api/parks/review/55555555-5555-4555-8555-555555555555")).status, 404);
});

test("approving publishes an OpenStreetMap target, makes the player founder with the photo as cover and supersedes rival requests", async () => {
  const { call, live, manager, reviews } = setup();
  const response = await call(`/api/parks/review/${IDS.meadow}/approve`, { method: "POST" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await json(response), { ok: true, parkId: "osm-way-4242", parkName: "Review Meadow", source: "osm_new" });
  assert.ok(live.parks.has("osm-way-4242"));
  const founder = manager.founders.get("osm-way-4242")!;
  assert.deepEqual([founder.handle, founder.foundedAt, founder.photo.sha256], ["trail_tia", AT, reviews.requests.find((row) => row.id === IDS.meadow)!.photo!.sha256]);
  assert.equal(manager.visits.length, 0, "no visit and no flag");
  const all = await json(await call("/api/parks/review?status=all"));
  const status = Object.fromEntries(all.requests.map((row: { id: string; status: string }) => [row.id, row.status]));
  assert.deepEqual(status, { [IDS.meadow]: "approved", [IDS.meadowRival]: "superseded", [IDS.beacon]: "pending", [IDS.founded]: "pending" });
  assert.deepEqual(reviews.events.map((event) => event.type), ["founding_review_decided", "park_founded"]);

  const twice = await call(`/api/parks/review/${IDS.meadow}/approve`, { method: "POST" });
  assert.equal(twice.status, 409);
  assert.equal((await json(twice)).error.code, "review_decided");
  assert.equal((await call(`/api/parks/review/${IDS.meadowRival}/approve`, { method: "POST" })).status, 409);
});

test("approving a park someone founded first closes the request as superseded", async () => {
  const { call } = setup();
  const response = await call(`/api/parks/review/${IDS.founded}/approve`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.deepEqual((await json(response)).error, { code: "already_founded", message: "Cattle Point was founded first by @tidepool_t. The request is closed as superseded." });
  assert.equal((await json(await call(`/api/parks/review/${IDS.founded}`))).request.status, "superseded");
});

test("rejecting takes a preset or the operator's own words, and decisions must come from the dashboard", async () => {
  const { call } = setup();
  assert.equal((await call(`/api/parks/review/${IDS.beacon}/reject`, { method: "POST", body: { reasonCode: "people" }, origin: "https://evil.example" })).status, 403);
  assert.equal((await call(`/api/parks/review/${IDS.beacon}/approve`, { method: "POST", origin: "https://evil.example" })).status, 403);
  assert.equal((await call(`/api/parks/review/${IDS.beacon}/reject`)).status, 405);
  for (const body of [{}, { reasonCode: "boring" }, { reasonCode: "other" }, { reasonCode: "other", reason: "   " }, { reasonCode: "people", reason: "x".repeat(301) },
    { reasonCode: "people", reason: "bad\u0007" }, { reasonCode: "people", extra: 1 }, { reasonCode: "people", reason: 5 }]) {
    const response = await call(`/api/parks/review/${IDS.beacon}/reject`, { method: "POST", body });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const preset = await call(`/api/parks/review/${IDS.beacon}/reject`, { method: "POST", body: { reasonCode: "lighting" } });
  assert.deepEqual(await json(preset), { ok: true, reasonCode: "lighting", reason: REVIEW_REASONS.lighting });
  const typed = await call(`/api/parks/review/${IDS.meadow}/reject`, { method: "POST", body: { reasonCode: "other", reason: "  The   photo shows a parking lot.  " } });
  assert.deepEqual(await json(typed), { ok: true, reasonCode: "other", reason: "The photo shows a parking lot." });
  const { request } = await json(await call(`/api/parks/review/${IDS.meadow}`));
  assert.deepEqual([request.status, request.reasonCode, request.reason, request.decidedAt], ["rejected", "other", "The photo shows a parking lot.", AT]);
  assert.equal((await call(`/api/parks/review/${IDS.meadow}/reject`, { method: "POST", body: { reasonCode: "people" } })).status, 409);
});

test("decision events carry the analytics environment of the database being edited", () => {
  assert.equal(analyticsEnvironment({ DASHBOARD_ENVIRONMENT: "production" }), "main");
  assert.equal(analyticsEnvironment({ DASHBOARD_ENVIRONMENT: "staging" }), "staging");
  assert.equal(analyticsEnvironment({}), "preview");
});
