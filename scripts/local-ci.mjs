#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

function readArg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function redact(value) {
  return String(value || "")
    .replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, "$1[redacted]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9_\-]{41,}/g, "[redacted]");
}

function commandName(name) {
  return process.platform === "win32" && name === "npm" ? "npm.cmd" : name;
}

function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(redact(result.stderr || result.stdout));
  return result.stdout.trim();
}

const root = runGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
const actualSha = runGit(root, ["rev-parse", "HEAD"]);
const treeSha = runGit(root, ["rev-parse", "HEAD^{tree}"]);
const repository = runGit(root, ["remote", "get-url", "origin"]);
const validatorSha256 = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
const expectedSha = readArg("--sha");
if (expectedSha && expectedSha !== actualSha) {
  console.error(`local-ci refused stale checkout: expected ${expectedSha}, found ${actualSha}`);
  process.exit(2);
}
const initialStatus = runGit(root, ["status", "--porcelain"]);
if (initialStatus) {
  console.error("local-ci refused a dirty worktree");
  process.exit(2);
}

const suite = readArg("--suite", "all");
if (!["all", "backend", "frontend"].includes(suite)) {
  console.error("--suite must be all, backend, or frontend");
  process.exit(2);
}

const startedAt = new Date().toISOString();
const results = [];
const databaseAdminUrl = process.env.PARKDEX_TEST_DATABASE_ADMIN_URL || "postgresql://postgres:postgres@localhost:5432/postgres";
const env = { ...process.env, CI: "true" };
for (const key of Object.keys(env)) {
  if (/TOKEN|SECRET|PASSWORD|PRIVATE.?KEY|API.?KEY|RAILWAY|VERCEL|NEON|GITHUB_TOKEN|DATABASE_URL/i.test(key)) {
    delete env[key];
    delete process.env[key];
  }
}

function run(label, command, args, cwd = root, extraEnv = {}) {
  const started = Date.now();
  const executable = process.platform === "win32" && command === "npm" ? "cmd.exe" : commandName(command);
  const childArgs = process.platform === "win32" && command === "npm" ? ["/d", "/c", "npm.cmd", ...args] : args;
  const result = spawnSync(executable, childArgs, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 24 * 1024 * 1024,
  });
  const stdout = redact(result.stdout || "");
  const stderr = redact(`${result.stderr || ""}\n${result.error?.message || ""}`);
  results.push({
    label,
    command: [command, ...args].join(" "),
    status: result.status ?? 1,
    durationSeconds: Math.round((Date.now() - started) / 100) / 10,
    outputTail: `${stdout}\n${stderr}`.trim().slice(-4000),
  });
  if (result.error || result.status !== 0) throw new Error(`${label} failed`);
}

let status = "success";
let failure = "";
try {
  if (suite === "all" || suite === "backend") {
    const databaseName = `parkdex_ci_${process.pid}_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const databaseUrl = `${databaseAdminUrl.slice(0, databaseAdminUrl.lastIndexOf("/") + 1)}${databaseName}`;
    const databaseEnv = { PARKDEX_TEST_DATABASE_ADMIN_URL: databaseAdminUrl, DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrl };
    let databaseCreated = false;
    try {
      run("database isolation contracts", "python", ["-m", "pytest", "scripts/local_test_database_test.py", "-q"], root, { PARKDEX_TEST_DATABASE_ADMIN_URL: databaseAdminUrl });
      run("create owned CI database", "python", ["scripts/local_test_database.py", "create", databaseName], root, { PARKDEX_TEST_DATABASE_ADMIN_URL: databaseAdminUrl });
      databaseCreated = true;
      run("backend seed contract", "python", ["scripts/build_seed_migration.py", "--check"], root, databaseEnv);
      if (hasFlag("--install-backend")) {
        run("backend dependencies", "python", ["-m", "pip", "install", "-r", "backend/requirements-dev.txt"], root, databaseEnv);
      }
      run("backend migrations", "python", ["-m", "backend.app.migrate"], root, databaseEnv);
      run("backend tests", "python", ["-m", "pytest", "backend/tests"], root, databaseEnv);
    } finally {
      if (databaseCreated) run("drop owned CI database", "python", ["scripts/local_test_database.py", "drop", databaseName], root, { PARKDEX_TEST_DATABASE_ADMIN_URL: databaseAdminUrl });
    }
  }

  if (suite === "all" || suite === "frontend") {
    run("repository dependencies", "npm", ["ci"]);
    run("catalogue validation", "node", ["scripts/data-validate.mjs"]);
    run("boundary source tests", "npm", ["run", "boundaries:test"]);
    run("boundary geometry", "node", ["scripts/boundary-validate.mjs"]);
    run("release metadata tests", "node", ["--test", "scripts/release-metadata.test.mjs"]);
    run("workflow contract tests", "node", ["--test", "scripts/deployment-workflows.test.mjs"]);
    run("local release contract tests", "node", ["--test", "scripts/local-release.test.mjs"]);
    run("CI evidence contract tests", "node", ["--test", "scripts/ci-evidence.test.mjs"]);
    run("deployment helper tests", "bash", ["scripts/deployment-helpers.test.sh"]);
    run("frontend dependencies", "npm", ["ci"], join(root, "frontend"));
    run("frontend boundary asset", "node", ["scripts/check-boundary-asset.mjs"], join(root, "frontend"));
    run("frontend territory contract", "npm", ["run", "check:exploration-territories"], join(root, "frontend"));
    run("frontend lint", "npm", ["run", "lint"], join(root, "frontend"));
    run("frontend typecheck", "npm", ["run", "typecheck"], join(root, "frontend"));
    run("frontend tests", "npm", ["test"], join(root, "frontend"));
    if (!hasFlag("--skip-build")) {
      run("frontend build", "npm", ["run", "build"], join(root, "frontend"), {
        NEXT_PUBLIC_API_BASE_URL: "http://localhost:8000",
        NEXT_PUBLIC_RELEASE_VERSION: "local",
        NEXT_PUBLIC_COMMIT_SHA: actualSha,
        NEXT_PUBLIC_COMMIT_DATE: startedAt,
      });
    }
  }
} catch (error) {
  status = "failure";
  failure = redact(error.message);
}

if (status === "success") {
  const finalSha = runGit(root, ["rev-parse", "HEAD"]);
  const finalStatus = runGit(root, ["status", "--porcelain"]);
  if (finalSha !== actualSha || finalStatus) {
    status = "failure";
    failure = "worktree changed during validation";
  }
}

const endedAt = new Date().toISOString();
const output = resolve(readArg("--output", join(tmpdir(), `parkdex-local-ci-${actualSha}-${Date.now()}.json`)));
const outputRelative = relative(root, output);
if (!outputRelative.startsWith("..") && outputRelative !== "") throw new Error("Attestation output must be outside the repository");
const attestation = {
  schema: "parkdex.local-ci/v1",
  status,
  failure: failure || undefined,
  repository,
  commitSha: actualSha,
  treeSha,
  suite,
  validatorSha256,
  startedAt,
  endedAt,
  runner: `${process.platform}/${process.arch}`,
  toolchain: { node: process.version },
  results,
};
mkdirSync(dirname(output), { recursive: true });
const temporaryOutput = `${output}.${process.pid}.tmp`;
writeFileSync(temporaryOutput, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
renameSync(temporaryOutput, output);
console.log(`local-ci status=${status} sha=${actualSha} attestation=${output}`);
process.exitCode = status === "success" ? 0 : 1;
