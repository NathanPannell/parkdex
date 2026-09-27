import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repositoryRoot, "cloudflare", "content-worker.mjs");
const outputDirectory = path.join(repositoryRoot, ".codex", "cdn-dist");

await mkdir(outputDirectory, { recursive: true });
await copyFile(source, path.join(outputDirectory, "_worker.js"));

console.log(`Built Pages Worker entrypoint at ${path.join(outputDirectory, "_worker.js")}`);
