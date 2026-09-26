import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: true },
  // MapLibre loads ./maplibre-gl-worker.mjs next to itself; pre-bundling would move it away.
  optimizeDeps: { exclude: ["maplibre-gl"] },
});
