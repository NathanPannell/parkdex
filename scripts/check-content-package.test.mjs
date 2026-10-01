import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { test } from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const checkerPath = join(projectRoot, "scripts", "check-content-package.mjs");
const overviewPath = join(projectRoot, "public", "map", "bootstrap", "island-overview.pmtiles");
const MAX_OVERVIEW_BYTES = 2_000_000;

test("allows only the pinned whole-island overview within the byte budget", async (t) => {
  const outputDirectory = await packageFixture(t);
  const bootstrapDirectory = join(outputDirectory, "map", "bootstrap");
  await mkdir(bootstrapDirectory, { recursive: true });
  await copyFile(overviewPath, join(bootstrapDirectory, "island-overview.pmtiles"));

  const result = checkPackage(outputDirectory);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Content package check passed/);
});

test("requires the bundled overview in every app package", async (t) => {
  const outputDirectory = await packageFixture(t);

  const result = checkPackage(outputDirectory);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /required bundled island overview is missing/);
});

test("requires every onboarding illustration and Kip pose in the app package", async (t) => {
  const outputDirectory = await packageFixture(t);
  const scenePath = join(outputDirectory, "assets", "onboarding-scene-goldstream-testhash.webp");
  await rm(scenePath);

  const result = checkPackage(outputDirectory);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /assets\/onboarding-scene-goldstream-: required bundled onboarding artwork is missing/);
});

test("requires the onboarding map illustration in the app package", async (t) => {
  const outputDirectory = await packageFixture(t);
  await rm(join(outputDirectory, "assets", "onboarding-go-map-testhash.webp"));

  const result = checkPackage(outputDirectory);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /assets\/onboarding-go-map-: required bundled onboarding artwork is missing/);
});

test("requires Kip's bundled rig parts in the app package", async (t) => {
  const outputDirectory = await packageFixture(t);
  await rm(join(outputDirectory, "art", "kip", "parts", "body.webp"));

  const result = checkPackage(outputDirectory);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /art\/kip\/parts\/body\.webp: required bundled onboarding artwork is missing/);
});

test("rejects an overview above the explicit package byte budget", async (t) => {
  const outputDirectory = await packageFixture(t);
  const archivePath = join(outputDirectory, "map", "bootstrap", "island-overview.pmtiles");
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, Buffer.alloc(MAX_OVERVIEW_BYTES + 1));

  const result = checkPackage(outputDirectory);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, new RegExp(`exceeds ${MAX_OVERVIEW_BYTES} bytes`));
});

test("rejects changed overview bytes and any additional map archive, chunk, or glyph", async (t) => {
  const outputDirectory = await packageFixture(t);
  const archivePath = join(outputDirectory, "map", "bootstrap", "island-overview.pmtiles");
  const archive = await readFile(overviewPath);
  archive[0] ^= 1;
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);
  await writeFile(join(outputDirectory, "extra.pmtiles"), "unexpected archive");
  await mkdir(join(outputDirectory, "map", "island"), { recursive: true });
  await writeFile(join(outputDirectory, "map", "island", "000.bin"), "unexpected detail chunk");
  await mkdir(join(outputDirectory, "map", "fonts", "Noto Sans Regular"), { recursive: true });
  await writeFile(join(outputDirectory, "map", "fonts", "Noto Sans Regular", "0-255.pbf"), "unexpected glyphs");

  const result = checkPackage(outputDirectory);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /does not match its pinned SHA-256/);
  assert.match(result.output, /PMTiles archive is packaged/);
  assert.match(result.output, /detailed PMTiles map content is packaged/);
  assert.match(result.output, /map glyph binary is packaged/);
});

async function packageFixture(t) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "parkdex-content-package-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const mapLibre = join(outputDirectory, "maplibre");
  await mkdir(mapLibre, { recursive: true });
  await writeFile(join(mapLibre, "maplibre-gl-worker.mjs"), "export {};\n");
  await writeFile(join(mapLibre, "maplibre-gl-shared.mjs"), "export {};\n");
  const bundledAssets = join(outputDirectory, "assets");
  await mkdir(bundledAssets, { recursive: true });
  for (const name of ["onboarding-go-map", "onboarding-scene-beacon-hill", "onboarding-scene-goldstream", "onboarding-scene-wittys-lagoon"]) {
    await writeFile(join(bundledAssets, `${name}-testhash.webp`), "bundled onboarding art");
  }
  const kipArt = join(outputDirectory, "art", "kip");
  await mkdir(kipArt, { recursive: true });
  for (const pose of ["wave", "point", "think"]) {
    await writeFile(join(kipArt, `kip-${pose}.webp`), "bundled Kip art");
  }
  const kipParts = join(kipArt, "parts");
  await mkdir(kipParts, { recursive: true });
  for (const part of ["tail", "legs", "wing-back", "body", "head", "eye-open", "eye-closed", "bill-lower", "bill-upper", "wing-front"]) {
    await writeFile(join(kipParts, `${part}.webp`), "bundled Kip rig art");
  }
  return outputDirectory;
}

function checkPackage(outputDirectory) {
  const result = spawnSync(process.execPath, [checkerPath, outputDirectory], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
