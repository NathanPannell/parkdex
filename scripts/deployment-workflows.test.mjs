import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const cleanup = readFileSync(".github/workflows/preview-cleanup.yml", "utf8");

test("deployments are manual and always pin staging", () => {
  assert.match(ci, /workflow_dispatch:/);
  assert.match(ci, /options: \[none, inspect-railway-sources, deploy-staging, promote-production\]/);
  assert.match(ci, /git\/ref\/heads\/staging/);
  assert.doesNotMatch(ci, /github\.event_name == 'push' && github\.ref/);
  assert.doesNotMatch(cleanup, /vercel deploy|railway up|create-branch-action/);
});

test("Railway source inspection is read-only and isolated from releases", () => {
  const inspection = ci.match(/  inspect-railway-sources:\n(?<body>[\s\S]*?)\n  backend:/)?.groups?.body;
  assert.ok(inspection);
  assert.match(inspection, /inputs\.action == 'inspect-railway-sources'/);
  assert.match(inspection, /github\.ref == 'refs\/heads\/chore\/manual-deploy-workflows'/);
  assert.match(inspection, /github\.actor == vars\.TRUSTED_PREVIEW_ACTOR/);
  assert.match(inspection, /railway status --project "\$expected_project"/);
  assert.match(inspection, /railway service list --project "\$expected_project" --environment "\$environment" --json/);
  assert.match(inspection, /railway environment config --environment "\$environment" --json \| jq/);
  assert.match(inspection, /source: \(\(\$services\[\$id\]\.source \/\/ \{\}\)/);
  assert.match(inspection, /\.id == \$api and \.name == "api"/);
  assert.match(inspection, /\.id == \$worker and \.name == "worker"/);
  assert.match(inspection, /tee -a "\$GITHUB_STEP_SUMMARY"/);
  assert.match(inspection, /any\(\.\[\]; \(\(\.source\.repo \/\/ ""\) \| length\) > 0\)/);
  assert.match(inspection, /Railway services still has a Git repository source/);
  assert.doesNotMatch(inspection, /source disconnect|railway up|railway redeploy|gh api|git push|variable set/);

  const releaseGate = ci.match(/  resolve-release:\n    if: (?<gate>.+)/)?.groups?.gate;
  assert.ok(releaseGate);
  assert.match(releaseGate, /inputs\.action == 'deploy-staging'/);
  assert.match(releaseGate, /inputs\.action == 'promote-production'/);
  assert.doesNotMatch(releaseGate, /inputs\.action != 'none'|inspect-railway-sources/);
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
