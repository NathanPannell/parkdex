import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardApi, type DashboardEnv } from "./api.ts";
import { sha256Hex } from "./badges.ts";
import { liveUpdateStatements } from "./liveParks.ts";
import type { MultiPolygon } from "./legacy.ts";
import { MemoryLiveParkStore } from "./memoryStores.ts";
import { bestPhoto, downloadPhoto, searchPhotos } from "./photos.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused" };
const square: MultiPolygon = { type: "MultiPolygon", coordinates: [[[[-123.4, 48.4], [-123.39, 48.4], [-123.39, 48.41], [-123.4, 48.41], [-123.4, 48.4]]]] };

function webp(payload = 7): Uint8Array {
  const chunk = new Uint8Array(8 + payload);
  chunk.set([0x56, 0x50, 0x38, 0x4c], 0);
  new DataView(chunk.buffer).setUint32(4, payload, true);
  const file = new Uint8Array(12 + chunk.length);
  file.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(file.buffer).setUint32(4, file.length - 8, true);
  file.set([0x57, 0x45, 0x42, 0x50], 8);
  file.set(chunk, 12);
  return file;
}

function setup(fetcher?: typeof fetch, overrides: Partial<DashboardEnv> = {}) {
  const parks = new MemoryLiveParkStore();
  parks.parks.set("beacon-hill", {
    id: "beacon-hill", name: "Beacon Hill Park", short: "Beacon Hill", category: "municipal", region: "Capital", lat: 48.41, lng: -123.36,
    biome: "forest", shape: "circle", rarity: "common", scene: null, seed: 7, blurb: "", geometry: square,
  });
  const api = createDashboardApi({ liveParkStore: () => parks, fetch: fetcher });
  const call = (path: string, init: { method?: string; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    if (method !== "GET") headers.set("origin", ORIGIN);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const body = init.raw ? new Uint8Array(init.raw) : init.body === undefined ? undefined : JSON.stringify(init.body);
    return api(new Request(`${ORIGIN}${path}`, { method, headers, body }), { ...env, ...overrides });
  };
  return { parks, call };
}

async function opened(call: ReturnType<typeof setup>["call"]) {
  const { park } = await (await call("/api/parks/beacon-hill")).json() as { park: Record<string, unknown> };
  const { geometry: _geometry, badgeUrl: _badgeUrl, badgeUploads: _badgeUploads, ...expected } = park;
  return expected;
}

test("live parks list, read with their boundary, and list the regions in use", async () => {
  const { call } = setup();
  const listed = await (await call("/api/parks")).json() as { parks: { id: string }[] };
  assert.deepEqual(listed.parks.map((park) => park.id), ["beacon-hill"]);
  const { park } = await (await call("/api/parks/beacon-hill")).json() as { park: { geometry: unknown; badgeUploads: boolean } };
  assert.deepEqual(park.geometry, square);
  assert.equal(park.badgeUploads, false);
  assert.deepEqual(await (await call("/api/regions")).json(), { regions: ["Capital"] });
  assert.equal((await call("/api/parks/no-such-park")).status, 404);
});

test("saving a live park applies only checked changes and moves the shape with the category", async () => {
  const { call, parks } = setup();
  const expected = await opened(call);
  const ring = [[-123.37, 48.4], [-123.35, 48.4], [-123.35, 48.42], [-123.37, 48.4]];
  const response = await call("/api/parks/beacon-hill", {
    method: "PATCH",
    body: { expected, changes: { name: "Beacon Hill", category: "regional", rarity: "rare", lat: 48.4123456789, lng: -123.36, geometry: { type: "Polygon", coordinates: [ring] } } },
  });
  assert.equal(response.status, 200);
  const saved = parks.parks.get("beacon-hill")!;
  assert.equal(saved.name, "Beacon Hill");
  assert.equal(saved.shape, "hex", "regional parks get the hex badge");
  assert.equal(saved.lat, 48.412346, "coordinates are rounded to six places");
  assert.equal(saved.geometry?.type, "MultiPolygon", "a drawn polygon is stored as a MultiPolygon");

  const stale = await call("/api/parks/beacon-hill", { method: "PATCH", body: { expected, changes: { name: "Other" } } });
  assert.equal(stale.status, 409, "an edit made against an old copy is refused");
  assert.equal(parks.parks.get("beacon-hill")!.name, "Beacon Hill");
});

test("live park edits are validated against the content contract", async () => {
  const { call } = setup();
  const expected = await opened(call);
  const bad = [
    { name: "" },
    { short: "x".repeat(141) },
    { blurb: "bad\u0007text" },
    { category: "island" },
    { rarity: "mythic" },
    { lat: 48.4 },
    { lat: 91, lng: 0 },
    { id: "renamed" },
    { scene: "anything" },
    {},
  ];
  for (const changes of bad) {
    const response = await call("/api/parks/beacon-hill", { method: "PATCH", body: { expected, changes } });
    assert.equal(response.status, 400, JSON.stringify(changes));
  }
  const crossOrigin = await createDashboardApi({ liveParkStore: () => new MemoryLiveParkStore() })(new Request(`${ORIGIN}/api/parks/beacon-hill`, {
    method: "PATCH", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ expected, changes: { name: "x" } }),
  }), env);
  assert.equal(crossOrigin.status, 403);
});

