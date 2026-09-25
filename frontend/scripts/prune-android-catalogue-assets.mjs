import { readdir, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";

/** Keep the app shell and tiny map index; viewed place bundles are downloaded on demand. */
export async function pruneAndroidCatalogueAssets(outputDirectory) {
  const root = resolve(outputDirectory instanceof URL ? fileURLToPath(outputDirectory) : outputDirectory);
  for (const directory of ["places", "data"]) {
    const folder = resolve(root, directory);
    if (!folder.startsWith(`${root}${sep}`)) throw new Error("Invalid Android asset directory");
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      const keep = directory === "places" ? item.name === "place-placeholder.png" : item.name === "boundaries-index.v1.json";
      if (!keep) await unlink(resolve(folder, item.name));
    }
  }
}
