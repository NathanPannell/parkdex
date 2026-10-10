import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { CDN_ORIGIN } from "./publish-content-channel.mjs";
import { bundleVersion, collectBundleFiles, createZip, makeBundlePointer, prepareAppBundle, publicationRow, publishAppBundle, recordPublication, verifyPointerThroughCdn } from "./publish-app-bundle.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads a zip through its central directory, the way unzip tools and the Android updater do. */
function readZip(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const offset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const localNameLength = zip.readUInt16LE(offset + 26);
    const start = offset + 30 + localNameLength;
    const data = zlib.inflateRawSync(zip.subarray(start, start + compressedSize));
    assert.equal(data.length, size);
    assert.equal(zlib.crc32(data) >>> 0, crc);
    files.set(name, data);
    cursor += 46 + nameLength;
  }
  return files;
}

async function distFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "parkdex-app-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await mkdir(join(dist, ".well-known"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html><div id=root></div>");
  await writeFile(join(dist, "assets", "index-abc.js"), "console.log('kip')");
  await writeFile(join(dist, "assets", "a.css"), "body{}");
  await writeFile(join(dist, ".well-known", "assetlinks.json"), "[]");
  await writeFile(join(dist, ".DS_Store"), "junk");
  return { directory, dist };
}

test("collects packaged files in a stable order and leaves dot files out", async (t) => {
  const { dist } = await distFixture(t);
  const files = await collectBundleFiles(dist);
  assert.deepEqual(files.map((file) => file.path), ["assets/a.css", "assets/index-abc.js", "index.html"]);
});

test("zips are readable, keep every byte, and are identical for the same input", () => {
  const entries = [
    { path: "index.html", bytes: Buffer.from("<html></html>") },
    { path: "assets/big.bin", bytes: Buffer.alloc(200_000, 7) },
    { path: "assets/empty.txt", bytes: Buffer.alloc(0) },
  ];
  const zip = createZip(entries);
  const files = readZip(zip);
  assert.equal(files.size, 3);
  for (const entry of entries) assert.deepEqual(files.get(entry.path), entry.bytes);
  assert.equal(hash(createZip(entries)), hash(zip));
});

test("the dry run writes the zip and pointer locally and nothing else", async (t) => {
  const { directory, dist } = await distFixture(t);
  const out = join(directory, "out");
  const prepared = await prepareAppBundle({
    channel: "staging",
    distDirectory: dist,
    outDirectory: out,
    minimumNativeBuild: 12,
    generation: 1,
    sourceCommit: COMMIT,
    now: new Date("2026-10-07T12:00:00.000Z"),
  });
  const zip = await readFile(join(out, prepared.zipSha256 + ".zip"));
  assert.equal(hash(zip), prepared.zipSha256);
  assert.deepEqual([...readZip(zip).keys()], ["assets/a.css", "assets/index-abc.js", "index.html"]);
  assert.deepEqual(JSON.parse(await readFile(join(out, "current.json"), "utf8")), {
    schema: "parkdex.app-bundle-channel/v1",
    channel: "staging",
    generation: 1,
    version: "0123456-" + prepared.zipSha256.slice(0, 8),
    bundleUrl: CDN_ORIGIN + "/app-bundles/" + prepared.zipSha256 + ".zip",
    sha256: prepared.zipSha256,
    byteSize: zip.length,
    minimumNativeBuild: 12,
    maximumNativeBuild: 12,
    sourceCommit: COMMIT,
    publishedAt: "2026-10-07T12:00:00.000Z",
  });
});

test("refuses a bundle without index.html and bad native ranges", async (t) => {
  const { directory } = await distFixture(t);
  const empty = join(directory, "empty");
  await mkdir(empty);
  await assert.rejects(prepareAppBundle({ channel: "staging", distDirectory: empty, outDirectory: join(directory, "o"), minimumNativeBuild: 1, generation: 1, sourceCommit: COMMIT }), /index.html/);
  const base = { channel: "staging", generation: 1, zipSha256: "a".repeat(64), byteSize: 10, sourceCommit: COMMIT, publishedAt: "2026-10-07T12:00:00.000Z" };
  assert.throws(() => makeBundlePointer({ ...base, minimumNativeBuild: 14, maximumNativeBuild: 12 }), /exceed/);
  assert.throws(() => makeBundlePointer({ ...base, minimumNativeBuild: 0, maximumNativeBuild: 12 }), /minimum/);
  assert.throws(() => makeBundlePointer({ ...base, channel: "main", minimumNativeBuild: 12, maximumNativeBuild: 12 }), /channel/);
});

