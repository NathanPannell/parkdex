// Uploads a map-only release built by scripts/build-map-inventory.py to the content R2 bucket.
// Objects are immutable: an existing key with the same size is skipped, and a different size
// stops the upload instead of overwriting it. The inventory manifest is uploaded last, so the
// release is only discoverable once every file it names is present.
// Usage (CLOUDFLARE_API_TOKEN in the environment):
//   node scripts/upload-map-release.mjs --release-dir .tools/bc-map-release --version <sha256>
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const ACCOUNT_ID = "6f0eb57971124f41fadc7897ace74dac";
const BUCKET = "parkdex-kip-content";
const CDN_ORIGIN = "https://kip-assets.parkdex.app";
const CONCURRENCY = 8;

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!/^[a-f0-9]{64}$/.test(args.version ?? "")) throw new Error("--version must be the release SHA-256");
const releaseRoot = join(args["release-dir"], "releases", args.version);

async function listFiles(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(path));
    else out.push(path);
  }
  return out;
}

function contentType(key) {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".bin")) return "application/octet-stream";
  throw new Error(`Unexpected map release file: ${key}`);
}

async function existingSize(key) {
  const response = await fetch(`${CDN_ORIGIN}/${key.split("/").map(encodeURIComponent).join("/")}`, { method: "HEAD" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HEAD ${key} returned ${response.status}`);
  return Number(response.headers.get("content-length"));
}

async function put(key, body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType(key) },
      body,
    });
    if (response.ok) return;
    if (attempt >= 4 || (response.status < 500 && response.status !== 429)) {
      throw new Error(`PUT ${key} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
}

async function upload(path) {
  const key = ["releases", args.version, ...relative(releaseRoot, path).split(sep)].join("/");
  const size = (await stat(path)).size;
  const existing = await existingSize(key);
  if (existing === size) return "skipped";
  if (existing !== null) throw new Error(`${key} already exists with ${existing} bytes; release objects are immutable`);
  await put(key, await readFile(path));
  return "uploaded";
}

const manifestPath = join(releaseRoot, "map", "manifest.json");
const files = (await listFiles(releaseRoot)).filter((path) => path !== manifestPath);
const counts = { uploaded: 0, skipped: 0 };
let next = 0;
async function worker() {
  while (next < files.length) {
    const path = files[next++];
    counts[await upload(path)] += 1;
    const done = counts.uploaded + counts.skipped;
    if (done % 100 === 0) console.log(`${done}/${files.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
counts[await upload(manifestPath)] += 1;
console.log(JSON.stringify({ version: args.version, ...counts }));
