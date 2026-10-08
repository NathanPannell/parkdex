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

test("content sync sends park access fields only to readers that ask for them", async () => {
    const link = "https://maps.app.goo.gl/abc123";
    const withAccess = { ...snapshot, parks: [{ ...park, googleMapsUrl: link, trailheadLat: 48.401, trailheadLng: -123.301 }] };
    const strict = response();
    await createSnapshotHandler({ repository: { ...repository(), snapshot: async () => withAccess } })(req(), strict);
    assert.equal(strict.statusCode, 200);
    assert.deepEqual(Object.keys(JSON.parse(strict.body).parks[0]).sort(), Object.keys(park).sort());

    const current = response();
    await createSnapshotHandler({ repository: { ...repository(), snapshot: async () => withAccess } })(req({ reader: "2" }), current);
    assert.equal(current.statusCode, 200);
    const sent = JSON.parse(current.body).parks[0];
    assert.equal(sent.googleMapsUrl, link);
    assert.equal(sent.trailheadLat, 48.401);
    assert.equal(sent.trailheadLng, -123.301);

    const unset = response();
    await createSnapshotHandler({ repository: repository() })(req({ reader: "2" }), unset);
    assert.equal(JSON.parse(unset.body).parks[0].googleMapsUrl, null);

    const badReader = response();
    await createSnapshotHandler({ repository: repository() })(req({ reader: "x" }), badReader);
    assert.equal(badReader.statusCode, 400);
});

test("content sync strips access fields from change batches for strict readers", async () => {
    const value = { ...park, googleMapsUrl: "https://www.google.com/maps/place/Cove", trailheadLat: null, trailheadLng: null };
    const changes = async () => ({ headRevision: 4, retentionFloor: 0, hasMore: false, batches: [{ revision: 4, changes: [
        { entity: "park", op: "upsert", id: park.id, value },
        { entity: "asset", op: "upsert", id: file.path, value: file },
    ] }] });
    const strict = response();
    await createChangesHandler({ repository: repository(changes) })(req({ after: "3" }), strict);
    assert.equal(strict.statusCode, 200);
    assert.equal(Object.hasOwn(JSON.parse(strict.body).batches[0].changes.find((c: { entity: string }) => c.entity === "park").value, "googleMapsUrl"), false);

    const current = response();
    await createChangesHandler({ repository: repository(changes) })(req({ after: "3", reader: "2" }), current);
    assert.equal(JSON.parse(current.body).batches[0].changes.find((c: { entity: string }) => c.entity === "park").value.googleMapsUrl, value.googleMapsUrl);
});

test("content sync withholds a snapshot with a non-Google directions link or half a trailhead", async () => {
    for (const extra of [
        { googleMapsUrl: "https://example.com/maps", trailheadLat: null, trailheadLng: null },
        { googleMapsUrl: null, trailheadLat: 48.4, trailheadLng: null },
    ]) {
        const res = response();
        const bad = { ...snapshot, parks: [{ ...park, ...extra }] };
        await createSnapshotHandler({ repository: { ...repository(), snapshot: async () => bad } })(req({ reader: "2" }), res);
        assert.equal(res.statusCode, 503);
    }
});

test("content sync preflights allow the app's analytics labels", async () => {
    const res = response();
    await createSnapshotHandler({ repository: repository() })(req({}, "OPTIONS", "https://localhost"), res);
    assert.equal(res.statusCode, 204);
    for (const name of ["X-Kip-Installation-Id", "X-Kip-App-Version", "X-Kip-Bundle-Id"]) {
        assert.match(res.headers.get("access-control-allow-headers") ?? "", new RegExp(name));
    }
});

