import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["_headers", "_routes.json"]) {
  const source = resolve(frontendRoot, "public", name);
  const destination = resolve(frontendRoot, "out", name);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}
console.log("Copied Cloudflare Pages configuration");
