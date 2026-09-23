import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stageCatalogueAssets } from "./catalogue-build.mjs";

const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

export function shouldRestoreScopedAssets(env, scope) {
  return !(scope === "staging" && env.PARKDEX_KEEP_SCOPED_ASSETS?.trim() === "1");
}

export async function runNextBuild(env = process.env) {
  const staged = await stageCatalogueAssets(env);
  try {
    const result = spawnSync(process.execPath, [nextBin, "build"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    if (shouldRestoreScopedAssets(env, staged.scope)) await staged.restore();
  }
}
