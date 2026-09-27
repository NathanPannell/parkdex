import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };
import { execFileSync } from "node:child_process";

function sourceRevision() {
  if (process.env.RELEASE_SHA || process.env.VERCEL_GIT_COMMIT_SHA) return process.env.RELEASE_SHA || process.env.VERCEL_GIT_COMMIT_SHA;
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
