#!/usr/bin/env node

function readArg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const repository = readArg("--repository", process.env.GITHUB_REPOSITORY);
const sha = readArg("--sha");
const state = readArg("--state");
const context = readArg("--context", "local-ci");
const description = (readArg("--description", "Local exact-SHA validation") || "").slice(0, 140);
const targetUrl = readArg("--target-url", repository && sha ? `https://github.com/${repository}/commit/${sha}` : undefined);

if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error("--repository or GITHUB_REPOSITORY is required");
if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("--sha must be a full 40-character commit SHA");
if (!["error", "failure", "pending", "success"].includes(state)) throw new Error("--state must be error, failure, pending, or success");
if (!targetUrl || !/^https:\/\//.test(targetUrl)) throw new Error("--target-url must be an HTTPS URL");

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({ repository, sha, state, context, description, targetUrl }));
  process.exit(0);
}

const token = process.env.PARKDEX_STATUS_TOKEN;
if (!token) throw new Error("PARKDEX_STATUS_TOKEN is required for separately credentialed status publication");

const response = await fetch(`https://api.github.com/repos/${repository}/statuses/${sha}`, {
  method: "POST",
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
    "user-agent": "parkdex-local-ci",
  },
  body: JSON.stringify({ state, target_url: targetUrl, description, context }),
});
if (!response.ok) throw new Error(`GitHub status publication failed with HTTP ${response.status}`);
console.log(`github-status state=${state} context=${context} sha=${sha}`);
