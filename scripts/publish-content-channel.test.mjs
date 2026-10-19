import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CDN_ORIGIN, prepareContentChannel, publishContentChannel } from "./publish-content-channel.mjs";

const RELEASE = "a".repeat(64);
const CONTENT = Buffer.from('{"parks":[]}');

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "parkdex-channel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const item = {
    path: "data/parks.json",
    key: "releases/" + RELEASE + "/data/parks.json",
    url: CDN_ORIGIN + "/releases/" + RELEASE + "/data/parks.json",
    sha256: hash(CONTENT),
    byte_size: CONTENT.byteLength,
    content_type: "application/json",
  };
  const manifest = {
    version: RELEASE,
    sourceCommit: "b".repeat(40),
    cdnOrigin: CDN_ORIGIN,
    files: [item],
    parkIds: [],
    boundaryIds: [],
    mapManifest: { size: 1, chunkBytes: 1, count: 1 },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await mkdir(join(directory, "content", "data"), { recursive: true });
  await writeFile(join(directory, "manifest.json"), manifestBytes);
  await writeFile(join(directory, "content", "data", "parks.json"), CONTENT);
  return { directory, manifest, manifestBytes, item };
}

function publicFetch(fixtureValue, currentResponse = new Response("missing", { status: 404 })) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === CDN_ORIGIN + "/releases/" + RELEASE + "/manifest.json") {
      return new Response(fixtureValue.manifestBytes, { status: 200 });
    }
    if (url === fixtureValue.item.url) return new Response(CONTENT, { status: 200 });
    if (url === CDN_ORIGIN + "/channels/staging/current.json") {
      return currentResponse;
    }
    if (String(url).includes(".r2.cloudflarestorage.com/") && options.method === "PUT") {
      return new Response(null, { status: 200, headers: { ETag: '"uploaded"' } });
    }
    throw new Error("unexpected request " + url);
  };
  return { fetcher, calls };
}

const credentials = {
  accountId: "c".repeat(32),
  bucket: "parkdex-kip-content",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  now: new Date("2026-09-27T17:18:19.000Z"),
};

test("prepare verifies the exact published manifest and every asset before writing a pointer file", async (t) => {
  const sample = await fixture(t);
  const outputPath = join(sample.directory, "prepared", "current.json");
  const { fetcher, calls } = publicFetch(sample);
  const result = await prepareContentChannel({
    environment: "staging",
    snapshotDirectory: sample.directory,
    generation: 1,
    expectedGeneration: 0,
    outputPath,
    fetcher,
  });
  assert.deepEqual(result.pointer, {
    schema: "parkdex.content-channel/v1",
    environment: "staging",
    generation: 1,
    releaseId: RELEASE,
    manifestUrl: CDN_ORIGIN + "/releases/" + RELEASE + "/manifest.json",
    manifestSha256: hash(sample.manifestBytes),
    minimumReaderVersion: 1,
  });
  assert.equal(result.condition.type, "if-none-match");
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result.pointer);
  assert.equal(calls.filter((call) => call.url.includes(".r2.cloudflarestorage.com/")).length, 0);
  assert.deepEqual(
    calls.slice(0, 2).map((call) => call.url),
    [CDN_ORIGIN + "/releases/" + RELEASE + "/manifest.json", sample.item.url],
  );
});

test("initial publication uploads only after verification with If-None-Match: *", async (t) => {
  const sample = await fixture(t);
  const outputPath = join(sample.directory, "current.json");
  const { fetcher, calls } = publicFetch(sample);
  const result = await publishContentChannel({
    ...credentials,
    environment: "staging",
    snapshotDirectory: sample.directory,
    generation: 1,
    expectedGeneration: 0,
    outputPath,
    fetcher,
  });
  const put = calls.find((call) => call.options.method === "PUT");
  assert.ok(put);
  assert.equal(put.url, "https://cccccccccccccccccccccccccccccccc.r2.cloudflarestorage.com/parkdex-kip-content/channels/staging/current.json");
  assert.equal(put.options.headers["If-None-Match"], "*");
  assert.equal(put.options.headers["If-Match"], undefined);
  assert.equal(put.options.headers["Cache-Control"], "public, max-age=60, s-maxage=60");
  assert.match(put.options.headers.Authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(JSON.parse(put.options.body).generation, 1);
  assert.ok(calls.findIndex((call) => call.options.method === "PUT") > calls.findIndex((call) => call.url === sample.item.url));
  assert.equal(result.r2Etag, '"uploaded"');
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result.pointer);
});

