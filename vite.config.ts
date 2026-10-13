import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { assertUserDataApiBuildConfiguration } from "./src/lib/userDataDestination";
import { assertDemoToolsBuild } from "./src/lib/demo";
import pkg from "./package.json" with { type: "json" };
import { readdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PUBLIC_ROOT = resolve("public");
const PUBLIC_DIRS = ["art/kip", "art/products", "icons"];
const PUBLIC_FILES = new Set(["manifest.webmanifest", "sw.js", "maplibre/maplibre-gl-worker.mjs", "maplibre/maplibre-gl-shared.mjs", "release.json", "email/kip-wave.png", ".well-known/assetlinks.json", "map/bootstrap/canada-overview.pmtiles", "map/cells.json"]);

function allowedPublicPath(path: string) {
  return PUBLIC_FILES.has(path) || PUBLIC_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

async function allowlistedFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (path === "art" || path === "maplibre" || path === "email" || path === ".well-known" || path === "map" || path === "map/bootstrap" || PUBLIC_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`))) {
        files.push(...(await allowlistedFiles(resolve(directory, entry.name), path)));
      }
    } else if (allowedPublicPath(path)) {
      files.push(path);
    }
  }
  return files;
}

function allowlistedPublicAssets(): Plugin {
  return {
    name: "parkdex-allowlisted-public-assets",
    async buildStart() {
      for (const path of await allowlistedFiles(PUBLIC_ROOT)) {
        this.emitFile({ type: "asset", fileName: path, source: await readFile(resolve(PUBLIC_ROOT, path)) });
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let path: string;
        try {
          path = decodeURIComponent((req.url ?? "").split("?", 1)[0]).replace(/^\/+/, "");
        } catch {
          next();
          return;
        }
        if (path.split("/").some((part) => part === "..") || !allowedPublicPath(path) || (req.method !== "GET" && req.method !== "HEAD")) {
          next();
          return;
        }
        const file = resolve(PUBLIC_ROOT, path);
        if (!file.startsWith(`${PUBLIC_ROOT}${sep}`) && file !== PUBLIC_ROOT) {
          next();
          return;
        }
        void readFile(file).then((data) => {
          const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
          const mime = extension === "webp" ? "image/webp"
            : extension === "png" ? "image/png"
              : extension === "mjs" || extension === "js" ? "text/javascript; charset=utf-8"
                : extension === "webmanifest" ? "application/manifest+json"
                  : extension === "json" ? "application/json; charset=utf-8"
                    : "application/octet-stream";
          res.statusCode = 200;
          res.setHeader("Content-Type", mime);
          res.setHeader("Content-Length", data.byteLength);
          res.end(req.method === "HEAD" ? undefined : data);
        }).catch(next);
      });
    },
  };
}

function sourceRevision() {
  const environmentRevision = process.env.RELEASE_SHA || process.env.VERCEL_GIT_COMMIT_SHA;
  if (environmentRevision) return environmentRevision;
  try {
    const release = JSON.parse(readFileSync(new URL("./public/release.json", import.meta.url), "utf8")) as { sha?: unknown };
    if (typeof release.sha === "string" && /^[a-f0-9]{40}$/i.test(release.sha)) return release.sha;
  } catch {
    // The release manifest is only present in delivery builds.
  }
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'local'; }
}

// Only a loopback HTTP API may be proxied, so a stray variable cannot route dev traffic elsewhere.
function localApiTarget(value: string | undefined) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("KIP_LOCAL_API must be a loopback http URL such as http://127.0.0.1:8787.");
  }
  return url.origin;
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");
  assertUserDataApiBuildConfiguration(environment, { mode, vercelUrl: process.env.VERCEL_URL });
  assertDemoToolsBuild(environment, !!process.env.VERCEL);
  const localApi = mode === "development" ? localApiTarget(process.env.KIP_LOCAL_API) : undefined;

  return {
    // Source artwork, catalogs, scenes, glyphs, boundaries, and map chunks stay in
    // public/ for the content publisher, but are never copied into app builds.
    publicDir: false,
    plugins: [react(), allowlistedPublicAssets()],
    // Feedback reports carry the app version so testers never have to look it up.
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_BUILD__: JSON.stringify(sourceRevision()),
    },
    // 59k offline tile files: watching them makes dev startup crawl.
    server: {
      host: true,
      watch: { ignored: ["**/public/map/**"] },
      // `npm run local:api` serves the real API locally; proxying keeps account cookies same-origin.
      proxy: localApi ? { "/api": { target: localApi, changeOrigin: false } } : undefined,
    },
    // MapLibre loads ./maplibre-gl-worker.mjs next to itself; pre-bundling would move it away.
    optimizeDeps: { exclude: ["maplibre-gl"] },
  };
});
