import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const stagingApiUrl = "https://api-staging-882c.up.railway.app";
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || stagingApiUrl;
const parsedApiUrl = new URL(apiBaseUrl);

if (parsedApiUrl.protocol !== "https:") {
  throw new Error("The Android build requires an HTTPS NEXT_PUBLIC_API_BASE_URL.");
}

const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const result = spawnSync(process.execPath, [nextBin, "build"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NEXT_PUBLIC_API_BASE_URL: parsedApiUrl.origin,
    PARKDEX_ANDROID_BUILD: "1",
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