test("content sync records its repository reads under the content route", async () => {
    const written: Array<{ route: string; installationId: string | null }> = [];
    const pending: Promise<unknown>[] = [];
    const { recordDbQuery } = await import("./requestContext.js");
    const recording = { ...repository(), snapshot: async () => {
        recordDbQuery({ operation: "read", tables: ["public.parks"], durationMs: 1, result: "ok", startedAt: Date.now() });
        return snapshot;
    } };
    const handler = createSnapshotHandler({
        repository: recording,
        analytics: () => ({ async write(context) { written.push(context); } }),
        waitUntil: (promise) => { pending.push(promise); },
    });
    const request = { method: "GET", query: {}, headers: { "x-kip-installation-id": "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b" } };
    await handler(request, response());
    await Promise.all(pending);
    assert.equal(written.length, 1);
    assert.equal(written[0].route, "GET /api/content/snapshot");
    assert.equal(written[0].installationId, "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b");
});

const catalogueVersion = "4".repeat(64);
const pointer = {
    version: catalogueVersion, revision: 3, minimumReader: 3,
    indexUrl: `${cdn}/releases/${catalogueVersion}/catalogue/index.json`,
    indexSha256: catalogueVersion, indexBytes: 1200, parkCount: 1608,
};
const withCatalogue = (state: { pointer: unknown; headRevision: number; retentionFloor: number }) => ({
    ...repository(), snapshot: async (reader?: number) => ({ ...snapshot, revision: reader ?? 1 }), catalogue: async () => state,
});

test("content sync names the CDN catalogue for newer readers and keeps one snapshot body for older ones", async () => {
    const repo = withCatalogue({ pointer, headRevision: 9, retentionFloor: 0 });
    const newer = response();
    await createSnapshotHandler({ repository: repo })(req({ reader: "3" }), newer);
    assert.equal(newer.statusCode, 200);
    assert.deepEqual(JSON.parse(newer.body), {
        schema: "parkdex.content-sync/v1",
        revision: 3,
        catalogue: { schema: "parkdex.content-catalogue/v1", version: catalogueVersion, indexUrl: pointer.indexUrl, indexSha256: catalogueVersion, indexBytes: 1200, parkCount: 1608 },
    });

    // The repository leaves out parks above the reader's floor; the handler asks with the reader.
    for (const reader of ["1", "2"]) {
        const older = response();
        await createSnapshotHandler({ repository: repo })(req({ reader }), older);
        assert.equal(older.statusCode, 200);
        assert.equal(JSON.parse(older.body).revision, Number(reader));
        assert.equal(Object.hasOwn(JSON.parse(older.body), "catalogue"), false);
    }
});

test("content sync falls back to one snapshot body when the catalogue is missing, too new or no longer replayable", async () => {
    for (const state of [
        { pointer: null, headRevision: 9, retentionFloor: 0 },
        { pointer: { ...pointer, revision: 10 }, headRevision: 9, retentionFloor: 0 },
        { pointer, headRevision: 9, retentionFloor: 4 },
        { pointer: { ...pointer, minimumReader: 4 }, headRevision: 9, retentionFloor: 0 },
    ]) {
        const res = response();
        await createSnapshotHandler({ repository: withCatalogue(state) })(req({ reader: "3" }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).revision, 3);
        assert.ok(Array.isArray(JSON.parse(res.body).parks));
    }

    const forged = response();
    await createSnapshotHandler({ repository: withCatalogue({ pointer: { ...pointer, indexUrl: `${cdn}/elsewhere/index.json` }, headRevision: 9, retentionFloor: 0 }) })(req({ reader: "3" }), forged);
    assert.equal(forged.statusCode, 503);
});

test("content changes replace a batch with only hidden parks by the unchanged hub list", async () => {
    let askedReader: number | undefined;
    const hidden = { headRevision: 5, retentionFloor: 0, hasMore: false, hubs: snapshot.drive.hubs, batches: [
        { revision: 4, changes: [] },
        { revision: 5, changes: [{ entity: "park", op: "upsert", id: park.id, value: park }] },
    ] };
    const res = response();
    await createChangesHandler({ repository: { ...repository(async (...args: unknown[]) => { askedReader = args[2] as number; return hidden; }) } })(req({ after: "3", reader: "2" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(askedReader, 2);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.batches[0], { revision: 4, changes: [{ entity: "hubs", op: "upsert", id: "default", value: snapshot.drive.hubs }] });
    assert.equal(body.batches[1].changes[0].entity, "park");
});
