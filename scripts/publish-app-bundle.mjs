#!/usr/bin/env node
// Builds the web bundle for an over-the-air channel, zips it deterministically, and writes the
// channel pointer. Dry run by default: nothing leaves the machine without --apply.
//
//   node scripts/publish-app-bundle.mjs --channel staging --min-native-build 12
//   node scripts/publish-app-bundle.mjs --channel staging --min-native-build 12 --apply \
//     --expected-generation 0
//
// See docs/ota-updates.md for the release steps and the credentials --apply needs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { CDN_ORIGIN, POINTER_CACHE_CONTROL, r2ObjectUrl, signR2Put } from "./publish-content-channel.mjs";

export const BUNDLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const POINTER_SCHEMA = "parkdex.app-bundle-channel/v1";
export const CHANNELS = ["staging", "production"];
const BUILD_SCRIPTS = { staging: "build:field", production: "build:field:production" };
const MAX_BUILD = 2_100_000_000;
const SHA256 = /^[a-f0-9]{64}$/;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(bytes) >>> 0;
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertBuild(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BUILD) {
    throw new Error(name + " must be a whole native version code");
  }
  return value;
}

/**
 * Every file the native build would package, sorted. Dot files are left out because Android
 * packaging drops them too and the updater refuses hidden entries.
 */
export async function collectBundleFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = prefix ? prefix + "/" + entry.name : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectBundleFiles(absolute, path)));
    else if (entry.isFile()) files.push({ path, absolute });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A plain deflate zip with fixed timestamps and sorted entries, so the same build always has
 * the same bytes and therefore the same immutable key.
 */
export function createZip(entries) {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, the earliest DOS date.
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.bytes);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset > 0xffffffff || entries.length > 0xffff) throw new Error("bundle is too large for a plain zip");
  return Buffer.concat([...locals, centralBytes, end]);
}

/** Readable and unique: the source commit, then the start of the zip hash. */
export function bundleVersion(sourceCommit, zipSha256) {
  const source = /^[a-f0-9]{7,40}$/i.test(sourceCommit) ? sourceCommit.slice(0, 7).toLowerCase() : "local";
  return source + "-" + zipSha256.slice(0, 8);
}

export function bundleUrl(origin, zipSha256) {
  return origin + "/app-bundles/" + zipSha256 + ".zip";
}

export function makeBundlePointer({
  channel,
  generation,
  zipSha256,
  byteSize,
  minimumNativeBuild,
  maximumNativeBuild,
  sourceCommit,
  publishedAt,
  origin = CDN_ORIGIN,
}) {
  if (!CHANNELS.includes(channel)) throw new Error("channel must be staging or production");
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("generation must be a positive integer");
  if (!SHA256.test(zipSha256 ?? "")) throw new Error("bundle hash must be a SHA-256");
  if (!Number.isSafeInteger(byteSize) || byteSize < 1) throw new Error("bundle size is invalid");
  assertBuild(minimumNativeBuild, "minimum native build");
  assertBuild(maximumNativeBuild, "maximum native build");
  if (minimumNativeBuild > maximumNativeBuild) throw new Error("minimum native build cannot exceed the maximum");
  if (typeof sourceCommit !== "string" || sourceCommit.length === 0 || sourceCommit.length > 64) {
    throw new Error("source commit is invalid");
  }
  return {
    schema: POINTER_SCHEMA,
    channel,
    generation,
    version: bundleVersion(sourceCommit, zipSha256),
    bundleUrl: bundleUrl(origin, zipSha256),
    sha256: zipSha256,
    byteSize,
    minimumNativeBuild,
    maximumNativeBuild,
    sourceCommit,
    publishedAt,
  };
}

