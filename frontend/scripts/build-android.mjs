import { runNextBuild } from "./run-next-build.mjs";

const stagingApiUrl = "https://api-staging-882c.up.railway.app";
const apiBaseUrl = new URL(process.env.NEXT_PUBLIC_API_BASE_URL || stagingApiUrl);

if (apiBaseUrl.protocol !== "https:") {
  throw new Error("The Android build requires an HTTPS NEXT_PUBLIC_API_BASE_URL.");
}
if (apiBaseUrl.username || apiBaseUrl.password || apiBaseUrl.pathname !== "/" || apiBaseUrl.search || apiBaseUrl.hash) {
  throw new Error("NEXT_PUBLIC_API_BASE_URL must be an HTTPS origin without credentials, a path, query, or fragment.");
}

const result = await runNextBuild({
  ...process.env,
  NEXT_PUBLIC_API_BASE_URL: apiBaseUrl.origin,
  PARKDEX_ANDROID_BUILD: "1",
  PARKDEX_CATALOGUE_SCOPE: process.env.PARKDEX_CATALOGUE_SCOPE?.trim() || "staging",
});
process.exit(result);
