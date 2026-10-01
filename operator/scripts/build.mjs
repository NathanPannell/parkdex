// Builds a Vercel Build Output API v3 bundle in .vercel/output, deployed with `vercel deploy --prebuilt`.
// The API is bundled into one Edge Function so it can share the app's worker modules
// without the Vercel project needing access to the rest of the repository.
import { build as viteBuild } from "vite";
import { build as esbuild } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, ".vercel", "output");
const functionDir = path.join(output, "functions", "api.func");

await viteBuild({ root, logLevel: "warn" });

await mkdir(functionDir, { recursive: true });
await esbuild({
  entryPoints: [path.join(root, "server", "edge.ts")],
  outfile: path.join(functionDir, "index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["worker", "browser"],
  // Worker modules import the database driver from outside this folder.
  nodePaths: [path.join(root, "node_modules")],
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
});
await writeFile(path.join(functionDir, ".vc-config.json"), JSON.stringify({ runtime: "edge", entrypoint: "index.js" }, null, 2));

const privateHeaders = [
  { key: "Cache-Control", value: "no-store" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
];
await writeFile(path.join(output, "config.json"), JSON.stringify({
  version: 3,
  routes: [
    { src: "/(.*)", headers: Object.fromEntries(privateHeaders.map(({ key, value }) => [key, value])), continue: true },
    { src: "/api/(.*)", dest: "/api?__path=$1" },
    { handle: "filesystem" },
    { src: "/(.*)", dest: "/index.html" },
  ],
}, null, 2));
// `vercel deploy --prebuilt` takes its target from this file and defaults to production
// without it. This app must only ever be a preview deployment (see README).
await writeFile(path.join(output, "builds.json"), JSON.stringify({ "//": "Written by scripts/build.mjs", target: "preview", argv: [], builds: [] }, null, 2));
console.log(`Built ${path.relative(process.cwd(), output)}`);
