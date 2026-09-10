#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(root, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const root = run(process.cwd(), "git", ["rev-parse", "--show-toplevel"]);
const base = arg("--base", "origin/staging");
const head = arg("--head", "HEAD");
const suite = arg("--suite", "all");
const output = arg("--output");
const treeResult = spawnSync("git", ["merge-tree", "--write-tree", base, head], { cwd: root, encoding: "utf8" });
if (treeResult.status !== 0) {
  console.error("merge-candidate conflict or merge-tree failure");
  console.error((treeResult.stdout || treeResult.stderr || "").slice(-4000));
  process.exit(1);
}
const tree = (treeResult.stdout || "").split(/\s+/).find((value) => /^[0-9a-f]{40}$/.test(value));
if (!tree) throw new Error("merge-tree did not return a tree SHA");

const candidate = run(root, "git", ["commit-tree", tree, "-p", base, "-p", head], {
  input: "Parkdex local merge-candidate validation\n",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "Parkdex local CI",
    GIT_AUTHOR_EMAIL: "local-ci@invalid",
    GIT_COMMITTER_NAME: "Parkdex local CI",
    GIT_COMMITTER_EMAIL: "local-ci@invalid",
  },
});
const worktree = mkdtempSync(join(tmpdir(), "parkdex-merge-candidate-"));
try {
  run(root, "git", ["worktree", "add", "--detach", worktree, candidate]);
  const args = ["scripts/local-ci.mjs", "--sha", candidate, "--suite", suite];
  if (process.argv.includes("--skip-build")) args.push("--skip-build");
  if (output) args.push("--output", output);
  const safeEnv = { ...process.env, CI: "true" };
  for (const key of Object.keys(safeEnv)) {
    if (/TOKEN|SECRET|PASSWORD|PRIVATE.?KEY|API.?KEY|RAILWAY|VERCEL|NEON|GITHUB_TOKEN|DATABASE_URL/i.test(key)) delete safeEnv[key];
  }
  safeEnv.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/app";
  safeEnv.DATABASE_URL_UNPOOLED = safeEnv.DATABASE_URL;
  const result = spawnSync(process.execPath, args, { cwd: worktree, env: safeEnv, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore" });
  rmSync(worktree, { recursive: true, force: true });
}
