#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const CDN_ORIGIN = "https://kip-assets.parkdex.app";
export const POINTER_CACHE_CONTROL = "public, max-age=60, s-maxage=60";
const SHA256 = /^[a-f0-9]{64}$/;
const CHANNELS = new Set(["staging", "main"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function encodePath(value) {
  return value
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(/[!'()*]/g, (character) =>
        "%" + character.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join("/");
}

function assertSafeContentPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("manifest contains an unsafe content path");
  }
}

function validateManifest(manifest, origin = CDN_ORIGIN) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be an object");
  }
  if (typeof manifest.version !== "string" || !SHA256.test(manifest.version)) {
    throw new Error("manifest version must be a SHA-256 release id");
  }
  if (manifest.cdnOrigin !== origin) {
    throw new Error("manifest CDN origin does not match the configured content CDN");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("manifest files must be a non-empty array");
  }

  const seenPaths = new Set();
  const prefix = "releases/" + manifest.version + "/";
  for (const item of manifest.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("manifest file entry must be an object");
    }
    assertSafeContentPath(item.path);
    if (seenPaths.has(item.path)) throw new Error("manifest contains duplicate content paths");
    seenPaths.add(item.path);
    if (item.key !== prefix + item.path) {
      throw new Error("manifest content key does not match its release id");
    }
    if (item.url !== origin + "/" + encodePath(item.key)) {
      throw new Error("manifest content URL does not match its key");
    }
    if (!SHA256.test(item.sha256 ?? "")) {
      throw new Error("manifest content hash is invalid");
    }
    if (!Number.isSafeInteger(item.byte_size) || item.byte_size < 0) {
      throw new Error("manifest content size is invalid");
    }
    if (typeof item.content_type !== "string" || item.content_type.length === 0) {
      throw new Error("manifest content type is invalid");
    }
  }
  return manifest;
}

function validateChannel(value, expectedEnvironment) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("current pointer must be an object");
  }
  const keys = [
    "schema",
    "environment",
    "generation",
    "releaseId",
    "manifestUrl",
    "manifestSha256",
    "minimumReaderVersion",
  ];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("current pointer has unexpected or missing fields");
  }
  if (value.schema !== "parkdex.content-channel/v1") {
    throw new Error("current pointer schema is unsupported");
  }
  if (value.environment !== expectedEnvironment) {
    throw new Error("current pointer environment does not match its channel");
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new Error("current pointer generation must be a positive integer");
  }
  if (typeof value.releaseId !== "string" || !SHA256.test(value.releaseId)) {
    throw new Error("current pointer release id is invalid");
  }
  if (value.manifestUrl !== CDN_ORIGIN + "/releases/" + value.releaseId + "/manifest.json") {
    throw new Error("current pointer manifest URL does not match its release id");
  }
  if (typeof value.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256)) {
    throw new Error("current pointer manifest hash is invalid");
  }
  if (!Number.isSafeInteger(value.minimumReaderVersion) || value.minimumReaderVersion < 1) {
    throw new Error("current pointer minimum reader version is invalid");
  }
  return value;
}

async function readAndCheckSnapshot(snapshotDirectory) {
  const snapshotRoot = resolve(snapshotDirectory);
  const manifestBytes = await readFile(resolve(snapshotRoot, "manifest.json"));
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("snapshot manifest is not valid JSON");
  }
  validateManifest(manifest);

  const contentRoot = resolve(snapshotRoot, "content");
  for (const item of manifest.files) {
    const file = resolve(contentRoot, ...item.path.split("/"));
    const localPath = relative(contentRoot, file);
    if (
      localPath === "" ||
      localPath === ".." ||
      localPath.startsWith(".." + sep) ||
      isAbsolute(localPath)
    ) {
      throw new Error("manifest content path escapes the snapshot");
    }
    const bytes = await readFile(file);
    if (bytes.byteLength !== item.byte_size || sha256(bytes) !== item.sha256) {
      throw new Error("snapshot content differs from manifest: " + item.path);
    }
  }
  return { manifest, manifestBytes, manifestSha256: sha256(manifestBytes) };
}

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function verifyRemoteBytes(fetcher, url, expected, description) {
  const response = await fetcher(url, { method: "GET", cache: "no-store" });
  if (!response.ok) {
    throw new Error(description + " is unavailable (" + response.status + ")");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== expected.byte_size || sha256(bytes) !== expected.sha256) {
    throw new Error(description + " failed byte/hash verification");
  }
}

export async function verifyPublishedRelease(snapshotDirectory, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("verification concurrency must be between 1 and 8");
  }

  const snapshot = await readAndCheckSnapshot(snapshotDirectory);
  const manifestUrl =
    CDN_ORIGIN + "/releases/" + snapshot.manifest.version + "/manifest.json";
  const publishedManifest = await fetcher(manifestUrl, {
    method: "GET",
    cache: "no-store",
  });
  if (!publishedManifest.ok) {
    throw new Error("published release manifest is unavailable (" + publishedManifest.status + ")");
  }
  const publishedManifestBytes = new Uint8Array(await publishedManifest.arrayBuffer());
  if (sha256(publishedManifestBytes) !== snapshot.manifestSha256) {
    throw new Error("published release manifest does not exactly match the snapshot");
  }

  await mapConcurrent(snapshot.manifest.files, concurrency, async (item) => {
    await verifyRemoteBytes(fetcher, item.url, item, "published content " + item.path);
  });
  return {
    ...snapshot,
    manifestUrl,
    verifiedAssetCount: snapshot.manifest.files.length,
  };
}