test("versions name the commit, or local for a build outside git", () => {
  assert.equal(bundleVersion(COMMIT, "f".repeat(64)), "0123456-ffffffff");
  assert.equal(bundleVersion("local", "f".repeat(64)), "local-ffffffff");
});

function fakeR2({ pointer = null, etag = '"pointer-1"', zipStatus = 200, pointerStatus = 200 } = {}) {
  const calls = [];
  const stored = new Map();
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET", headers: options.headers ?? {} });
    if (String(url).includes(".r2.cloudflarestorage.com/")) {
      const isZip = String(url).endsWith(".zip");
      if (isZip) stored.set("zip", Buffer.from(options.body));
      return new Response(null, { status: isZip ? zipStatus : pointerStatus, headers: { ETag: '"new"' } });
    }
    if (String(url).endsWith("/current.json")) {
      return pointer ? new Response(JSON.stringify(pointer), { status: 200, headers: { ETag: etag } }) : new Response("missing", { status: 404 });
    }
    if (String(url).endsWith(".zip")) return new Response(stored.get("zip") ?? "missing", { status: stored.has("zip") ? 200 : 404 });
    throw new Error("unexpected " + url);
  };
  return { fetcher, calls, stored };
}

const credentials = { accountId: "c".repeat(32), bucket: "parkdex-kip-content", accessKeyId: "test-access", secretAccessKey: "test-secret", now: new Date("2026-10-07T12:00:00.000Z") };

async function prepared(t, generation = 1) {
  const { directory, dist } = await distFixture(t);
  return prepareAppBundle({ channel: "staging", distDirectory: dist, outDirectory: join(directory, "out"), minimumNativeBuild: 12, generation, sourceCommit: COMMIT });
}

test("apply uploads the zip without overwriting, verifies it, then creates the pointer", async (t) => {
  const bundle = await prepared(t);
  const r2 = fakeR2();
  const result = await publishAppBundle(bundle, { ...credentials, expectedGeneration: 0, fetcher: r2.fetcher });
  const puts = r2.calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 2);
  assert.ok(puts[0].url.endsWith("/parkdex-kip-content/app-bundles/" + bundle.zipSha256 + ".zip"));
  assert.equal(puts[0].headers["If-None-Match"], "*");
  assert.equal(puts[0].headers["Content-Type"], "application/zip");
  assert.equal(puts[0].headers["Cache-Control"], "public, max-age=31536000, immutable");
  assert.ok(puts[1].url.endsWith("/parkdex-kip-content/app-bundles/channels/staging/current.json"));
  assert.equal(puts[1].headers["If-None-Match"], "*");
  assert.equal(puts[1].headers["Content-Type"], "application/json");
  const verifiedBeforePointer = r2.calls.findIndex((call) => call.method === "GET" && call.url === bundle.pointer.bundleUrl);
  assert.ok(verifiedBeforePointer > r2.calls.indexOf(puts[0]) && verifiedBeforePointer < r2.calls.indexOf(puts[1]));
  assert.equal(result.pointerKey, "app-bundles/channels/staging/current.json");
});

test("apply moves an existing pointer only with its exact ETag and generation", async (t) => {
  const bundle = await prepared(t, 2);
  const current = { schema: "parkdex.app-bundle-channel/v1", channel: "staging", generation: 1 };
  await assert.rejects(publishAppBundle(bundle, { ...credentials, expectedGeneration: 1, expectedEtag: '"stale"', fetcher: fakeR2({ pointer: current }).fetcher }), /ETag/);
  await assert.rejects(publishAppBundle(bundle, { ...credentials, expectedGeneration: 0, fetcher: fakeR2({ pointer: current }).fetcher }), /generation/);
  const r2 = fakeR2({ pointer: current });
  await publishAppBundle(bundle, { ...credentials, expectedGeneration: 1, expectedEtag: '"pointer-1"', fetcher: r2.fetcher });
  const pointerPut = r2.calls.filter((call) => call.method === "PUT")[1];
  assert.equal(pointerPut.headers["If-Match"], '"pointer-1"');
});