test("replacing a live badge uploads it, then points the park at the new scene", async () => {
  const badge = webp(11);
  const sha = await sha256Hex(badge);
  let stored: Uint8Array | null = null;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.cloudflare.com/")) {
      if (init?.method === "PUT") {
        stored = new Uint8Array(init.body as Uint8Array);
        return new Response("{}", { status: 200 });
      }
      return new Response("missing", { status: 404 });
    }
    return new Response(stored as unknown as BodyInit, { status: 200, headers: { "content-type": "image/webp", "access-control-allow-origin": "*", "cache-control": "public, max-age=31536000, immutable" } });
  }) as typeof fetch;
  const { call, parks } = setup(fetcher, { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acct" });
  const expected = await opened(call);
  const header = { "x-parkdex-expected": encodeURIComponent(JSON.stringify(expected)) };

  assert.equal((await call("/api/parks/beacon-hill/badge", { method: "PUT", raw: new Uint8Array([1, 2, 3]), headers: header })).status, 415);
  assert.equal((await call("/api/parks/beacon-hill/badge", { method: "PUT", raw: badge })).status, 400, "the opened park is required");

  const response = await call("/api/parks/beacon-hill/badge", { method: "PUT", raw: badge, headers: header });
  assert.equal(response.status, 200);
  const { park } = await response.json() as { park: { scene: string; badgeUrl: string } };
  assert.equal(park.scene, `beacon-hill-${sha.slice(0, 8)}`);
  assert.equal(park.badgeUrl, `https://kip-assets.parkdex.app/releases/${sha}/art/badges/scenes/${park.scene}.webp`);
  assert.equal(parks.parks.get("beacon-hill")!.scene, park.scene);
});

test("the guarded statements check the opened park and only touch the boundary when needed", () => {
  const expected = { id: "p", name: "P", short: "P", category: "municipal", region: "", lat: 1, lng: 2, biome: "forest", shape: "circle", rarity: "common", scene: null, seed: 1, blurb: "" };
  const textOnly = liveUpdateStatements("p", expected, { name: "Q" }, null);
  assert.match(textOnly[1].text, /park_changed/);
  assert.ok(!textOnly.some((statement) => statement.text.includes("public.boundaries")), "a rename leaves the boundary alone");
  const biome = liveUpdateStatements("p", expected, { biome: "lake" }, null);
  const boundary = biome.find((statement) => statement.text.includes("public.boundaries"))!;
  assert.deepEqual(boundary.params, ["p", "lake", null], "a biome change rewrites the boundary properties and keeps the geometry");
});

test("photo search merges name matches and nearby photos, and only downloads public https images", async () => {
  const requests: string[] = [];
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    if (url.hostname === "commons.wikimedia.org") {
      const geo = url.searchParams.get("generator") === "geosearch";
      const page = (title: string, thumb: string) => ({ title, index: 1, imageinfo: [{ thumburl: thumb, thumbwidth: 640, thumbheight: 480, mime: "image/jpeg", descriptionurl: `https://commons.wikimedia.org/wiki/${title}` }] });
      return Response.json({ query: { pages: geo
        ? { 1: page("File:Swings.jpg", "https://upload.wikimedia.org/a.jpg"), 2: page("File:Pond.jpg", "https://upload.wikimedia.org/b.jpg") }
        : { 3: page("File:Beacon Hill flagpole.jpg", "https://upload.wikimedia.org/c.jpg"), 4: page("File:Unrelated.jpg", "https://upload.wikimedia.org/a.jpg") } } });
    }
    return new Response(jpeg, { status: 200 });
  }) as typeof fetch;
  const photos = await searchPhotos({ name: "Beacon Hill Park", region: "Capital", lat: 48.41, lng: -123.36 }, fetcher);
  assert.deepEqual(photos.map((photo) => [photo.title, photo.match]), [["Beacon Hill flagpole", "name"], ["Unrelated", "name"], ["Pond", "nearby"]]);
  assert.equal(bestPhoto(photos, "Beacon Hill Park")?.title, "Beacon Hill flagpole");
  assert.equal(bestPhoto(photos.slice(1), "Beacon Hill Park")?.title, "Pond", "with no name match, the nearest photo is used");

  assert.equal((await downloadPhoto("https://th.bing.com/th/id/abc", fetcher)).contentType, "image/jpeg");
  for (const unsafe of ["http://example.com/a.jpg", "https://127.0.0.1/a.jpg", "https://localhost/a.jpg", "https://[::1]/a.jpg", "https://intranet/a.jpg", "https://example.com:8443/a.jpg", "file:///etc/passwd"]) {
    await assert.rejects(downloadPhoto(unsafe, fetcher), /https image address/, unsafe);
  }
});
