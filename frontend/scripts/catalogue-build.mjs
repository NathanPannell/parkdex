import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CATALOGUE_SOURCE_ENV,
  normalizeBoundaryText,
  readScopedBoundaryCollection,
  resolveCatalogueScope,
} from "./catalogue-scope.mjs";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));
const publicDataRoot = fileURLToPath(new URL("../public/data/", import.meta.url));
const generatedAssetNames = [
  "boundaries.v1.geojson",
  "boundaries-index.v1.json",
  "boundaries-display.v1.geojson",
  "boundaries-display.v1.manifest.json",
  "vancouver-island-focus-mask.v1.geojson",
  "exploration-territories.v1.geojson",
];
const generationScripts = [
  "sync-boundary-assets.mjs",
  "generate-display-boundaries.mjs",
  "generate-map-focus-mask.mjs",
  "generate-exploration-territories.mjs",
];

async function snapshotAssets() {
  const snapshotDirectory = await mkdtemp(join(tmpdir(), "parkdex-catalogue-assets-"));
  const snapshot = new Map();
  try {
    for (const name of generatedAssetNames) {
      const path = join(publicDataRoot, name);
      try {
        snapshot.set(name, await readFile(path));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        snapshot.set(name, null);
      }
    }
  } catch (error) {
    await rm(snapshotDirectory, { recursive: true, force: true });
    throw error;
  }
  return { snapshot, snapshotDirectory };
}

async function restoreAssets({ snapshot, snapshotDirectory }) {
  try {
    for (const name of generatedAssetNames) {
      const path = join(publicDataRoot, name);
      const original = snapshot.get(name);
      if (original == null) {
        await unlink(path).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      } else {
        await writeFile(path, original);
      }
    }
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
}

function runGenerator(script, env) {
  const result = spawnSync(process.execPath, [join(frontendRoot, "scripts", script)], {
    cwd: frontendRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed with status ${result.status ?? "unknown"}`);
}

/**
 * Stage scoped generated assets for one build and return an idempotent
 * cleanup function. Canonical builds do no filesystem work. Staging is
 * intentionally a temporary overlay so successful local/preview builds do
 * not leave the tracked canonical assets dirty.
 */
export async function stageCatalogueAssets(env = process.env) {
  const scope = resolveCatalogueScope(env.PARKDEX_CATALOGUE_SCOPE);
  if (scope !== "staging") return { scope, restore: async () => undefined };

  // Validate the required input before touching any tracked public asset.
  const scopedInput = await readScopedBoundaryCollection(scope, env);
  const state = await snapshotAssets();
  const canonicalAsset = state.snapshot.get("boundaries.v1.geojson");
  if (canonicalAsset == null) {
    await restoreAssets(state);
    throw new Error("Staging catalogue builds require the committed canonical public boundary asset");
  }
  const canonicalAssetText = canonicalAsset.toString("utf8");
  if (normalizeBoundaryText(canonicalAssetText) !== normalizeBoundaryText(scopedInput.canonicalText)) {
    await restoreAssets(state);
    throw new Error("Committed canonical public boundary asset is stale; run npm run sync:boundaries before staging");
  }
  // sync-boundary-assets must read canonical geometry from this disposable
  // copy. Otherwise it would read the public file after that script has
  // already merged staging geometry into it.
  const canonicalSourcePath = join(state.snapshotDirectory, "boundaries.geojson");
  await writeFile(canonicalSourcePath, canonicalAsset);
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await restoreAssets(state);
  };
  try {
    const scopedEnv = {
      ...env,
      PARKDEX_CATALOGUE_SCOPE: scope,
      [CATALOGUE_SOURCE_ENV.canonicalBoundary]: canonicalSourcePath,
    };
    for (const script of generationScripts) runGenerator(script, scopedEnv);
  } catch (error) {
    await restore();
    throw error;
  }
  return { scope, restore };
}
