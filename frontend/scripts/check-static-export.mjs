import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(frontendRoot, "out");
const parkRoutes = JSON.parse(readFileSync(resolve(frontendRoot, "lib/park-routes.json"), "utf8"));
const requiredFiles = [
  "index.html",
  "map.html",
  "places.html",
  "groups.html",
  "badges.html",
  "account.html",
  "settings.html",
  "migrate.html",
  "migrate/index.html",
  "auth/google/callback.html",
  "maplibre/maplibre-gl-worker.mjs",
  "data/boundaries.v1.geojson",
  "data/boundaries-display.v1.geojson",
  "data/exploration-territories.v1.geojson",
  "data/bc-focus-mask.v1.geojson",
  "places/place-placeholder.png",
  "_headers",
  "_routes.json",
  "parkdex-artifact.json",
  ...parkRoutes.map(({ slug }) => `parks/${slug}.html`),
];

for (const relativePath of requiredFiles) {
  const path = resolve(outputRoot, relativePath);
  if (!statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`Static export is missing ${relativePath}`);
  }
}

const headers = readFileSync(resolve(outputRoot, "_headers"), "utf8");
for (const value of ["/auth/google/callback", "/migrate", "/migrate/", "Cache-Control: no-store", "Referrer-Policy: no-referrer", "X-Robots-Tag: noindex"]) {
  if (!headers.includes(value)) throw new Error(`Static export headers are missing ${value}`);
}

const manifest = JSON.parse(readFileSync(resolve(outputRoot, "parkdex-artifact.json"), "utf8"));
if (
  manifest.schema !== "parkdex.static-export/v1"
  || manifest.commitSha !== process.env.NEXT_PUBLIC_COMMIT_SHA
  || manifest.releaseVersion !== process.env.NEXT_PUBLIC_RELEASE_VERSION
  || manifest.commitDate !== process.env.NEXT_PUBLIC_COMMIT_DATE
  || manifest.apiBaseUrl !== process.env.NEXT_PUBLIC_API_BASE_URL
  || !/^[0-9a-f]{64}$/.test(manifest.artifactSha256)
) {
  throw new Error("Static export manifest does not match the requested release");
}

const indexHtml = readFileSync(resolve(outputRoot, "index.html"), "utf8");
for (const value of [`name="parkdex-commit" content="${manifest.commitSha}"`, `name="parkdex-release" content="${manifest.releaseVersion}"`, `\\"apiBaseUrl\\":\\"${manifest.apiBaseUrl}\\"`]) {
  if (!indexHtml.includes(value)) throw new Error(`Static export HTML is missing ${value}`);
}

const pagesFileLimit = 25 * 1024 * 1024;
function verifyFileSizes(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) verifyFileSizes(path);
    else if (statSync(path).size > pagesFileLimit) throw new Error(`${path} exceeds the Cloudflare Pages 25 MiB file limit`);
  }
}
verifyFileSizes(outputRoot);

const routes = JSON.parse(readFileSync(resolve(outputRoot, "_routes.json"), "utf8"));
for (const value of ["/api/*", "/mcp", "/mcp/*", "/authorize", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
  if (!routes.include?.includes(value)) throw new Error(`Static export routes are missing ${value}`);
}

console.log(`Verified ${requiredFiles.length} required Cloudflare Pages files`);
