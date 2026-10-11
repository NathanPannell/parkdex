import assert from "node:assert/strict";
import { test } from "node:test";
import type { OsmFeature } from "../../../worker/osmParks.ts";
import { createDashboardApi, type DashboardEnv } from "../api.ts";
import type { MultiPolygon } from "./geometry.ts";
import { memoryParks } from "./memory.ts";
import { REMOVED_REASON, removalStatements, type RemovalFeatures } from "./removal.ts";
import type { MemoryReview } from "./reviewMemory.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused", DASHBOARD_ENVIRONMENT: "staging" };
const NOW = Date.parse("2026-10-10T18:00:00Z");

function box(lng: number, lat: number, size = 0.002): MultiPolygon {
  return { type: "MultiPolygon", coordinates: [[[[lng - size, lat - size], [lng + size, lat - size], [lng + size, lat + size], [lng - size, lat + size], [lng - size, lat - size]]]] };
}

function feature(type: "way" | "relation", id: number, name: string | null, lng: number, lat: number, size = 0.0018): OsmFeature {
  return { type, id, name, kind: "leisure=park", tags: name ? { leisure: "park", name } : { leisure: "park" }, geometry: box(lng, lat, size), areaM2: Math.round(size * size * 1e10) };
}

function setup() {
  const stores = memoryParks();
  const { live, manager, osm, reviews } = stores;
  const add = (id: string, name: string, lng: number, lat: number, geometry: MultiPolygon | null = box(lng, lat)) => live.parks.set(id, {
    id, name, short: name, category: "municipal", region: "Capital", lat, lng, biome: "forest", shape: "circle", rarity: "common", scene: null, seed: 1, blurb: "A park.", geometry,
  });
  add("beacon-hill", "Beacon Hill Park", -123.36, 48.41);
  add("osm-way-77", "Founded Green", -123.33, 48.45);
  add("legacy-park", "Legacy Park", -123.94, 49.17);
  add("quiet-corner", "Quiet Corner", -123.2, 48.3);
  add("big-reserve", "Big Reserve", -123.5, 48.6, box(-123.5, 48.6, 0.01));
  add("inner-meadow", "Inner Meadow", -123.5, 48.6, box(-123.5, 48.6, 0.001));
  manager.legacy.add("legacy-park");
  manager.founders.set("osm-way-77", {
    handle: "tester_one", foundedAt: "2026-10-10T16:00:00.000Z", source: "osm_new", width: 16, height: 12,
    photo: { bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg", sha256: "a".repeat(64) },
  });
  manager.visits.push({ parkId: "osm-way-77", accountId: "tester", visitedAt: "2026-10-10T16:00:00.000Z" });
  manager.tenures.push({ parkId: "osm-way-77", handle: "tester_one", startedAt: "2026-10-10T16:00:00.000Z", lastVisitAt: "2026-10-10T16:00:00.000Z", endedAt: null });
  osm.features.push(
    feature("way", 77, "Founded Green", -123.33, 48.45),
    // Beacon Hill's own outline, and a playground inside it that pairs with it too.
    feature("way", 1001, "Beacon Hill Park", -123.3601, 48.4101),
    feature("way", 1002, "Beacon Hill Playground", -123.3603, 48.4102, 0.0003),
    // Quiet Corner's only outline has no name.
    feature("way", 3003, null, -123.2, 48.3),
    // Inner Meadow's outline sits inside Big Reserve, so it would found Big Reserve instead.
    feature("relation", 4004, "Inner Meadow", -123.5, 48.6, 0.0009),
  );
  const base = { width: 16, height: 12, decidedAt: null, reasonCode: null, reason: null, foundedParkId: null, seenAt: null, moderation: null, flags: ["people"] };
  const review = (id: string, parkId: string, parkName: string, extra: Partial<MemoryReview> = {}): MemoryReview => ({
    ...base, id, accountId: `player-${id.slice(0, 4)}`, handle: `player_${id.slice(0, 4)}`, status: "pending", parkId, parkName, feature: null, outcome: "reject",
    position: { lat: 48.45, lng: -123.33, accuracyM: 8 }, photo: { bytes: new Uint8Array([9]), contentType: "image/jpeg", sha256: "b".repeat(64) },
    createdAt: "2026-10-10T15:00:00.000Z", checkedAt: "2026-10-10T14:58:00.000Z", ...extra,
  });
  reviews.requests.push(
    review("11111111-1111-4111-8111-111111111111", "osm-way-77", "Founded Green"),
    review("22222222-2222-4222-8222-222222222222", "beacon-hill", "Beacon Hill Park"),
    review("33333333-3333-4333-8333-333333333333", "osm-way-77", "Founded Green", { status: "rejected", decidedAt: "2026-10-09T10:00:00.000Z", reasonCode: "people", reason: "There are people in the photo." }),
  );
  const api = createDashboardApi({ ...stores.dependencies, now: () => NOW });
  const call = (path: string, init: { method?: string; body?: unknown; origin?: string } = {}) => {
    const headers = new Headers();
    const method = init.method ?? "GET";
    if (method !== "GET") headers.set("origin", init.origin ?? ORIGIN);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return api(new Request(`${ORIGIN}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env);
  };
  return { ...stores, call };
}

const body = async <T>(response: Response) => await response.json() as T;
type Plan = { blocked: { code: string; message: string } | null; outline: { type: string; id: number; parkId: string } | null; founder: { handle: string } | null; pendingReviews: number; source: string; audited: boolean };

test("the plan says what a removal of a founded park does: founder, pending reviews and the outline it keeps", async () => {
  const { call } = setup();
  const { plan } = await body<{ plan: Plan }>(await call("/api/parks/osm-way-77/remove-from-map"));
  assert.equal(plan.blocked, null);
  assert.equal(plan.source, "founded");
  assert.equal(plan.founder?.handle, "tester_one");
  assert.equal(plan.pendingReviews, 1, "only pending requests count");
  assert.deepEqual([plan.outline?.type, plan.outline?.id, plan.outline?.parkId], ["way", 77, "osm-way-77"]);
  assert.equal(plan.audited, true);
  assert.equal((await call("/api/parks/missing-park/remove-from-map")).status, 404);
});

test("removing a founded park takes it off the map, clears the founder and closes its reviews, and keeps the outline", async () => {
  const { call, live, manager, reviews } = setup();
  const before = live.revision;
  assert.equal((await call("/api/parks/osm-way-77/remove-from-map", { method: "POST", origin: "https://evil.example" })).status, 403);
  assert.equal((await call("/api/parks/osm-way-77/remove-from-map", { method: "POST", body: { force: true } })).status, 400, "it takes no fields");
  const response = await call("/api/parks/osm-way-77/remove-from-map", { method: "POST" });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await body<{ ok: boolean; revision: number; founder: { handle: string }; reviewsClosed: number; outline: { parkId: string } }>(response);
  assert.deepEqual([result.ok, result.revision, result.founder.handle, result.reviewsClosed, result.outline.parkId], [true, before + 1, "tester_one", 1, "osm-way-77"]);

  assert.ok(!live.parks.has("osm-way-77"));
  assert.ok(!manager.founders.has("osm-way-77"), "the founder, the cover and the bonus go");
  assert.deepEqual(live.changes.filter((change) => change.revision === result.revision).map((change) => `${change.entity}:${change.operation}`).sort(),
    ["boundary:delete", "drive:delete", "park:delete"], "one content revision of tombstones, like Delete");
  assert.equal(manager.visits.filter((visit) => visit.parkId === "osm-way-77").length, 1, "visits stay as history");
  assert.equal(manager.tenures.filter((tenure) => tenure.parkId === "osm-way-77").length, 1, "tenures stay as history");

  const closed = reviews.requests.find((row) => row.id === "11111111-1111-4111-8111-111111111111")!;
  assert.deepEqual([closed.status, closed.reasonCode, closed.reason, closed.decidedAt], ["rejected", "other", REMOVED_REASON, new Date(NOW).toISOString()]);
  assert.equal(reviews.requests.find((row) => row.id === "33333333-3333-4333-8333-333333333333")!.reason, "There are people in the photo.", "decided requests are left alone");
  assert.equal(reviews.requests.find((row) => row.id === "22222222-2222-4222-8222-222222222222")!.status, "pending", "other parks' requests are left alone");
  assert.deepEqual(reviews.events.map((event) => [event.type, event.parkId, event.properties.reason_code ?? event.properties.reviews_closed]), [
    ["park_removed", "osm-way-77", 1],
    ["founding_review_decided", "osm-way-77", "park_removed"],
  ]);

  // The outline stays, is no longer matched to a Parkdex park, and can be published again.
  const layer = await body<{ outlines: Array<{ id: number; inParkdex: unknown }> }>(await call("/api/parks/osm?bbox=-123.34,48.44,-123.32,48.46"));
  assert.deepEqual(layer.outlines.filter((outline) => outline.id === 77).map((outline) => outline.inParkdex), [null]);
  const prefill = await body<{ inParkdex: unknown }>(await call("/api/parks/osm/way-77"));
  assert.equal(prefill.inParkdex, null);
  assert.equal((await call("/api/parks/osm-way-77/remove-from-map", { method: "POST" })).status, 404, "gone means gone");
});

test("a curated park with a matching outline can be removed and founded again from that outline", async () => {
  const { call, live, reviews } = setup();
  const { plan } = await body<{ plan: Plan }>(await call("/api/parks/beacon-hill/remove-from-map"));
  assert.equal(plan.blocked, null);
  assert.equal(plan.source, "curated");
  assert.deepEqual([plan.outline?.type, plan.outline?.id, plan.outline?.parkId], ["way", 1001, "osm-way-1001"], "its own named outline, not the playground inside it");
  assert.equal(plan.founder, null);
  assert.equal(plan.pendingReviews, 1);
  const removed = await call("/api/parks/beacon-hill/remove-from-map", { method: "POST" });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.ok(!live.parks.has("beacon-hill"));
  assert.equal(reviews.requests.find((row) => row.parkId === "beacon-hill")!.status, "rejected");
  const prefill = await body<{ inParkdex: unknown; draft: { id: string } }>(await call("/api/parks/osm/way-1001"));
  assert.deepEqual([prefill.inParkdex, prefill.draft.id], [null, "osm-way-1001"], "the outline is not in Parkdex any more");
});

test("parks the action cannot apply to say why, and the server refuses them", async () => {
  const { call, live, manager } = setup();
  const blocked = async (id: string) => (await body<{ plan: Plan }>(await call(`/api/parks/${id}/remove-from-map`))).plan.blocked?.code;
  assert.equal(await blocked("legacy-park"), "no_outline");
  assert.equal(await blocked("quiet-corner"), "unnamed_outline");
  assert.equal(await blocked("inner-meadow"), "outline_is_other_park");
  manager.enrichment.add("beacon-hill");
  assert.equal(await blocked("beacon-hill"), "park_in_enrichment");
  for (const [id, code] of [["legacy-park", "no_outline"], ["quiet-corner", "unnamed_outline"], ["inner-meadow", "outline_is_other_park"], ["beacon-hill", "park_in_enrichment"]]) {
    const refused = await call(`/api/parks/${id}/remove-from-map`, { method: "POST" });
    assert.equal(refused.status, 409, id);
    assert.equal((await body<{ error: { code: string } }>(refused)).error.code, code);
    assert.ok(live.parks.has(id), `${id} stays`);
  }
  const message = (await body<{ plan: Plan }>(await call("/api/parks/inner-meadow/remove-from-map"))).plan.blocked?.message;
  assert.match(message ?? "", /Big Reserve/);
  assert.equal((await call("/api/parks/beacon-hill/remove-from-map", { method: "DELETE" })).status, 405);
});

test("the removal statements take the founding lock first and bind exactly the parameters they use", () => {
  const all: RemovalFeatures = { founders: true, reviews: true, osm: true, events: true, audited: true };
  const none: RemovalFeatures = { founders: false, reviews: false, osm: true, events: false, audited: false };
  let next = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
  for (const features of [all, none, { ...all, audited: false }, { ...all, events: false, audited: false }, { ...all, reviews: false }]) {
    const statements = removalStatements({ parkId: "osm-way-77", outline: { type: "way", id: 77 }, source: "founded", at: "2026-10-10T18:00:00.000Z", environment: "staging", features, uuid });
    assert.match(statements[0].text, /pg_advisory_xact_lock\(hashtextextended\('kip_founders\.park:'/, "the founding transaction's lock");
    assert.match(statements[1].text, /FOR UPDATE/);
    assert.match(statements[statements.length - 1].text, /content_clock/);
    const texts = statements.map((statement) => statement.text);
    const parkDelete = texts.findIndex((text) => text.includes("DELETE FROM public.parks"));
    for (const [index, text] of texts.entries()) {
      if (/review_requests SET status|DELETE FROM kip_founders\.parks|'park_removed'/.test(text)) assert.ok(index < parkDelete, "everything that reads the park runs before the delete");
    }
    assert.equal(texts.some((text) => text.includes("$2::uuid, 'park_removed'")), features.audited);
    assert.equal(texts.some((text) => text.includes("kip_founders.review_requests SET")), features.reviews);
    assert.equal(texts.some((text) => text.includes("DELETE FROM kip_founders.parks")), features.founders);
    // PostgreSQL refuses a parameter whose type it cannot infer, so every bound value must be used.
    for (const statement of statements) {
      const used = Math.max(0, ...[...statement.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
      assert.equal(used, statement.params.length, statement.text.slice(0, 80));
    }
  }
});
