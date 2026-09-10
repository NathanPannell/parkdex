#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const readArg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

function repositorySlug(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i) || normalized.match(/(?:^|\/)([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : normalized.replace(/\.git$/, "").toLowerCase();
}

function successfulResults(evidence, suite) {
  const backend = ["database isolation contracts", "create owned CI database", "backend seed contract", "backend migrations", "backend tests", "drop owned CI database"];
  const frontend = ["repository dependencies", "catalogue validation", "boundary source tests", "boundary geometry", "release metadata tests", "workflow contract tests", "local release contract tests", "CI evidence contract tests", "deployment helper tests", "frontend dependencies", "frontend boundary asset", "frontend territory contract", "frontend lint", "frontend typecheck", "frontend tests", "frontend build"];
  const required = suite === "backend" ? backend : suite === "frontend" ? frontend : [...backend, ...frontend];
  const labels = new Set((evidence.results || []).filter((item) => item?.status === 0).map((item) => item.label));
  return required.every((label) => labels.has(label));
}

const canonicalSource = (value) => `${String(value).replaceAll("\r\n", "\n").trimEnd()}\n`;

const repository = readArg("--repository", process.env.GITHUB_REPOSITORY);
const sha = readArg("--sha");
const state = readArg("--state");
const baseContext = readArg("--context", "local-ci");
const attestationPath = readArg("--attestation");
const headRef = readArg("--head-ref");
const targetUrl = readArg("--target-url", repository && sha ? `https://github.com/${repository}/commit/${sha}` : undefined);
if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error("--repository or GITHUB_REPOSITORY is required");
if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("--sha must be a full commit SHA");
if (!['error', 'failure', 'pending', 'success'].includes(state)) throw new Error("--state must be error, failure, pending, or success");
if (!targetUrl || !/^https:\/\//.test(targetUrl)) throw new Error("--target-url must be HTTPS");

let evidenceHash = "";
let evidence;
let context = baseContext;
if (state === "success") {
  if (!attestationPath) throw new Error("Successful status publication requires --attestation");
  if (!headRef || !/^[A-Za-z0-9._/-]+$/.test(headRef) || headRef.startsWith("/") || headRef.includes("..")) throw new Error("Successful status publication requires a safe --head-ref");
  const text = readFileSync(attestationPath, "utf8");
  evidence = JSON.parse(text);
  evidenceHash = createHash("sha256").update(text).digest("hex");
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (repositorySlug(git(root, ["remote", "get-url", "origin"])) !== repository.toLowerCase()) throw new Error("Origin does not match the target repository");
  if (git(root, ["status", "--porcelain"])) throw new Error("Trusted staging checkout must be clean");
  git(root, ["fetch", "--no-tags", "origin", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`, "+refs/heads/staging:refs/remotes/origin/staging"]);
  const remoteHead = git(root, ["rev-parse", `refs/remotes/origin/${headRef}`]);
  if (remoteHead !== sha) throw new Error("Remote head changed after validation");

  if (evidence.schema === "parkdex.merge-candidate/v1") {
    if (evidence.status !== "success" || evidence.headSha !== sha || evidence.baseRef !== "refs/heads/staging" || evidence.baseSha !== evidence.remoteBaseSha || evidence.suite !== "all" || evidence.validatorRef !== evidence.baseSha || repositorySlug(evidence.repository) !== repository.toLowerCase()) {
      throw new Error("Merge attestation identity is incomplete");
    }
    git(root, ["fetch", "--no-tags", "origin", "+refs/heads/staging:refs/remotes/origin/staging"]);
    const remoteBase = git(root, ["rev-parse", "refs/remotes/origin/staging"]);
    if (remoteBase !== evidence.baseSha) throw new Error("Remote staging changed after validation");
    if (git(root, ["rev-parse", "HEAD"]) !== evidence.baseSha) throw new Error("Status publication must run from the attested staging checkout");
    const publisherSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const trustedPublisherSource = git(root, ["show", `${evidence.baseSha}:scripts/github-status.mjs`]);
    if (canonicalSource(publisherSource) !== canonicalSource(trustedPublisherSource)) throw new Error("Status publisher is not the attested staging version");
    const treeOutput = git(root, ["merge-tree", "--write-tree", evidence.baseSha, sha]);
    const treeSha = treeOutput.split(/\s+/).find((item) => /^[0-9a-f]{40}$/.test(item));
    if (!treeSha || treeSha !== evidence.treeSha) throw new Error("Merge tree no longer matches the attestation");
    const trustedSource = `${git(root, ["show", `${evidence.baseSha}:scripts/local-ci.mjs`])}\n`;
    if (createHash("sha256").update(trustedSource).digest("hex") !== evidence.trustedValidatorSha256) throw new Error("Trusted validator identity does not match staging");
    const localText = readFileSync(evidence.localEvidencePath, "utf8");
    if (createHash("sha256").update(localText).digest("hex") !== evidence.localEvidenceSha256) throw new Error("Nested local evidence hash does not match");
    const localEvidence = JSON.parse(localText);
    if (localEvidence.schema !== "parkdex.local-ci/v1" || localEvidence.status !== "success" || localEvidence.commitSha !== evidence.candidateSha || localEvidence.suite !== "all" || !successfulResults(localEvidence, "all")) {
      throw new Error("Nested local evidence does not prove the complete candidate suite");
    }
    context = `${baseContext}/staging-${evidence.baseSha.slice(0, 12)}`;
  } else {
    throw new Error("Successful status publication requires merge-candidate evidence from trusted staging");
  }
}

const description = (readArg("--description", evidenceHash ? `Local evidence ${evidenceHash.slice(0, 16)}` : "Local exact-SHA validation") || "").slice(0, 140);
const requestBody = { state, target_url: targetUrl, description, context };
if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({ repository, sha, headRef, evidenceHash: evidenceHash || undefined, ...requestBody }));
  process.exit(0);
}

const token = process.env.PARKDEX_STATUS_TOKEN;
if (!token) throw new Error("PARKDEX_STATUS_TOKEN is required for separately credentialed status publication");
const response = await fetch(`https://api.github.com/repos/${repository}/statuses/${sha}`, {
  method: "POST",
  body: JSON.stringify(requestBody),
  headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "parkdex-local-ci" },
});
if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}`);
console.log(`github-status state=${state} context=${context} sha=${sha} evidence=${evidenceHash || "none"}`);
