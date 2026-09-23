import { execFileSync, spawnSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const headSha = git("rev-parse", "HEAD");
const commitSha = process.env.CF_PAGES_COMMIT_SHA?.trim() || headSha;
if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Cloudflare build requires a full lowercase Git SHA");
if (commitSha !== headSha) throw new Error(`Cloudflare commit ${commitSha} does not match checked-out HEAD ${headSha}`);
const appOrigin = process.env.CF_PAGES_BRANCH?.trim() === "staging"
  ? "https://staging.web.parkdex.app"
  : "https://web.parkdex.app";

const env = {
  ...process.env,
  PARKDEX_CLOUDFLARE_BUILD: "1",
  PARKDEX_CATALOGUE_SCOPE: process.env.CF_PAGES_BRANCH?.trim() === "staging" ? "staging" : "canonical",
  NEXT_PUBLIC_API_BASE_URL: ".",
  NEXT_PUBLIC_APP_URL: appOrigin,
  NEXT_PUBLIC_COMMIT_SHA: commitSha,
  NEXT_PUBLIC_COMMIT_DATE: git("show", "-s", "--format=%cI", commitSha),
  NEXT_PUBLIC_RELEASE_VERSION: process.env.NEXT_PUBLIC_RELEASE_VERSION?.trim() || `cf-${commitSha.slice(0, 7)}`,
};
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Cloudflare build must run through npm");
for (const script of ["build", "process:cloudflare"]) {
  const result = spawnSync(process.execPath, [npmCli, "run", script], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
