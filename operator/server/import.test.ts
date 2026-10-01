import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardApi, type DashboardEnv } from "./api.ts";
import { assertWebp, badgeAsset, sceneSlug, sha256Hex, uploadAndVerifyBadge } from "./badges.ts";
import { buildCatalogue, createLegacySource } from "./legacy.ts";
import { MemoryDraftStore } from "./memoryStores.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused" };
const square = (offset: number) => [[[offset, 48], [offset + 0.01, 48], [offset + 0.01, 48.01], [offset, 48.01], [offset, 48]]];

const boundaries = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { id: "regional-thetis-lake", name: "Thetis Lake", category: "regional", sourceName: "CRD" }, geometry: { type: "Polygon", coordinates: square(-123.47) } },
    { type: "Feature", properties: { id: "regional-thetis-lake" }, geometry: { type: "Polygon", coordinates: square(-123.46) } },
    { type: "Feature", properties: { id: "island-mayne-island", name: "Mayne Island", category: "island" }, geometry: { type: "MultiPolygon", coordinates: [square(-123.3)] } },
    { type: "Feature", properties: { id: "regional-broken" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 1]]] } },
  ],
};
const places = {
  places: [
    { id: "regional-thetis-lake", name: "Thetis Lake Regional Park", category: "regional", latitude: 48.48, longitude: -123.47, region: "Capital Region", description: "Lakes and trails.", sourceUrl: "https://example.test/crd", sourceName: "CRD", sourceId: "7" },
    { id: "island-mayne-island", name: "Mayne Island", category: "island", latitude: 48.84, longitude: -123.29, region: "Gulf Islands", description: "An island.", sourceUrl: "https://example.test/i", sourceName: "Islands", sourceId: null },
    { id: "regional-broken", name: "Broken", category: "regional", latitude: 48, longitude: -123, region: "", description: "", sourceUrl: "", sourceName: "", sourceId: null },
  ],
};

function legacyFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    return new Response(JSON.stringify(url.includes("boundaries") ? boundaries : places), { status: 200 });
  }) as typeof fetch;
}

