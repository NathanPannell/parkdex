import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

export default defineConfig({
  plugins: [react()],
  // Feedback reports carry the app version so testers never have to look it up.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(sourceRevision()),
  },
  // 59k offline tile files: watching them makes dev startup crawl.
  server: { host: true, watch: { ignored: ["**/public/map/**"] } },
  // MapLibre loads ./maplibre-gl-worker.mjs next to itself; pre-bundling would move it away.
  optimizeDeps: { exclude: ["maplibre-gl"] },
});
