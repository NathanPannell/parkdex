import { readdir, readFile, stat } from "node:fs/promises";
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

try {
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
  if (/(^|\/)map\/island\/\d+\.bin$/.test(normalized)) return "PMTiles map chunk is packaged";
  if (/(^|\/)map\/fonts\/.*\.(?:pbf|bin)$/.test(normalized)) return "map glyph binary is packaged";
  if (/\.pmtiles$/.test(normalized)) return "PMTiles archive is packaged";
  return null;
}

function displayPath(path) {
  return toPosix(relative(projectRoot, path)) || ".";
}

function toPosix(path) {
  return path.split(sep).join("/");
}
