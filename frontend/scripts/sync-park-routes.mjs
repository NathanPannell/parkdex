import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(frontendRoot, "../data/places.json");
const output = resolve(frontendRoot, "lib/park-routes.json");
const places = JSON.parse(readFileSync(source, "utf8"));
const seen = new Set();
const routes = places.map(({ id, name, description }) => {
  const slug = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug || seen.has(slug)) throw new Error(`Duplicate or empty park slug: ${slug}`);
  seen.add(slug);
  return { id, slug, name, description };
});
const content = `${JSON.stringify(routes, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8").replace(/\r\n/g, "\n") !== content) {
    throw new Error("Park routes are out of sync with data/places.json");
  }
} else {
  writeFileSync(output, content);
}
console.log(`Verified ${routes.length} unique park routes`);
