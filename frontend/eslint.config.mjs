import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    ".wrangler/**",
    "out/**",
    "node_modules/**",
    "public/maplibre/**",
    "android/.gradle/**",
    "android/**/build/**",
    "android/app/src/main/assets/**",
    "next-env.d.ts",
  ]),
]);
