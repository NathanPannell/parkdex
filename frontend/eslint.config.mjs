import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    "android/app/src/main/assets/**",
    "node_modules/**",
    "public/maplibre/**",
    "next-env.d.ts",
  ]),
]);
