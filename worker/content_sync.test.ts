import assert from "node:assert/strict";
import { test } from "node:test";
import { createChangesHandler, createSceneHandler, createSnapshotHandler } from "./content_sync.js";

const release = "1".repeat(64);
const cdn = "https://kip-assets.parkdex.app";
const park = { id: "community-cove", name: "Community Cove", short: "Cove", category: "community", region: "South Island", lat: 48.4, lng: -123.3, biome: "coast", shape: "circle", rarity: "rare", scene: "cove-a", seed: 10, blurb: "A shore walk." };
const feature = { type: "Feature", properties: { id: park.id, biome: park.biome }, geometry: { type: "MultiPolygon", coordinates: [[[[-123.31,48.39],[-123.29,48.39],[-123.29,48.41],[-123.31,48.39]]]] } };
const file = { path: "art/badges/scenes/cove-a.webp", key: `releases/${release}/art/badges/scenes/cove-a.webp`, url: `${cdn}/releases/${release}/art/badges/scenes/cove-a.webp`, sha256: "2".repeat(64), byte_size: 50, content_type: "image/webp" };
const map = { version: release, manifestUrl: `${cdn}/releases/${release}/map/manifest.json`, manifestSha256: "3".repeat(64) };
const snapshot = { schema: "parkdex.content-sync/v1", revision: 3, parks: [park], boundaries: { type: "FeatureCollection", features: [feature] }, drive: { hubs: [{ name: "Downtown", lng: -123.36, lat: 48.42 }], parks: { [park.id]: { drive: [[12.5, 20]], walkM: 45 } } }, assets: [file], map };

function response() {
  const headers = new Map<string, string>();
  let body = "";
  return { headers, get body() { return body; }, statusCode: 0,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    end(value?: string) { body = value ?? ""; } };
}
const req = (query: Record<string, string> = {}, method = "GET", origin?: string) => ({ method, query, headers: origin ? { origin } : {} });
const repository = (changes: () => Promise<unknown> = async () => ({ headRevision: 3, retentionFloor: 0, hasMore: false, batches: [] }), scene: () => Promise<unknown | null> = async () => file) => ({ snapshot: async () => snapshot, changes, scene });

test("content sync snapshot validates 13 fields, community categories, and a separate map pointer", async () => {
    const res = response();
    await createSnapshotHandler({ repository: repository() })(req({}, "GET", "https://localhost"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("access-control-allow-origin"), "https://localhost");
    const body = JSON.parse(res.body);
    assert.equal(Object.keys(body.parks[0]).length, 13);
    assert.equal(body.parks[0].category, "community");
    assert.deepEqual(body.drive.parks[park.id], snapshot.drive.parks[park.id]);
    assert.deepEqual(body.map, map);
});

test("content sync preserves the numeric all-null route sentinel for older client readers", async () => {
    const sentinel = { drive: [null], walkM: 0 };
    const legacy = { ...snapshot, drive: { hubs: snapshot.drive.hubs, parks: { [park.id]: sentinel } } };
    const res = response();
    await createSnapshotHandler({ repository: { ...repository(), snapshot: async () => legacy } })(req(), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).drive.parks[park.id], sentinel);
});

test("content sync withholds a snapshot with a non-release-scoped badge descriptor", async () => {
    const res = response();
    const bad = { ...snapshot, assets: [{ ...file, key: "arbitrary/image.webp", url: `${cdn}/arbitrary/image.webp` }] };
    await createSnapshotHandler({ repository: { ...repository(), snapshot: async () => bad } })(req(), res);
    assert.equal(res.statusCode, 503);
    assert.doesNotMatch(res.body, /DATABASE_URL/);
});

test("content sync accepts an empty authoritative catalogue", async () => {
    const empty = {
        ...snapshot,
        parks: [],
        boundaries: { type: "FeatureCollection", features: [] },
        drive: { hubs: snapshot.drive.hubs, parks: {} },
        assets: [],
    };
    const res = response();
    await createSnapshotHandler({ repository: { ...repository(), snapshot: async () => empty } })(req(), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.parks, []);
    assert.deepEqual(body.boundaries.features, []);
    assert.deepEqual(body.drive.parks, {});
    assert.deepEqual(body.assets, []);
});