export function makeContentChannel(snapshot, environment, generation) {
  if (!CHANNELS.has(environment)) throw new Error("environment must be staging or main");
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("generation must be a positive integer");
  }
  const pointer = {
    schema: "parkdex.content-channel/v1",
    environment,
    generation,
    releaseId: snapshot.manifest.version,
    manifestUrl: snapshot.manifestUrl,
    manifestSha256: snapshot.manifestSha256,
    minimumReaderVersion: 1,
  };
  return validateChannel(pointer, environment);
}

function awsSigningKey(secret, dateStamp) {
  const dateKey = hmac("AWS4" + secret, dateStamp);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

export function signR2Put({
  url,
  body,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  condition,
  now = new Date(),
}) {
  if (!condition || (condition.type !== "if-match" && condition.type !== "if-none-match")) {
    throw new Error("R2 pointer write requires an If-Match or If-None-Match condition");
  }
  if (condition.type === "if-match" && !condition.etag) {
    throw new Error("If-Match requires the expected pointer ETag");
  }
  if (condition.type === "if-none-match" && condition.etag !== undefined) {
    throw new Error("If-None-Match must not include an ETag value");
  }

  const dateStamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  const amzDate = dateStamp + "T" + now.toISOString().slice(11, 19).replaceAll(":", "") + "Z";
  const payloadHash = sha256(body);
  const requestUrl = new URL(url);
  const conditionalHeader =
    condition.type === "if-match" ? "if-match" : "if-none-match";
  const conditionalValue = condition.type === "if-match" ? condition.etag : "*";
  const canonicalHeaders = {
    "cache-control": POINTER_CACHE_CONTROL,
    "content-type": "application/json",
    host: requestUrl.host,
    [conditionalHeader]: conditionalValue,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (sessionToken) canonicalHeaders["x-amz-security-token"] = sessionToken;
  const signedHeaders = Object.keys(canonicalHeaders).sort().join(";");
  const canonicalHeaderText = Object.keys(canonicalHeaders)
    .sort()
    .map((name) => name + ":" + String(canonicalHeaders[name]).trim() + "\n")
    .join("");
  const canonicalRequest = [
    "PUT",
    requestUrl.pathname,
    requestUrl.search.slice(1),
    canonicalHeaderText,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = dateStamp + "/auto/s3/aws4_request";
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = createHmac("sha256", awsSigningKey(secretAccessKey, dateStamp))
    .update(stringToSign)
    .digest("hex");
  const authorization =
    "AWS4-HMAC-SHA256 Credential=" +
    accessKeyId +
    "/" +
    scope +
    ", SignedHeaders=" +
    signedHeaders +
    ", Signature=" +
    signature;
  const headers = {
    "Cache-Control": POINTER_CACHE_CONTROL,
    "Content-Type": "application/json",
    [conditionalHeader === "if-match" ? "If-Match" : "If-None-Match"]: conditionalValue,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization: authorization,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  return headers;
}

function r2ObjectUrl(accountId, bucket, key) {
  return (
    "https://" +
    accountId +
    ".r2.cloudflarestorage.com/" +
    encodeURIComponent(bucket) +
    "/" +
    encodePath(key)
  );
}

async function checkExpectedPointer({
  environment,
  expectedGeneration,
  expectedEtag,
  fetcher,
}) {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new Error("expected generation must be a non-negative integer");
  }
  if (expectedGeneration === 0 && expectedEtag) {
    throw new Error("initial pointer creation must use expected generation 0 without an ETag");
  }
  if (expectedGeneration > 0 && !expectedEtag) {
    throw new Error("updates require the expected current pointer ETag");
  }

  const url = CDN_ORIGIN + "/channels/" + environment + "/current.json";
  const response = await fetcher(url, { method: "GET", cache: "no-store" });
  if (response.status === 404) {
    if (expectedGeneration !== 0) {
      throw new Error("current pointer is absent but an existing generation was expected");
    }
    return { type: "if-none-match" };
  }
  if (!response.ok) {
    throw new Error("current pointer could not be read (" + response.status + ")");
  }

  let pointer;
  try {
    pointer = validateChannel(await response.json(), environment);
  } catch (error) {
    throw new Error(
      "current pointer is invalid: " +
        (error instanceof Error ? error.message : "invalid JSON"),
    );
  }
  if (pointer.generation !== expectedGeneration) {
    throw new Error("current pointer generation changed; refusing a stale update");
  }
  const observedEtag = response.headers.get("ETag");
  if (!observedEtag || observedEtag !== expectedEtag) {
    throw new Error("current pointer ETag changed; refusing a stale update");
  }
  return { type: "if-match", etag: expectedEtag };
}

export async function publishContentChannel(options) {
  const environment = options.environment;
  if (!CHANNELS.has(environment)) throw new Error("environment must be staging or main");
  const generation = options.generation;
  const expectedGeneration = options.expectedGeneration;
  if (!Number.isSafeInteger(generation) || generation !== expectedGeneration + 1) {
    throw new Error("new generation must be expectedGeneration + 1");
  }
  const fetcher = options.fetcher ?? fetch;

  const prepared = await prepareContentChannel(options);
  const pointer = prepared.pointer;
  const pointerBytes = prepared.pointerBytes;
  const condition = prepared.condition;
  const accountId = options.accountId;
  const bucket = options.bucket;
  const accessKeyId = options.accessKeyId;
  const secretAccessKey = options.secretAccessKey;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required to publish",
    );
  }

  const url = r2ObjectUrl(accountId, bucket, "channels/" + environment + "/current.json");
  const headers = signR2Put({
    url,
    body: pointerBytes,
    accessKeyId,
    secretAccessKey,
    sessionToken: options.sessionToken,
    condition,
    now: options.now ?? new Date(),
  });
  const uploaded = await fetcher(url, {
    method: "PUT",
    headers,
    body: pointerBytes,
  });
  if (uploaded.status === 412) {
    throw new Error("current pointer changed during publication; conditional write was rejected");
  }
  if (!uploaded.ok) {
    throw new Error("current pointer upload failed (" + uploaded.status + ")");
  }
  return {
    environment,
    generation,
    releaseId: pointer.releaseId,
    manifestSha256: pointer.manifestSha256,
    verifiedAssetCount: prepared.verifiedAssetCount,
    pointerSha256: sha256(pointerBytes),
    r2Etag: uploaded.headers.get("ETag"),
    pointer,
  };
}

export async function prepareContentChannel(options) {
  const environment = options.environment;
  if (!CHANNELS.has(environment)) throw new Error("environment must be staging or main");
  const expectedGeneration = options.expectedGeneration;
  const generation = options.generation;
  if (!Number.isSafeInteger(generation) || generation !== expectedGeneration + 1) {
    throw new Error("new generation must be expectedGeneration + 1");
  }
  const fetcher = options.fetcher ?? fetch;
  const snapshot = await verifyPublishedRelease(options.snapshotDirectory, {
    fetcher,
    concurrency: options.concurrency ?? 4,
  });
  const condition = await checkExpectedPointer({
    environment,
    expectedGeneration,
    expectedEtag: options.expectedEtag,
    fetcher,
  });
  const pointer = makeContentChannel(snapshot, environment, generation);
  const pointerBytes = JSON.stringify(pointer, null, 2) + "\n";
  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, pointerBytes, { encoding: "utf8" });
  }
  return {
    pointer,
    pointerBytes,
    condition,
    environment,
    generation,
    releaseId: pointer.releaseId,
    manifestSha256: pointer.manifestSha256,
    verifiedAssetCount: snapshot.verifiedAssetCount,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error("unexpected argument: " + name);
    if (name === "--prepare-only") {
      result["prepare-only"] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("missing value for " + name);
    result[name.slice(2)] = value;
    index += 1;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expectedGeneration = Number(args["expected-generation"]);
  const generation = Number(args.generation);
  if (!args.output) throw new Error("--output is required");
  if (args["prepare-only"]) {
    const result = await prepareContentChannel({
      environment: args.environment,
      snapshotDirectory: args.snapshot,
      outputPath: args.output,
      generation,
      expectedGeneration,
      expectedEtag: args["expected-etag"],
      concurrency: Number(args.concurrency ?? 4),
    });
    process.stdout.write(
      JSON.stringify({
        environment: result.environment,
        generation: result.generation,
        releaseId: result.releaseId,
        manifestSha256: result.manifestSha256,
        verifiedAssetCount: result.verifiedAssetCount,
        pointerSha256: sha256(result.pointerBytes),
        conditionalWrite:
          result.condition.type === "if-match"
            ? { header: "If-Match", value: result.condition.etag }
            : { header: "If-None-Match", value: "*" },
        output: resolve(args.output),
      }) + "\n",
    );
    return;
  }
  const result = await publishContentChannel({
    environment: args.environment,
    snapshotDirectory: args.snapshot,
    outputPath: args.output,
    generation,
    expectedGeneration,
    expectedEtag: args["expected-etag"],
    concurrency: Number(args.concurrency ?? 4),
    accountId: process.env.R2_ACCOUNT_ID,
    bucket: process.env.R2_BUCKET,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    sessionToken: process.env.R2_SESSION_TOKEN,
  });
  process.stdout.write(
    JSON.stringify({
      environment: result.environment,
      generation: result.generation,
      releaseId: result.releaseId,
      manifestSha256: result.manifestSha256,
      verifiedAssetCount: result.verifiedAssetCount,
      pointerSha256: result.pointerSha256,
      r2Etag: result.r2Etag,
    }) + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(
      "publish-content-channel: " +
        (error instanceof Error ? error.message : "publication failed") +
        "\n",
    );
    process.exitCode = 1;
  });
}