/** Zips `distDirectory` and writes `<sha>.zip` and `current.json` into `outDirectory`. */
export async function prepareAppBundle({
  channel,
  distDirectory,
  outDirectory,
  minimumNativeBuild,
  maximumNativeBuild = minimumNativeBuild,
  generation,
  sourceCommit,
  now = new Date(),
  origin = CDN_ORIGIN,
}) {
  const files = await collectBundleFiles(resolve(distDirectory));
  if (!files.some((file) => file.path === "index.html")) throw new Error("the bundle has no index.html at its root");
  const entries = [];
  for (const file of files) entries.push({ path: file.path, bytes: await readFile(file.absolute) });
  const zip = createZip(entries);
  const zipSha256 = sha256(zip);
  const pointer = makeBundlePointer({
    channel,
    generation,
    zipSha256,
    byteSize: zip.length,
    minimumNativeBuild,
    maximumNativeBuild,
    sourceCommit,
    publishedAt: now.toISOString(),
    origin,
  });
  const pointerBytes = JSON.stringify(pointer, null, 2) + "\n";
  const out = resolve(outDirectory);
  await mkdir(out, { recursive: true });
  const zipPath = join(out, zipSha256 + ".zip");
  const pointerPath = join(out, "current.json");
  await writeFile(zipPath, zip);
  await writeFile(pointerPath, pointerBytes, "utf8");
  return { pointer, pointerBytes, zip, zipSha256, zipPath, pointerPath, fileCount: files.length };
}

async function readCurrentPointer(fetcher, channel, expectedGeneration, expectedEtag) {
  const response = await fetcher(CDN_ORIGIN + "/app-bundles/channels/" + channel + "/current.json", { method: "GET", cache: "no-store" });
  if (response.status === 404) {
    if (expectedGeneration !== 0) throw new Error("no pointer is published, but generation " + expectedGeneration + " was expected");
    return { type: "if-none-match" };
  }
  if (!response.ok) throw new Error("the current pointer could not be read (" + response.status + ")");
  const current = await response.json();
  if (current?.schema !== POINTER_SCHEMA || current.channel !== channel) throw new Error("the current pointer is not a " + channel + " app bundle pointer");
  if (current.generation !== expectedGeneration) throw new Error("the current pointer is generation " + current.generation + ", not " + expectedGeneration);
  const etag = response.headers.get("ETag");
  if (!etag || etag !== expectedEtag) throw new Error("the current pointer ETag changed; pass --expected-etag " + etag);
  return { type: "if-match", etag };
}

async function verifyPublicBytes(fetcher, url, expectedSha256, description) {
  const response = await fetcher(url, { method: "GET", cache: "no-store" });
  if (!response.ok) throw new Error(description + " is not public yet (" + response.status + ")");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== expectedSha256) throw new Error(description + " does not match the uploaded bytes");
}

/**
 * Uploads the immutable zip (never overwriting), verifies it through the CDN, then moves the
 * pointer with a conditional write so two publishers cannot race.
 */
export async function publishAppBundle(prepared, options) {
  const { channel } = prepared.pointer;
  const { accountId, bucket, accessKeyId, secretAccessKey, sessionToken } = options;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required with --apply");
  }
  if (prepared.pointer.generation !== options.expectedGeneration + 1) throw new Error("generation must be expected generation + 1");
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? new Date();
  const condition = await readCurrentPointer(fetcher, channel, options.expectedGeneration, options.expectedEtag);

  const zipKey = "app-bundles/" + prepared.zipSha256 + ".zip";
  const zipUrl = r2ObjectUrl(accountId, bucket, zipKey);
  const zipHeaders = signR2Put({
    url: zipUrl, body: prepared.zip, accessKeyId, secretAccessKey, sessionToken, now,
    condition: { type: "if-none-match" }, contentType: "application/zip", cacheControl: BUNDLE_CACHE_CONTROL,
  });
  const zipUpload = await fetcher(zipUrl, { method: "PUT", headers: zipHeaders, body: prepared.zip });
  // 412 means this exact content-addressed object already exists; the CDN check below proves it.
  if (!zipUpload.ok && zipUpload.status !== 412) throw new Error("bundle upload failed (" + zipUpload.status + ")");
  await verifyPublicBytes(fetcher, prepared.pointer.bundleUrl, prepared.zipSha256, "the bundle");

  const pointerKey = "app-bundles/channels/" + channel + "/current.json";
  const pointerUrl = r2ObjectUrl(accountId, bucket, pointerKey);
  const pointerHeaders = signR2Put({
    url: pointerUrl, body: prepared.pointerBytes, accessKeyId, secretAccessKey, sessionToken, now,
    condition, contentType: "application/json", cacheControl: POINTER_CACHE_CONTROL,
  });
  const pointerUpload = await fetcher(pointerUrl, { method: "PUT", headers: pointerHeaders, body: prepared.pointerBytes });
  if (pointerUpload.status === 412) throw new Error("the pointer changed during publication; nothing was moved");
  if (!pointerUpload.ok) throw new Error("pointer upload failed (" + pointerUpload.status + ")");
  return { zipKey, pointerKey, r2Etag: pointerUpload.headers.get("ETag") };
}

