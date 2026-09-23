import { runNextBuild } from "./run-next-build.mjs";

const stagingApiUrl = "https://api-staging-882c.up.railway.app";
const productionApiUrl = "https://api-production-e72df.up.railway.app";
const releaseBuild = process.env.PARKDEX_ANDROID_RELEASE === "1";
const requestedReleaseTarget = process.env.PARKDEX_ANDROID_RELEASE_TARGET?.trim();
const releaseTarget = requestedReleaseTarget || "production";
const requestedApiUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
const requestedScope = process.env.PARKDEX_CATALOGUE_SCOPE?.trim();
const requestedDiagnostics = process.env.NEXT_PUBLIC_FIELD_DIAGNOSTICS?.trim();
const requestedVersionName = process.env.PARKDEX_ANDROID_VERSION_NAME?.trim();
let requestedApiOrigin;
if (requestedApiUrl) {
  try {
    requestedApiOrigin = new URL(requestedApiUrl);
  } catch {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must be a valid HTTP(S) origin.");
  }
}

if (releaseBuild) {
  if (!["production", "internal-staging"].includes(releaseTarget)) {
    throw new Error("Release Android builds require PARKDEX_ANDROID_RELEASE_TARGET=production or internal-staging.");
  }
  if (!requestedApiUrl) {
    throw new Error("Release Android builds require an explicit NEXT_PUBLIC_API_BASE_URL.");
  }
  const expectedApiUrl = releaseTarget === "internal-staging" ? stagingApiUrl : productionApiUrl;
  if (requestedApiOrigin.origin !== expectedApiUrl) {
    throw new Error(`Release Android builds require the exact ${releaseTarget} API origin ${expectedApiUrl}.`);
  }
  if (requestedScope && requestedScope !== "canonical") {
    throw new Error("Release Android builds require PARKDEX_CATALOGUE_SCOPE=canonical.");
  }
  if (requestedDiagnostics && requestedDiagnostics !== "0") {
    throw new Error("Release Android builds require NEXT_PUBLIC_FIELD_DIAGNOSTICS=0.");
  }
  if (releaseTarget === "internal-staging" && !requestedVersionName?.toLowerCase().includes("internal-staging")) {
    throw new Error("Internal-staging Android builds require the literal internal-staging label in PARKDEX_ANDROID_VERSION_NAME.");
  }
  if (!/^\d+$/.test(process.env.PARKDEX_ANDROID_VERSION_CODE?.trim() || "")) {
    throw new Error("Release Android builds require PARKDEX_ANDROID_VERSION_CODE.");
  }
  if (!requestedVersionName) {
    throw new Error("Release Android builds require PARKDEX_ANDROID_VERSION_NAME.");
  }
}

const apiBaseUrl = requestedApiOrigin || new URL(stagingApiUrl);

if (apiBaseUrl.protocol !== "https:") {
  throw new Error("The Android build requires an HTTPS NEXT_PUBLIC_API_BASE_URL.");
}
if (apiBaseUrl.username || apiBaseUrl.password || apiBaseUrl.pathname !== "/" || apiBaseUrl.search || apiBaseUrl.hash) {
  throw new Error("NEXT_PUBLIC_API_BASE_URL must be an HTTPS origin without credentials, a path, query, or fragment.");
}

const result = await runNextBuild({
  ...process.env,
  NEXT_PUBLIC_API_BASE_URL: apiBaseUrl.origin,
  NEXT_PUBLIC_FIELD_DIAGNOSTICS: releaseBuild
    ? "0"
    : requestedDiagnostics || (requestedScope === "canonical" ? "0" : "1"),
  PARKDEX_ANDROID_BUILD: "1",
  ...(releaseBuild || requestedReleaseTarget ? { PARKDEX_ANDROID_RELEASE_TARGET: releaseTarget } : {}),
  PARKDEX_CATALOGUE_SCOPE: releaseBuild ? "canonical" : requestedScope || "staging",
});
process.exit(result);