test("apply refuses a pointer from another channel and a lost race", async (t) => {
  const bundle = await prepared(t, 2);
  const production = { schema: "parkdex.app-bundle-channel/v1", channel: "production", generation: 1 };
  await assert.rejects(publishAppBundle(bundle, { ...credentials, expectedGeneration: 1, expectedEtag: '"pointer-1"', fetcher: fakeR2({ pointer: production }).fetcher }), /not a staging/);
  const raced = fakeR2({ pointer: { ...production, channel: "staging" }, pointerStatus: 412 });
  await assert.rejects(publishAppBundle(bundle, { ...credentials, expectedGeneration: 1, expectedEtag: '"pointer-1"', fetcher: raced.fetcher }), /changed during publication/);
});

test("apply needs every R2 credential and never uploads without them", async (t) => {
  const bundle = await prepared(t);
  const r2 = fakeR2();
  await assert.rejects(publishAppBundle(bundle, { expectedGeneration: 0, fetcher: r2.fetcher }), /R2_ACCOUNT_ID/);
  assert.equal(r2.calls.length, 0);
});

test("apply returns the pointer it replaced, for the publish history", async (t) => {
  const bundle = await prepared(t, 2);
  const current = { schema: "parkdex.app-bundle-channel/v1", channel: "staging", generation: 1, sha256: "d".repeat(64) };
  const result = await publishAppBundle(bundle, { ...credentials, expectedGeneration: 1, expectedEtag: '"pointer-1"', fetcher: fakeR2({ pointer: current }).fetcher });
  assert.equal(result.previous.generation, 1);
  const first = await publishAppBundle(await prepared(t), { ...credentials, expectedGeneration: 0, fetcher: fakeR2().fetcher });
  assert.equal(first.previous, null);
});

test("--record writes one idempotent history row with the CDN readback outcome", async (t) => {
  const bundle = await prepared(t, 2);
  const row = publicationRow(bundle.pointer, { generation: 1, sha256: "d".repeat(64) }, { outcome: "confirmed", note: "Map fix" });
  assert.deepEqual([row.channel, row.generation, row.previousGeneration, row.action, row.source, row.previousSha256, row.minimumNativeBuild, row.note],
    ["staging", 2, 1, "publish", "script", "d".repeat(64), 12, "Map fix"]);
  assert.equal(publicationRow(bundle.pointer, null, { outcome: "confirmed" }).previousGeneration, 0);
  assert.throws(() => publicationRow(bundle.pointer, null, { outcome: "confirmed", note: "x".repeat(301) }), /--note/);

  const calls = [];
  const query = async (text, params) => { calls.push({ text, params }); return calls.length === 1 ? [{ id: 1 }] : []; };
  assert.equal(await recordPublication(query, row), true);
  assert.equal(await recordPublication(query, row), false, "a retried --record adds nothing");
  assert.match(calls[0].text, /INSERT INTO kip_app_config\.ota_publishes/);
  assert.match(calls[0].text, /ON CONFLICT \(channel, generation, sha256\) DO NOTHING/);
  assert.equal(calls[0].params.length, 15);

  const seen = [];
  const cdn = (served, status = 206) => async (url, init) => { seen.push({ url, range: init.headers.Range }); return new Response(JSON.stringify(served), { status }); };
  assert.equal(await verifyPointerThroughCdn(cdn(bundle.pointer), bundle.pointer), "confirmed");
  assert.equal(seen[0].url, CDN_ORIGIN + "/app-bundles/channels/staging/current.json");
  assert.equal(seen[0].range, "bytes=0-", "the readback skips the CDN cache");
  assert.equal(await verifyPointerThroughCdn(cdn({ ...bundle.pointer, generation: 1 }), bundle.pointer), "cdn_pending");
  assert.equal(await verifyPointerThroughCdn(cdn(null, 404), bundle.pointer), "cdn_pending");
});
