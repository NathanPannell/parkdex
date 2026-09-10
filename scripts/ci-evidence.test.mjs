import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const mergeScript = join(repoRoot, "scripts", "merge-candidate.mjs");
const statusScript = join(repoRoot, "scripts", "github-status.mjs");
const statusSource = readFileSync(statusScript, "utf8");
const requiredLabels = ["database isolation contracts", "create owned CI database", "backend seed contract", "backend migrations", "backend tests", "drop owned CI database", "repository dependencies", "catalogue validation", "boundary source tests", "boundary geometry", "release metadata tests", "workflow contract tests", "local release contract tests", "CI evidence contract tests", "deployment helper tests", "frontend dependencies", "frontend boundary asset", "frontend territory contract", "frontend lint", "frontend typecheck", "frontend tests", "frontend build"];

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("trusted staging orchestration ignores feature-owned validators and binds status to the current merge tree", () => {
  const root = mkdtempSync(join(tmpdir(), "parkdex-evidence-contract-"));
  const owner = join(root, "owner");
  const bare = join(owner, "repo.git");
  const work = join(root, "work");
  try {
    mkdirSync(owner);
    run("git", ["init", "--bare", bare], root);
    run("git", ["init", "-b", "staging", work], root);
    run("git", ["config", "user.name", "Test"], work);
    run("git", ["config", "user.email", "test@example.invalid"], work);
    mkdirSync(join(work, "scripts"));
    writeFileSync(join(work, "base.txt"), "base\n");
    const trustedValidator = `import {writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';const arg=n=>process.argv[process.argv.indexOf(n)+1];const sha=arg('--sha');const suite=arg('--suite');const output=arg('--output');const results=${JSON.stringify(requiredLabels)}.map(label=>({label,status:0}));writeFileSync(output,JSON.stringify({schema:'parkdex.local-ci/v1',status:'success',commitSha:sha,suite,results})+'\\n');\n`;
    writeFileSync(join(work, "scripts", "local-ci.mjs"), trustedValidator);
    writeFileSync(join(work, "scripts", "github-status.mjs"), statusSource);
    writeFileSync(join(work, "scripts", "merge-candidate.mjs"), "throw new Error('repository copy is not invoked by this contract');\n");
    run("git", ["add", "."], work);
    run("git", ["commit", "-m", "trusted staging harness"], work);
    run("git", ["remote", "add", "origin", bare], work);
    run("git", ["push", "-u", "origin", "staging"], work);
    const baseSha = run("git", ["rev-parse", "HEAD"], work);
    run("git", ["switch", "-c", "feature"], work);
    writeFileSync(join(work, "feature.txt"), "feature\n");
    for (const name of ["local-ci.mjs", "merge-candidate.mjs", "github-status.mjs"]) writeFileSync(join(work, "scripts", name), "process.exit(9);\n");
    run("git", ["add", "."], work);
    run("git", ["commit", "-m", "replace repository harnesses"], work);
    const headSha = run("git", ["rev-parse", "HEAD"], work);
    run("git", ["push", "-u", "origin", "feature"], work);
    run("git", ["switch", "staging"], work);

    const evidencePath = join(root, "merge-evidence.json");
    run(process.execPath, [mergeScript, "--base", "origin/staging", "--head", headSha, "--head-ref", "feature", "--suite", "all", "--output", evidencePath], work);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.headSha, headSha);
    assert.equal(evidence.baseSha, baseSha);
    assert.equal(evidence.baseSha, evidence.remoteBaseSha);
    assert.equal(evidence.validatorRef, baseSha);
    assert.equal(evidence.trustedValidatorSha256, createHash("sha256").update(`${trustedValidator.trim()}\n`).digest("hex"));
    assert.match(evidence.treeSha, /^[0-9a-f]{40}$/);
    assert.match(evidence.localEvidenceSha256, /^[0-9a-f]{64}$/);

    const accepted = spawnSync(process.execPath, [statusScript, "--repository", "owner/repo", "--sha", headSha, "--head-ref", "feature", "--state", "success", "--attestation", evidencePath, "--dry-run"], { cwd: work, encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, new RegExp(`local-ci/staging-${baseSha.slice(0, 12)}`));

    const nestedPath = evidence.localEvidencePath;
    const nestedText = readFileSync(nestedPath, "utf8");
    const nested = JSON.parse(nestedText);
    nested.results.pop();
    writeFileSync(nestedPath, `${JSON.stringify(nested)}\n`);
    const tampered = spawnSync(process.execPath, [statusScript, "--repository", "owner/repo", "--sha", headSha, "--head-ref", "feature", "--state", "success", "--attestation", evidencePath, "--dry-run"], { cwd: work, encoding: "utf8" });
    assert.notEqual(tampered.status, 0);
    writeFileSync(nestedPath, nestedText);

    writeFileSync(join(work, "base.txt"), "advanced\n");
    run("git", ["add", "base.txt"], work);
    run("git", ["commit", "-m", "advance staging"], work);
    run("git", ["push", "origin", "staging"], work);
    const stale = spawnSync(process.execPath, [statusScript, "--repository", "owner/repo", "--sha", headSha, "--head-ref", "feature", "--state", "success", "--attestation", evidencePath, "--dry-run"], { cwd: work, encoding: "utf8" });
    assert.notEqual(stale.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
