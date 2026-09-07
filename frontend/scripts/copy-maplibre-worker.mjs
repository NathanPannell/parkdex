import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "node_modules", "maplibre-gl", "dist");
const target = join(root, "public", "maplibre");

await mkdir(target, { recursive: true });
await Promise.all([
  copyFile(join(source, "maplibre-gl-worker.mjs"), join(target, "maplibre-gl-worker.mjs")),
  copyFile(join(source, "maplibre-gl-shared.mjs"), join(target, "maplibre-gl-shared.mjs")),
]);
console.log("Copied MapLibre ESM worker runtime");
