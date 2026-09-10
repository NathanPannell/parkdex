#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalSource, repositorySlug, validateNestedLocalEvidence } from "./evidence-validation.mjs";

const readArg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

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
    if (git(root, ["rev-parse", `${evidence.candidateSha}^{tree}`]) !== treeSha || git(root, ["show", "-s", "--format=%P", evidence.candidateSha]) !== `${evidence.baseSha} ${sha}`) throw new Error("Candidate commit does not bind the attested merge tree and parents");
    const trustedSource = `${git(root, ["show", `${evidence.baseSha}:scripts/local-ci.mjs`])}\n`;
    if (createHash("sha256").update(trustedSource).digest("hex") !== evidence.trustedValidatorSha256) throw new Error("Trusted validator identity does not match staging");
    const localText = readFileSync(evidence.localEvidencePath, "utf8");
    if (createHash("sha256").update(localText).digest("hex") !== evidence.localEvidenceSha256) throw new Error("Nested local evidence hash does not match");
    const localEvidence = JSON.parse(localText);
    if (!validateNestedLocalEvidence(localEvidence, { candidateSha: evidence.candidateSha, treeSha, repository, validatorSha256: evidence.trustedValidatorSha256 })) {
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
