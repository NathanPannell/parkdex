import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync("scripts/local-release.mjs", "utf8");
const fixedRelease = "11111111-1111-4111-8111-111111111111";
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

function invoke(args, env = {}) {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC", "ComSpec", "WINDIR"];
  const safeEnv = Object.fromEntries(keep.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return spawnSync(process.execPath, ["scripts/local-release.mjs", ...args], {
    cwd: process.cwd(),
    env: { ...safeEnv, ...env },
    encoding: "utf8",
  });
}

test("preview planning is unique and provider-free", () => {
  const result = invoke(["--mode", "preview", "--pr", "321", "--release-id", fixedRelease]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.match(plan.railwayEnvironment, /^local-pr-321-[0-9a-f]{12}-11111111$/);
  assert.equal(plan.neonBranch, `preview/${plan.railwayEnvironment}`);
  assert.equal(plan.apply, false);
});

test("apply remains fail-closed before provider commands", () => {
  const result = invoke(["--mode", "preview", "--pr", "321", "--release-id", fixedRelease, "--sha", head, "--apply"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provider mutation remains disabled/);
});

test("cleanup requires an explicit durable journal", () => {
  const result = invoke(["--mode", "cleanup", "--release-id", fixedRelease, "--apply"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provider mutation remains disabled/);
});

test("cleanup without apply is rejected before journal access", () => {
  const result = invoke(["--mode", "cleanup", "--release-id", fixedRelease]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cleanup requires explicit --apply/);
});

test("orchestration preserves the isolation and identity contracts", () => {
  assert.doesNotMatch(source, /environment", "new"[^\n]*--(?:copy|duplicate)/);
  assert.doesNotMatch(source, /APP_ENVIRONMENT/);
  assert.match(source, /RAILWAY_ENVIRONMENT_NAME/);
  assert.match(source, /PREVIEW_DATABASE_URL_UNPOOLED/);
  assert.match(source, /APP_RELEASE_ID/);
  assert.match(source, /verify-railway-deployments\.sh/);
  assert.match(source, /parkdexReleaseId/);
  assert.match(source, /parkdexEnvironment/);
  assert.match(source, /state\.neonBranch !== `preview\/\$\{state\.railwayEnvironment\}`/);
  assert.match(source, /Preview database zero-row gate/);
  assert.match(source, /frontend-creating/);
  assert.match(source, /VERCEL_PROJECT_ID: process\.env\.VERCEL_PROJECT_ID/);
  assert.match(source, /Provider mutation remains disabled until/);
  assert.ok(source.indexOf("atomicJournal(journalPath, state)") < source.lastIndexOf("createNeonBranch(state, journalPath)"));
  assert.doesNotMatch(source, /npm(?:\.cmd)?[^\n]*run[^\n]*build/);
});
