import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const cleanup = readFileSync(".github/workflows/preview-cleanup.yml", "utf8");

test("deployments are manual and always pin staging", () => {
  assert.match(ci, /workflow_dispatch:/);
  assert.match(ci, /options: \[none, deploy-staging, promote-production\]/);
  assert.match(ci, /git\/ref\/heads\/staging/);
  assert.doesNotMatch(ci, /^  push:/m);
  assert.doesNotMatch(ci, /^  pull_request:/m);
  assert.doesNotMatch(ci, /github\.event_name == 'push' && github\.ref/);
  assert.doesNotMatch(cleanup, /vercel deploy|railway up|create-branch-action/);
});

test("manual inspections cannot enter release jobs", () => {
  const releaseGate = ci.match(/  resolve-release:\r?\n    if: (?<gate>.+)/)?.groups?.gate;
  assert.ok(releaseGate);
  assert.match(releaseGate, /inputs\.action == 'deploy-staging'/);
  assert.match(releaseGate, /inputs\.action == 'promote-production'/);
  assert.doesNotMatch(releaseGate, /inputs\.action != 'none'/);
});

test("staging receives its exact Google settings", () => {
  const staging = ci.match(/  deploy-staging:\r?\n(?<body>[\s\S]*?)\r?\n  promote-production:/)?.groups?.body;
  const production = ci.match(/  promote-production:\r?\n(?<body>[\s\S]*)/)?.groups?.body;
  assert.ok(staging);
  assert.ok(production);
  assert.match(staging, /STAGING_GOOGLE_CLIENT_ID: \$\{\{ vars\.STAGING_GOOGLE_CLIENT_ID \}\}/);
  assert.match(staging, /STAGING_GOOGLE_CLIENT_SECRET: \$\{\{ secrets\.STAGING_GOOGLE_CLIENT_SECRET \}\}/);
  assert.match(staging, /"https:\/\/\$STAGING_DOMAIN" variable set FRONTEND_ORIGINS/);
  assert.match(staging, /"https:\/\/\$STAGING_DOMAIN" variable set APP_PUBLIC_URL/);
  assert.match(staging, /"https:\/\/\$STAGING_DOMAIN\/auth\/google\/callback" variable set GOOGLE_REDIRECT_URI/);
  assert.match(staging, /"\$STAGING_GOOGLE_CLIENT_ID" variable set GOOGLE_CLIENT_ID --stdin/);
  assert.match(staging, /"\$STAGING_GOOGLE_CLIENT_SECRET" variable set GOOGLE_CLIENT_SECRET --stdin/);
  assert.doesNotMatch(production, /STAGING_GOOGLE_CLIENT|variable set GOOGLE_CLIENT_(?:ID|SECRET)/);
  assert.doesNotMatch(ci, /https:\/\/localhost/);
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
