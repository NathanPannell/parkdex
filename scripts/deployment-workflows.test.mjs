import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const cleanup = readFileSync(".github/workflows/preview-cleanup.yml", "utf8");

test("deployments are manual and always pin staging", () => {
  assert.match(ci, /workflow_dispatch:/);
  assert.match(ci, /options: \[none, deploy-staging, promote-production\]/);
  assert.match(ci, /git\/ref\/heads\/staging/);
  assert.doesNotMatch(ci, /github\.event_name == 'push' && github\.ref/);
  assert.doesNotMatch(cleanup, /vercel deploy|railway up|create-branch-action/);
});

test("promotion fails closed around one exact staged commit", () => {
  assert.match(ci, /Verify exact staged frontend and API releases/);
  assert.match(ci, /git merge-base --is-ancestor/);
  assert.match(ci, /-F force=false/);
  assert.match(ci, /meta githubCommitSha="\$EXPECTED_COMMIT_SHA"/);
  assert.match(ci, /concurrency: \{ group: release-staging, cancel-in-progress: false \}/);
});

test("Railway waits on provider events and verifies each exact deployment once", () => {
  const subscriptions = ci.match(/railway up --ci/g) ?? [];
  assert.equal(subscriptions.length, 4);
  assert.doesNotMatch(ci, /wait-for-railway-preview-source/);
  assert.match(ci, /verify-railway-deployments\.sh "\$deployment_message"/);
});
