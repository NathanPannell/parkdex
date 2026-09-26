// MapLibre v6 loads its worker as a separate ES module next to the main bundle.
// Bundlers don't emit it, so copy the worker and its shared chunk into public/.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules", "maplibre-gl", "dist");
const out = join(root, "public", "maplibre");
mkdirSync(out, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(src, file), join(out, file));
