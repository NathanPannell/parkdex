import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  // Feedback reports carry the app version so testers never have to look it up.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // 59k offline tile files: watching them makes dev startup crawl.
  server: { host: true, watch: { ignored: ["**/public/map/**"] } },
  // MapLibre loads ./maplibre-gl-worker.mjs next to itself; pre-bundling would move it away.
  optimizeDeps: { exclude: ["maplibre-gl"] },
});
