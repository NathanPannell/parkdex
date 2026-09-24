import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(frontendRoot, "../data/places.json");
const output = resolve(frontendRoot, "lib/park-routes.json");
// Vercel uploads frontend/ alone. Its build can still validate the committed manifest.
const hasCatalogueSource = existsSync(source);
if (!hasCatalogueSource && !process.argv.includes("--check")) {
  throw new Error("data/places.json is required to regenerate park routes");
}
const places = JSON.parse(readFileSync(hasCatalogueSource ? source : output, "utf8"));
const previousRoutes = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : [];
const previousSlugs = new Map(previousRoutes.map(({ id, slug }) => [id, slug]));
const slugify = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const seen = new Set();
const assigned = new Map();

// Keep published routes stable as the catalogue grows. New places with the
// same name receive an ID-qualified route instead of displacing an old one.
for (const { id } of places) {
  const slug = previousSlugs.get(id);
  if (!slug) continue;
  if (seen.has(slug)) throw new Error(`Duplicate published park slug: ${slug}`);
  seen.add(slug);
  assigned.set(id, slug);
}
for (const { id, name } of [...places].sort((a, b) => a.id.localeCompare(b.id))) {
  if (assigned.has(id)) continue;
  const base = slugify(name);
  if (!base) throw new Error(`Empty park slug: ${id}`);
  const slug = seen.has(base) ? `${base}-${slugify(id)}` : base;
  if (seen.has(slug)) throw new Error(`Duplicate park slug: ${slug}`);
  seen.add(slug);
  assigned.set(id, slug);
}
const routes = places.map(({ id, name, description }) => ({ id, slug: assigned.get(id), name, description }));
const content = `${JSON.stringify(routes, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8").replace(/\r\n/g, "\n") !== content) {
    throw new Error("Park routes are out of sync with data/places.json");
  }
} else {
  writeFileSync(output, content);
}
console.log(`Verified ${routes.length} unique park routes`);