function parseArgs(argv) {
  const flags = new Set(["--apply", "--skip-build"]);
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error("unexpected argument: " + name);
    if (flags.has(name)) {
      result[name.slice(2)] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("missing value for " + name);
    result[name.slice(2)] = value;
    index += 1;
  }
  return result;
}

function runNpmScript(name, env) {
  // npm is a .cmd shim on Windows and needs a shell; the script name is from a fixed list.
  const result = spawnSync("npm run " + name, { cwd: projectRoot, stdio: "inherit", shell: true, env });
  if (result.status !== 0) throw new Error("npm run " + name + " failed");
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error("node " + args.join(" ") + " failed");
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const channel = args.channel;
  if (!CHANNELS.includes(channel)) throw new Error("--channel must be staging or production");
  const minimumNativeBuild = assertBuild(Number(args["min-native-build"]), "--min-native-build");
  const maximumNativeBuild = assertBuild(Number(args["max-native-build"] ?? args["min-native-build"]), "--max-native-build");
  const expectedGeneration = Number(args["expected-generation"] ?? 0);
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("--expected-generation must be 0 or more");
  const distDirectory = resolve(projectRoot, args.dist ?? "dist");
  const outDirectory = resolve(projectRoot, args.out ?? join(".codex", "app-bundles", channel));

  const sourceCommit = process.env.RELEASE_SHA || gitOutput(["rev-parse", "HEAD"]) || "local";
  const dirty = gitOutput(["status", "--porcelain"]);
  if (args.apply && dirty !== "") throw new Error("--apply needs a clean checkout so the bundle matches its commit");

  if (!args["skip-build"]) runNpmScript(BUILD_SCRIPTS[channel], { ...process.env, RELEASE_SHA: sourceCommit });
  // The same check the native package gets: no park catalogue, boundaries or detailed maps inside.
  runNode([join("scripts", "check-content-package.mjs"), distDirectory]);

  const prepared = await prepareAppBundle({
    channel,
    distDirectory,
    outDirectory,
    minimumNativeBuild,
    maximumNativeBuild,
    generation: expectedGeneration + 1,
    sourceCommit,
    origin: (process.env.APP_BUNDLE_ORIGIN || CDN_ORIGIN).replace(/\/+$/, ""),
  });
  const summary = {
    mode: args.apply ? "apply" : "dry-run",
    channel,
    version: prepared.pointer.version,
    generation: prepared.pointer.generation,
    nativeBuilds: [minimumNativeBuild, maximumNativeBuild],
    files: prepared.fileCount,
    bytes: prepared.zip.length,
    sha256: prepared.zipSha256,
    zip: prepared.zipPath,
    pointer: prepared.pointerPath,
    uncommittedChanges: dirty !== "",
  };
  if (args.apply) {
    if (process.env.APP_BUNDLE_ORIGIN) throw new Error("APP_BUNDLE_ORIGIN is for local QA only; unset it to publish");
    const published = await publishAppBundle(prepared, {
      expectedGeneration,
      expectedEtag: args["expected-etag"],
      accountId: process.env.R2_ACCOUNT_ID,
      bucket: process.env.R2_BUCKET,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      sessionToken: process.env.R2_SESSION_TOKEN,
    });
    Object.assign(summary, published);
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write("publish-app-bundle: " + (error instanceof Error ? error.message : "publication failed") + "\n");
    process.exitCode = 1;
  });
}
