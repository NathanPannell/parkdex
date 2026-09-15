import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(frontendRoot, "public", "_headers");
const destination = resolve(frontendRoot, "out", "_headers");

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log("Copied Cloudflare Pages headers");
