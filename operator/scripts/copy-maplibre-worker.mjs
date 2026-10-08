// MapLibre v6 loads its worker as a separate ES module that bundlers don't emit, so copy the
// worker and its shared chunk into public/ before dev and build. Same approach as the app.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = dirname(createRequire(import.meta.url).resolve("maplibre-gl/dist/maplibre-gl-worker.mjs"));
const out = join(root, "public", "maplibre");
mkdirSync(out, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(src, file), join(out, file));
