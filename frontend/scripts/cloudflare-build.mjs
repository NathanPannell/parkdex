import { execFileSync, spawnSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const commitSha = process.env.CF_PAGES_COMMIT_SHA?.trim() || git("rev-parse", "HEAD");
if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Cloudflare build requires a full lowercase Git SHA");

const env = {
  ...process.env,
  PARKDEX_CLOUDFLARE_BUILD: "1",
  NEXT_PUBLIC_API_BASE_URL: ".",
  NEXT_PUBLIC_COMMIT_SHA: commitSha,
  NEXT_PUBLIC_COMMIT_DATE: git("show", "-s", "--format=%cI", commitSha),
  NEXT_PUBLIC_RELEASE_VERSION: process.env.NEXT_PUBLIC_RELEASE_VERSION?.trim() || `cf-${commitSha.slice(0, 7)}`,
};
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Cloudflare build must run through npm");
for (const script of ["build", "postbuild:cloudflare"]) {
  const result = spawnSync(process.execPath, [npmCli, "run", script], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