test("content sync enforces client-compatible park IDs and permits empty regions", async () => {
    const invalidPark = { ...park, id: "bad id" };
    const invalid = response();
    await createSnapshotHandler({ repository: { ...repository(), snapshot: async () => ({ ...snapshot, parks: [invalidPark] }) } })(req(), invalid);
    assert.equal(invalid.statusCode, 503);

    const emptyRegion = response();
    await createSnapshotHandler({ repository: { ...repository(), snapshot: async () => ({ ...snapshot, parks: [{ ...park, region: "" }] }) } })(req(), emptyRegion);
    assert.equal(emptyRegion.statusCode, 200);

    const badDelete = response();
    const repositoryWithBadDelete = repository(async () => ({
        headRevision: 1, retentionFloor: 0, hasMore: false,
        batches: [{ revision: 1, changes: [{ entity: "park", op: "delete", id: "bad id" }] }],
    }));
    await createChangesHandler({ repository: repositoryWithBadDelete })(req({ after: "0" }), badDelete);
    assert.equal(badDelete.statusCode, 503);
});

test("content changes returns whole revisions and resets an expired cursor", async () => {
    const changes = async () => ({ headRevision: 2, retentionFloor: 0, hasMore: false, batches: [{ revision: 2, changes: [{ entity: "park", op: "upsert", id: park.id, value: park }] }] });
    const res = response();
    await createChangesHandler({ repository: repository(changes) })(req({ after: "1", limit: "50" }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { schema: "parkdex.content-sync/v1", fromRevision: 1, throughRevision: 2, headRevision: 2, hasMore: false, batches: [{ revision: 2, changes: [{ entity: "park", op: "upsert", id: park.id, value: park }] }] });

    const expired = response();
    await createChangesHandler({ repository: repository(async () => ({ headRevision: 8, retentionFloor: 5, hasMore: false, batches: [] })) })(req({ after: "4" }), expired);
    assert.equal(expired.statusCode, 410);
    assert.deepEqual(JSON.parse(expired.body), { schema: "parkdex.content-sync/v1", resetRequired: true, headRevision: 8 });
});

test("content changes fails closed when a committed revision batch is missing", async () => {
    const gap = response();
    const damaged = repository(async () => ({ headRevision: 3, retentionFloor: 0, hasMore: false, batches: [{ revision: 2, changes: [{ entity: "park", op: "upsert", id: park.id, value: park }] }] }));
    await createChangesHandler({ repository: damaged })(req({ after: "1" }), gap);
    assert.equal(gap.statusCode, 503);

    const missingAll = response();
    const empty = repository(async () => ({ headRevision: 4, retentionFloor: 0, hasMore: false, batches: [] }));
    await createChangesHandler({ repository: empty })(req({ after: "0" }), missingAll);
    assert.equal(missingAll.statusCode, 503);
});

test("content changes rejects future cursors and only trims at whole batch boundaries", async () => {
    const future = response();
    await createChangesHandler({ repository: repository() })(req({ after: "4" }), future);
    assert.equal(future.statusCode, 400);

    const large = (letter: string, revision: number) => ({ revision, changes: [{ entity: "park", op: "upsert", id: park.id, value: { ...park, blurb: letter.repeat(2_300_000) } }] });
    const bigBatchRepo = repository(async () => ({ headRevision: 2, retentionFloor: 0, hasMore: false, batches: [large("a", 1), large("b", 2)] }));
    const trimmed = response();
    await createChangesHandler({ repository: bigBatchRepo })(req({ after: "0", limit: "50" }), trimmed);
    assert.equal(trimmed.statusCode, 200);
    assert.ok(new TextEncoder().encode(trimmed.body).byteLength <= 4 * 1024 * 1024);
    const body = JSON.parse(trimmed.body);
    assert.equal(body.throughRevision, 1);
    assert.equal(body.hasMore, true);
    assert.equal(body.batches.length, 1);
    assert.equal(body.batches[0].revision, 1);
});

test("scene endpoint serves the exact retained descriptor and returns 404 when missing", async () => {
    const res = response();
    await createSceneHandler({ repository: repository() })(req({ releaseId: release, scene: "cove-a" }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { schema: "parkdex.scene-asset/v1", file });
    const missing = response();
    await createSceneHandler({ repository: repository(async () => ({}), async () => null) })(req({ releaseId: release, scene: "retired-a" }), missing);
    assert.equal(missing.statusCode, 404);
});
