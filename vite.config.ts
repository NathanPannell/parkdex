import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 59k offline tile files: watching them makes dev startup crawl.
  server: { host: true, watch: { ignored: ["**/public/map/**"] } },
  // MapLibre loads ./maplibre-gl-worker.mjs next to itself; pre-bundling would move it away.
  optimizeDeps: { exclude: ["maplibre-gl"] },
});