function setup(overrides: Partial<DashboardEnv> = {}, fetcher: typeof fetch = legacyFetch()) {
  const drafts = new MemoryDraftStore();
  const legacySource = createLegacySource({ LEGACY_BOUNDARY_URL: "https://legacy.test/boundaries.json", LEGACY_PLACES_URL: "https://legacy.test/places" }, legacyFetch());
  const api = createDashboardApi({ draftStore: () => drafts, legacySource, randomSeed: () => 4242, fetch: fetcher });
  const call = (path: string, init: { method?: string; body?: unknown; raw?: Uint8Array; origin?: string | null } = {}) => {
    const headers = new Headers();
    const method = init.method ?? "GET";
    if (method !== "GET" && init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const body = init.raw ? new Uint8Array(init.raw) : init.body === undefined ? undefined : JSON.stringify(init.body);
    return api(new Request(`${ORIGIN}${path}`, { method, headers, body }), { ...env, ...overrides });
  };
  return { drafts, call };
}

/** The smallest structurally complete WebP: a RIFF header around a VP8L chunk. */
function webp(payload = 7): Uint8Array {
  const chunk = new Uint8Array(8 + payload);
  chunk.set([0x56, 0x50, 0x38, 0x4c], 0); // VP8L
  new DataView(chunk.buffer).setUint32(4, payload, true);
  const file = new Uint8Array(12 + chunk.length);
  file.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  new DataView(file.buffer).setUint32(4, file.length - 8, true);
  file.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  file.set(chunk, 12);
  return file;
}

test("the legacy catalogue groups features per park and skips broken geometry", () => {
  const parks = buildCatalogue(boundaries, places);
  assert.deepEqual([...parks.keys()].sort(), ["island-mayne-island", "regional-thetis-lake"]);
  const thetis = parks.get("regional-thetis-lake")!;
  assert.equal(thetis.geometry.type, "MultiPolygon");
  assert.equal(thetis.geometryStats.polygons, 2, "both source features are kept, in order");
  assert.equal(thetis.name, "Thetis Lake Regional Park", "the places record wins over boundary properties");
  assert.equal(thetis.record.description, "Lakes and trails.");
});

test("importing marks parks, creates a draft once, and keeps it off phones", async () => {
  const { call, drafts } = setup();
  const listed = await (await call("/api/legacy/parks")).json() as { parks: { id: string; status: string }[] };
  assert.equal(listed.parks.find((park) => park.id === "regional-thetis-lake")?.status, "available");

  assert.equal((await call("/api/drafts", { method: "POST", body: { legacyId: "regional-thetis-lake" }, origin: "https://evil.test" })).status, 403);
  const created = await call("/api/drafts", { method: "POST", body: { legacyId: "regional-thetis-lake" } });
  assert.equal(created.status, 201);
  const { draft } = await created.json() as { draft: { id: string; rarity: string | null; blurb: string; scene: string | null; seed: number; short: string; blockers: string[] } };
  assert.equal(draft.rarity, null);
  assert.equal(draft.blurb, "");
  assert.equal(draft.scene, null);
  assert.equal(draft.seed, 4242);
  assert.equal(draft.short, "Thetis Lake");
  assert.deepEqual(draft.blockers, ["Choose a rarity."]);
  assert.equal(drafts.parks.size, 0, "a draft never writes a park row");

  assert.equal((await call("/api/drafts", { method: "POST", body: { legacyId: "regional-thetis-lake" } })).status, 409);
  const again = await (await call("/api/legacy/parks")).json() as { parks: { id: string; status: string }[] };
  assert.equal(again.parks.find((park) => park.id === "regional-thetis-lake")?.status, "draft");
  assert.equal((await call("/api/drafts", { method: "POST", body: { legacyId: "no-such-park" } })).status, 404);
});

test("a park whose legacy category the app lacks starts without one", async () => {
  const { call } = setup();
  const { draft } = await (await call("/api/drafts", { method: "POST", body: { legacyId: "island-mayne-island" } })).json() as { draft: { category: string | null; blockers: string[] } };
  assert.equal(draft.category, null);
  assert.ok(draft.blockers.includes("Choose a category."));
});

test("draft edits are validated against the content contract", async () => {
  const { call } = setup();
  await call("/api/drafts", { method: "POST", body: { legacyId: "regional-thetis-lake" } });
  const path = "/api/drafts/regional-thetis-lake";
  for (const body of [{ rarity: "mythic" }, { biome: "desert" }, { category: "island" }, { name: "" }, { blurb: "x".repeat(801) }, { blurb: "bad\u0007" }, { scene: "x" }, { seed: 1 }]) {
    assert.equal((await call(path, { method: "PATCH", body })).status, 400, JSON.stringify(body));
  }
  const saved = await call(path, { method: "PATCH", body: { rarity: "rare", blurb: "  Two lakes.  ", biome: "lake" } });
  const { draft } = await saved.json() as { draft: { rarity: string; blurb: string; biome: string; blockers: string[] } };
  assert.deepEqual([draft.rarity, draft.blurb, draft.biome, draft.blockers], ["rare", "Two lakes.", "lake", []]);
});

test("badges must be WebP and get an immutable content-addressed slug; reference photos accept common types", async () => {
  const { call } = setup();
  await call("/api/drafts", { method: "POST", body: { legacyId: "regional-thetis-lake" } });
  assert.equal((await call("/api/drafts/regional-thetis-lake/badge", { method: "PUT", raw: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) })).status, 415);
  const badge = webp();
  const uploaded = await (await call("/api/drafts/regional-thetis-lake/badge", { method: "PUT", raw: badge })).json() as { draft: { scene: string; badgeSha256: string } };
  const sha = await sha256Hex(badge);
  assert.equal(uploaded.draft.badgeSha256, sha);
  assert.equal(uploaded.draft.scene, sceneSlug("regional-thetis-lake", sha));
  assert.match(uploaded.draft.scene, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  const served = await call("/api/drafts/regional-thetis-lake/badge");
  assert.equal(served.headers.get("content-type"), "image/webp");
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), badge);

  assert.equal((await call("/api/drafts/regional-thetis-lake/reference", { method: "PUT", raw: new Uint8Array([1, 2, 3, 4]) })).status, 415);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
  const photo = await (await call("/api/drafts/regional-thetis-lake/reference", { method: "PUT", raw: jpeg })).json() as { draft: { referencePhotoType: string } };
  assert.equal(photo.draft.referencePhotoType, "image/jpeg");
  const brief = await (await call("/api/drafts/regional-thetis-lake/brief")).json() as { park: { legacyDescription: string }; referencePhoto: string; boundary: { type: string } };
  assert.equal(brief.park.legacyDescription, "Lakes and trails.");
  assert.equal(brief.referencePhoto, "/api/drafts/regional-thetis-lake/reference");
  assert.equal(brief.boundary.type, "MultiPolygon");
  assert.equal((await call("/api/drafts/regional-thetis-lake/badge", { method: "PUT", raw: new Uint8Array(4 * 1024 * 1024 + 1) })).status, 413);
});

