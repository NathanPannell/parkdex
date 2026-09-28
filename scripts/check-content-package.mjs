import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputArg = process.argv[2];
if (process.argv.length > 3 || outputArg === "--help" || outputArg === "-h") {
  console.log("Usage: node scripts/check-content-package.mjs [output-directory]");
  process.exit(process.argv.length > 3 ? 2 : 0);
}

const outputDirectory = resolve(outputArg ?? resolve(projectRoot, "dist"));
const parkCatalogPath = resolve(projectRoot, "src/data/parks.json");
const OVERVIEW_PATH = "map/bootstrap/island-overview.pmtiles";
const OVERVIEW_PROVENANCE_PATH = resolve(projectRoot, "public/map/bootstrap/island-overview.provenance.json");
const MAX_BUNDLED_OVERVIEW_BYTES = 2_000_000;

try {
  const overviewProvenance = JSON.parse(await readFile(OVERVIEW_PROVENANCE_PATH, "utf8"));
  const pinnedOverview = overviewProvenance?.artifact;
  if (overviewProvenance?.schema !== "parkdex.bundled-map-overview/v1"
    || pinnedOverview?.path !== `public/${OVERVIEW_PATH}`
    || !/^[a-f0-9]{64}$/.test(pinnedOverview?.sha256 ?? "")
    || !Number.isSafeInteger(pinnedOverview?.bytes)
    || pinnedOverview.bytes <= 0
    || pinnedOverview.bytes > MAX_BUNDLED_OVERVIEW_BYTES) {
    throw new Error("Pinned bundled island overview provenance is invalid or exceeds its size budget");
  }

  const outputStat = await stat(outputDirectory).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`Package output directory does not exist: ${displayPath(outputDirectory)}. Build the package first.`);
    throw error;
  });
  if (!outputStat.isDirectory()) throw new Error(`Package output is not a directory: ${displayPath(outputDirectory)}`);

  const catalog = JSON.parse(await readFile(parkCatalogPath, "utf8"));
  if (!Array.isArray(catalog)) throw new Error(`Expected a park array in ${displayPath(parkCatalogPath)}`);
  const parkIds = [...new Set(catalog.map((park) => park?.id).filter((id) => typeof id === "string" && id.length > 0))];
  if (parkIds.length === 0) throw new Error(`No park IDs found in ${displayPath(parkCatalogPath)}`);

  const files = await collectFiles(outputDirectory);
  const failures = [];
  const packagedPaths = new Set(files.map((file) => toPosix(relative(outputDirectory, file))));
  for (const required of ["maplibre/maplibre-gl-worker.mjs", "maplibre/maplibre-gl-shared.mjs"]) {
    if (!packagedPaths.has(required)) failures.push({ path: required, reason: "required MapLibre runtime module is missing" });
  }
  if (!packagedPaths.has(OVERVIEW_PATH)) failures.push({ path: OVERVIEW_PATH, reason: "required bundled island overview is missing" });
  const overviewFile = files.find((file) => toPosix(relative(outputDirectory, file)) === OVERVIEW_PATH);
  if (overviewFile) {
    const overviewStat = await stat(overviewFile);
    if (overviewStat.size > MAX_BUNDLED_OVERVIEW_BYTES) {
      failures.push({ path: OVERVIEW_PATH, reason: `bundled island overview exceeds ${MAX_BUNDLED_OVERVIEW_BYTES} bytes` });
    } else if (overviewStat.size !== pinnedOverview.bytes) {
      failures.push({ path: OVERVIEW_PATH, reason: `bundled island overview has ${overviewStat.size} bytes; expected pinned size ${pinnedOverview.bytes}` });
    } else {
      const digest = createHash("sha256").update(await readFile(overviewFile)).digest("hex");
      if (digest !== pinnedOverview.sha256) failures.push({ path: OVERVIEW_PATH, reason: "bundled island overview does not match its pinned SHA-256" });
    }
  }
  for (const file of files) {
    const relativePath = toPosix(relative(outputDirectory, file));
    const reason = forbiddenAssetReason(relativePath);
    if (reason) failures.push({ path: relativePath, reason });

    if ([".js", ".mjs", ".cjs"].includes(extname(file).toLowerCase())) {
      const source = await readFile(file, "utf8");
      let matchingIds = 0;
      for (const id of parkIds) if (source.includes(id)) matchingIds += 1;
      if (matchingIds > 0) failures.push({ path: relativePath, reason: `compiled JavaScript contains ${matchingIds} catalog park ID${matchingIds === 1 ? "" : "s"}` });
    }
  }

  if (failures.length > 0) {
    console.error(`Content package check failed for ${displayPath(outputDirectory)}:`);
    for (const failure of failures) console.error(`- ${failure.path}: ${failure.reason}`);
    process.exitCode = 1;
  } else {
    console.log(`Content package check passed: ${displayPath(outputDirectory)} (${files.length} files, ${parkIds.length} park IDs checked)`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function collectFiles(directory, parent = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = parent ? `${parent}${sep}${entry.name}` : entry.name;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(absolutePath, relativePath)));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

function forbiddenAssetReason(path) {
  const normalized = `/${path.toLowerCase()}`;
  if (/(^|\/)(parks|drive)(?:[-.][^/]*)?\.json$/.test(normalized)) return "park or drive catalog file is packaged";
  if (/(^|\/)[^/]*boundar(?:y|ies)[^/]*\.(?:geojson|json|pbf)$/.test(normalized)) return "park boundaries are packaged";
  if (/(^|\/)art\/badges\/scenes(?:\/|$)/.test(normalized)) return "badge scene asset is packaged";
  if (normalized.startsWith("/map/island/")) return "detailed PMTiles map content is packaged";
  if (normalized.startsWith("/map/fonts/")) return "map glyph binary is packaged";
  if (normalized.startsWith("/map/bootstrap/") && path !== OVERVIEW_PATH) return "unexpected bootstrap map asset is packaged";
  if (/\.pmtiles$/.test(normalized) && path !== OVERVIEW_PATH) return "PMTiles archive is packaged";
  return null;
}

function displayPath(path) {
  return toPosix(relative(projectRoot, path)) || ".";
}

function toPosix(path) {
  return path.split(sep).join("/");
}