test("temporary R2 credentials include their session token in SigV4", async (t) => {
  const sample = await fixture(t);
  const { fetcher, calls } = publicFetch(sample);
  await publishContentChannel({
    ...credentials,
    sessionToken: "temporary-session-token",
    environment: "staging",
    snapshotDirectory: sample.directory,
    generation: 1,
    expectedGeneration: 0,
    fetcher,
  });
  const put = calls.find((call) => call.options.method === "PUT");
  assert.equal(put.options.headers["x-amz-security-token"], "temporary-session-token");
  assert.match(put.options.headers.Authorization, /SignedHeaders=[^,]*x-amz-security-token/);
});

test("updates require both the expected generation and ETag before If-Match publication", async (t) => {
  const sample = await fixture(t);
  const currentPointer = {
    schema: "parkdex.content-channel/v1",
    environment: "staging",
    generation: 4,
    releaseId: "d".repeat(64),
    manifestUrl: CDN_ORIGIN + "/releases/" + "d".repeat(64) + "/manifest.json",
    manifestSha256: "e".repeat(64),
    minimumReaderVersion: 1,
  };
  const currentResponse = new Response(JSON.stringify(currentPointer), {
    status: 200,
    headers: { ETag: '"current-v4"' },
  });
  const { fetcher, calls } = publicFetch(sample, currentResponse);
  await publishContentChannel({
    ...credentials,
    environment: "staging",
    snapshotDirectory: sample.directory,
    generation: 5,
    expectedGeneration: 4,
    expectedEtag: '"current-v4"',
    fetcher,
  });
  const put = calls.find((call) => call.options.method === "PUT");
  assert.equal(put.options.headers["If-Match"], '"current-v4"');
  assert.equal(put.options.headers["If-None-Match"], undefined);
});

test("a published manifest with different exact bytes blocks pointer preparation", async (t) => {
  const sample = await fixture(t);
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return new Response("different manifest bytes", { status: 200 });
  };
  await assert.rejects(
    prepareContentChannel({
      environment: "staging",
      snapshotDirectory: sample.directory,
      generation: 1,
      expectedGeneration: 0,
      fetcher,
    }),
    /does not exactly match the snapshot/,
  );
  assert.deepEqual(calls, [CDN_ORIGIN + "/releases/" + RELEASE + "/manifest.json"]);
});

test("stale generations and failed byte checks never upload a pointer", async (t) => {
  const sample = await fixture(t);
  const currentPointer = {
    schema: "parkdex.content-channel/v1",
    environment: "staging",
    generation: 2,
    releaseId: "d".repeat(64),
    manifestUrl: CDN_ORIGIN + "/releases/" + "d".repeat(64) + "/manifest.json",
    manifestSha256: "e".repeat(64),
    minimumReaderVersion: 1,
  };
  const current = new Response(JSON.stringify(currentPointer), {
    status: 200,
    headers: { ETag: '"current-v2"' },
  });
  const staleSetup = publicFetch(sample, current);
  await assert.rejects(
    publishContentChannel({
      ...credentials,
      environment: "staging",
      snapshotDirectory: sample.directory,
      generation: 2,
      expectedGeneration: 1,
      expectedEtag: '"current-v1"',
      fetcher: staleSetup.fetcher,
    }),
    /generation changed/,
  );
  assert.equal(
    staleSetup.calls.some((call) => call.options.method === "PUT"),
    false,
  );

  const badSetup = publicFetch(sample);
  const badCalls = [];
  const originalBadFetcher = badSetup.fetcher;
  badSetup.fetcher = async (url, options = {}) => {
    badCalls.push({ url: String(url), options });
    if (url === sample.item.url) return new Response("changed bytes", { status: 200 });
    return originalBadFetcher(url, options);
  };
  await assert.rejects(
    publishContentChannel({
      ...credentials,
      environment: "staging",
      snapshotDirectory: sample.directory,
      generation: 1,
      expectedGeneration: 0,
      fetcher: badSetup.fetcher,
    }),
    /failed byte\/hash verification/,
  );
  assert.equal(
    badCalls.some((call) => call.options.method === "PUT"),
    false,
  );
});
