import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardApi, type DashboardEnv } from "../api.ts";
import type { MultiPolygon } from "./geometry.ts";
import { liveUpdateStatements } from "./liveParks.ts";
import { memoryParks } from "./memory.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused" };
const square: MultiPolygon = { type: "MultiPolygon", coordinates: [[[[-123.4, 48.4], [-123.39, 48.4], [-123.39, 48.41], [-123.4, 48.41], [-123.4, 48.4]]]] };

function setup() {
  const { live: parks, dependencies } = memoryParks();
  parks.parks.set("beacon-hill", {
    id: "beacon-hill", name: "Beacon Hill Park", short: "Beacon Hill", category: "municipal", region: "Capital", lat: 48.41, lng: -123.36,
    biome: "forest", shape: "circle", rarity: "common", scene: null, seed: 7, blurb: "", geometry: square,
  });
  const api = createDashboardApi(dependencies);
  const call = (path: string, init: { method?: string; body?: unknown; origin?: string } = {}) => {
    const headers = new Headers();
    const method = init.method ?? "GET";
    if (method !== "GET") headers.set("origin", init.origin ?? ORIGIN);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return api(new Request(`${ORIGIN}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env);
  };
  return { parks, call };
}

async function opened(call: ReturnType<typeof setup>["call"]) {
  const { park } = await (await call("/api/parks/beacon-hill")).json() as { park: Record<string, unknown> };
  const { geometry: _geometry, ...expected } = park;
  return expected;
}

test("live parks list, read with their boundary, and list the regions in use", async () => {
  const { call } = setup();
  const listed = await (await call("/api/parks")).json() as { parks: { id: string }[] };
  assert.deepEqual(listed.parks.map((park) => park.id), ["beacon-hill"]);
  const { park } = await (await call("/api/parks/beacon-hill")).json() as { park: { geometry: unknown } };
  assert.deepEqual(park.geometry, square);
  assert.deepEqual(await (await call("/api/parks/regions")).json(), { regions: ["Capital"] });
  assert.equal((await call("/api/parks/no-such-park")).status, 404);
  assert.equal((await call("/api/parks/beacon-hill/badge", { method: "PUT" })).status, 404, "badge uploads are retired");
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

test("live park edits are validated against the content contract and must come from the dashboard", async () => {
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
  assert.equal((await call("/api/parks/beacon-hill", { method: "PATCH", body: { expected, changes: { name: "x" } }, origin: "https://evil.example" })).status, 403);
});

test("the guarded statements check the opened park and only touch the boundary when needed", () => {
  const expected = { id: "p", name: "P", short: "P", category: "municipal", region: "", lat: 1, lng: 2, biome: "forest", shape: "circle", rarity: "common", scene: null, seed: 1, blurb: "" };
  const textOnly = liveUpdateStatements("p", expected, { name: "Q" });
  assert.match(textOnly[1].text, /park_changed/);
  assert.ok(!textOnly.some((statement) => statement.text.includes("public.boundaries")), "a rename leaves the boundary alone");
  const biome = liveUpdateStatements("p", expected, { biome: "lake" });
  const boundary = biome.find((statement) => statement.text.includes("public.boundaries"))!;
  assert.deepEqual(boundary.params, ["p", "lake", null], "a biome change rewrites the boundary properties and keeps the geometry");
});
