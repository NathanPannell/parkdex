#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

function run(root, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed`);
  return result.stdout.trim();
}

const root = run(process.cwd(), "git", ["rev-parse", "--show-toplevel"]);
const base = arg("--base", "origin/staging");
const head = arg("--head");
const headRef = arg("--head-ref");
const suite = arg("--suite", "all");
if (base !== "origin/staging") throw new Error("Merge-candidate validation requires --base origin/staging");
if (!head || !/^[0-9a-f]{40}$/.test(head)) throw new Error("Merge-candidate validation requires a full --head SHA");
if (!headRef || !/^[A-Za-z0-9._/-]+$/.test(headRef) || headRef.startsWith("/") || headRef.includes("..")) throw new Error("Merge-candidate validation requires a safe --head-ref");
if (!['all', 'backend', 'frontend'].includes(suite)) throw new Error("--suite must be all, backend, or frontend");
if (run(root, "git", ["status", "--porcelain"])) throw new Error("Trusted staging checkout must be clean");
run(root, "git", ["fetch", "--no-tags", "origin", "+refs/heads/staging:refs/remotes/origin/staging", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`]);
const remoteBase = run(root, "git", ["ls-remote", "origin", "refs/heads/staging"]).split(/\s+/)[0];
const baseSha = run(root, "git", ["rev-parse", base]);
const headSha = run(root, "git", ["rev-parse", head]);
if (!/^[0-9a-f]{40}$/.test(remoteBase) || remoteBase !== baseSha) throw new Error("Local staging base does not match the remote branch");
if (run(root, "git", ["rev-parse", "HEAD"]) !== baseSha) throw new Error("Merge-candidate must run from the clean current staging checkout");
if (run(root, "git", ["rev-parse", `refs/remotes/origin/${headRef}`]) !== headSha) throw new Error("Requested head does not match the remote feature branch");

const treeResult = spawnSync("git", ["merge-tree", "--write-tree", baseSha, headSha], { cwd: root, encoding: "utf8" });
if (treeResult.status !== 0) throw new Error("Merge candidate conflicts or merge-tree failed");
const treeSha = (treeResult.stdout || "").split(/\s+/).find((item) => /^[0-9a-f]{40}$/.test(item));
if (!treeSha) throw new Error("merge-tree did not return a tree SHA");
const candidateSha = run(root, "git", ["commit-tree", treeSha, "-p", baseSha, "-p", headSha], {
  input: "Parkdex local merge-candidate validation\n",
  env: { ...process.env, GIT_AUTHOR_NAME: "Parkdex local CI", GIT_AUTHOR_EMAIL: "local-ci@invalid", GIT_COMMITTER_NAME: "Parkdex local CI", GIT_COMMITTER_EMAIL: "local-ci@invalid" },
});
const repository = run(root, "git", ["remote", "get-url", "origin"]);
const trustedValidatorSource = `${run(root, "git", ["show", `${baseSha}:scripts/local-ci.mjs`])}\n`;
const trustedValidatorSha256 = createHash("sha256").update(trustedValidatorSource).digest("hex");

const output = resolve(arg("--output", join(tmpdir(), `parkdex-merge-candidate-${headSha}-${Date.now()}.json`)));
const outputRelative = relative(root, output);
if (!outputRelative.startsWith("..") && outputRelative !== "") throw new Error("Merge evidence must be outside the repository");
const localOutput = join(tmpdir(), `parkdex-local-ci-${candidateSha}-${Date.now()}.json`);
const worktree = mkdtempSync(join(tmpdir(), "parkdex-merge-candidate-"));
const validatorDirectory = mkdtempSync(join(tmpdir(), "parkdex-trusted-validator-"));
const validatorPath = join(validatorDirectory, "local-ci.mjs");
try {
  writeFileSync(validatorPath, trustedValidatorSource, "utf8");
  run(root, "git", ["worktree", "add", "--detach", worktree, candidateSha]);
  const args = [validatorPath, "--sha", candidateSha, "--suite", suite, "--output", localOutput];
  if (process.argv.includes("--skip-build")) args.push("--skip-build");
  const safeEnv = { ...process.env, CI: "true" };
  for (const key of Object.keys(safeEnv)) if (/TOKEN|SECRET|PASSWORD|PRIVATE.?KEY|API.?KEY|RAILWAY|VERCEL|NEON|GITHUB_TOKEN|DATABASE_URL/i.test(key)) delete safeEnv[key];
  const result = spawnSync(process.execPath, args, { cwd: worktree, env: safeEnv, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Merge-candidate local CI failed");
  const localEvidenceText = readFileSync(localOutput, "utf8");
  const localEvidence = JSON.parse(localEvidenceText);
  let required = suite === "backend"
    ? ["database isolation contracts", "create owned CI database", "backend seed contract", "backend migrations", "backend tests", "drop owned CI database"]
    : suite === "frontend"
      ? ["repository dependencies", "catalogue validation", "boundary source tests", "boundary geometry", "release metadata tests", "workflow contract tests", "local release contract tests", "CI evidence contract tests", "deployment helper tests", "frontend dependencies", "frontend boundary asset", "frontend territory contract", "frontend lint", "frontend typecheck", "frontend tests", "frontend build"]
      : ["database isolation contracts", "create owned CI database", "backend seed contract", "backend migrations", "backend tests", "drop owned CI database", "repository dependencies", "catalogue validation", "boundary source tests", "boundary geometry", "release metadata tests", "workflow contract tests", "local release contract tests", "CI evidence contract tests", "deployment helper tests", "frontend dependencies", "frontend boundary asset", "frontend territory contract", "frontend lint", "frontend typecheck", "frontend tests", "frontend build"];
  if (process.argv.includes("--skip-build")) required = required.filter((label) => label !== "frontend build");
  const successfulLabels = new Set((localEvidence.results || []).filter((item) => item.status === 0).map((item) => item.label));
  if (localEvidence.schema !== "parkdex.local-ci/v1" || localEvidence.status !== "success" || localEvidence.commitSha !== candidateSha || localEvidence.suite !== suite || required.some((label) => !successfulLabels.has(label))) {
    throw new Error("Merge-candidate evidence did not prove the requested synthetic-commit suite");
  }
  const evidence = {
    schema: "parkdex.merge-candidate/v1",
    status: "success",
    repository,
    baseRef: "refs/heads/staging",
    baseSha,
    remoteBaseSha: remoteBase,
    headSha,
    treeSha,
    candidateSha,
    suite,
    validatorRef: baseSha,
    trustedValidatorSha256,
    localEvidenceSha256: createHash("sha256").update(localEvidenceText).digest("hex"),
    localEvidencePath: localOutput,
    completedAt: new Date().toISOString(),
  };
  const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  renameSync(temporary, output);
  console.log(`merge-candidate status=success head=${headSha} tree=${treeSha} evidence=${output}`);
} finally {
  spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore" });
  rmSync(worktree, { recursive: true, force: true });
  rmSync(validatorDirectory, { recursive: true, force: true });
}