test("publishing needs a rarity, rejects stale edits, and writes the park, boundary and drive rows", async () => {
  const { call, drafts } = setup();
  const { draft } = await (await call("/api/drafts", { method: "POST", body: { legacyId: "regional-thetis-lake" } })).json() as { draft: { updatedAt: string } };
  assert.equal((await call("/api/drafts/regional-thetis-lake/publish", { method: "POST", body: { expectedUpdatedAt: draft.updatedAt } })).status, 422);
  const edited = await (await call("/api/drafts/regional-thetis-lake", { method: "PATCH", body: { rarity: "uncommon" } })).json() as { draft: { updatedAt: string } };
  assert.equal((await call("/api/drafts/regional-thetis-lake/publish", { method: "POST", body: { expectedUpdatedAt: draft.updatedAt } })).status, 409, "an older updatedAt is refused");
  const published = await call("/api/drafts/regional-thetis-lake/publish", { method: "POST", body: { expectedUpdatedAt: edited.draft.updatedAt } });
  assert.equal(published.status, 200);
  const park = drafts.parks.get("regional-thetis-lake")!;
  assert.deepEqual([park.rarity, park.scene, park.blurb, park.category], ["uncommon", null, "", "regional"]);
  assert.deepEqual((drafts.boundaries.get("regional-thetis-lake") as { properties: unknown }).properties, { id: "regional-thetis-lake", biome: "forest" });
  assert.equal((await call("/api/drafts/regional-thetis-lake", { method: "PATCH", body: { rarity: "rare" } })).status, 404, "a published draft is read only");
  const listed = await (await call("/api/legacy/parks")).json() as { parks: { id: string; status: string }[] };
  assert.equal(listed.parks.find((item) => item.id === "regional-thetis-lake")?.status, "in-parkdex");
});

test("publishing a badge uploads it to R2 and verifies the CDN before writing the park", async () => {
  const badge = webp(9);
  const sha = await sha256Hex(badge);
  const calls: string[] = [];
  let stored: Uint8Array | null = null;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("https://api.cloudflare.com/")) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cf-token");
      if (init?.method === "PUT") {
        stored = new Uint8Array(init.body as Uint8Array);
        assert.equal(new Headers(init.headers).get("cache-control"), "public, max-age=31536000, immutable");
        return new Response("{}", { status: 200 });
      }
      return new Response("missing", { status: 404 });
    }
    return new Response(stored as unknown as BodyInit, { status: 200, headers: { "content-type": "image/webp", "access-control-allow-origin": "*", "cache-control": "public, max-age=31536000, immutable" } });
  }) as typeof fetch;
  const { call, drafts } = setup({}, fetcher);
  await call("/api/drafts", { method: "POST", body: { legacyId: "regional-thetis-lake" } });
  await call("/api/drafts/regional-thetis-lake", { method: "PATCH", body: { rarity: "rare" } });
  const withBadge = await (await call("/api/drafts/regional-thetis-lake/badge", { method: "PUT", raw: badge })).json() as { draft: { updatedAt: string; scene: string } };

  const off = await call("/api/drafts/regional-thetis-lake/publish", { method: "POST", body: { expectedUpdatedAt: withBadge.draft.updatedAt } });
  assert.equal(off.status, 503, "without Cloudflare credentials a badge cannot be published");
  assert.equal(drafts.parks.size, 0);

  const configured = createDashboardApi({ draftStore: () => drafts, legacySource: createLegacySource({}, legacyFetch()), fetch: fetcher });
  const response = await configured(new Request(`${ORIGIN}/api/drafts/regional-thetis-lake/publish`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: withBadge.draft.updatedAt }),
  }), { ...env, CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acct" });
  assert.equal(response.status, 200);
  const key = `releases/${sha}/art/badges/scenes/${withBadge.draft.scene}.webp`;
  assert.deepEqual(calls.slice(-3), [
    `GET https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/parkdex-kip-content/objects/${key}`,
    `PUT https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/parkdex-kip-content/objects/${key}`,
    `GET https://kip-assets.parkdex.app/${key}`,
  ]);
  assert.equal(drafts.parks.get("regional-thetis-lake")?.scene, withBadge.draft.scene);
  assert.equal(drafts.assets.get(`art/badges/scenes/${withBadge.draft.scene}.webp`)?.sha256, sha);
});

test("an existing different object at the badge key is never overwritten", async () => {
  const asset = badgeAsset("thetis-abc", "a".repeat(64), 10);
  const fetcher = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(uploadAndVerifyBadge({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }, asset, new Uint8Array(10), fetcher), /different image/);
  assert.throws(() => assertWebp(new Uint8Array(30)), /WebP/);
});
