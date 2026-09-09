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

test("manual inspections cannot enter release jobs", () => {
  const releaseGate = ci.match(/  resolve-release:\r?\n    if: (?<gate>.+)/)?.groups?.gate;
  assert.ok(releaseGate);
  assert.match(releaseGate, /inputs\.action == 'deploy-staging'/);
  assert.match(releaseGate, /inputs\.action == 'promote-production'/);
  assert.doesNotMatch(releaseGate, /inputs\.action != 'none'/);
});

test("staging receives its exact Google and claim settings", () => {
  const staging = ci.match(/  deploy-staging:\r?\n(?<body>[\s\S]*?)\r?\n  promote-production:/)?.groups?.body;
  const production = ci.match(/  promote-production:\r?\n(?<body>[\s\S]*)/)?.groups?.body;
  assert.ok(staging);
  assert.ok(production);
  assert.match(staging, /STAGING_GOOGLE_CLIENT_ID: \$\{\{ vars\.STAGING_GOOGLE_CLIENT_ID \}\}/);
  assert.match(staging, /STAGING_GOOGLE_CLIENT_SECRET: \$\{\{ secrets\.STAGING_GOOGLE_CLIENT_SECRET \}\}/);
  assert.match(staging, /"staging" variable set APP_ENVIRONMENT/);
  assert.match(staging, /"false" variable set CLAIM_TEST_MODE/);
  assert.match(staging, /"https:\/\/\$STAGING_DOMAIN,https:\/\/localhost" variable set FRONTEND_ORIGINS/);
  assert.match(staging, /"https:\/\/\$STAGING_DOMAIN" variable set APP_PUBLIC_URL/);
  assert.match(staging, /"https:\/\/\$STAGING_DOMAIN\/auth\/google\/callback" variable set GOOGLE_REDIRECT_URI/);
  assert.match(staging, /"\$STAGING_GOOGLE_CLIENT_ID" variable set GOOGLE_CLIENT_ID --stdin/);
  assert.match(staging, /"\$STAGING_GOOGLE_CLIENT_SECRET" variable set GOOGLE_CLIENT_SECRET --stdin/);
  assert.match(staging, /"\$STAGING_DATABASE_URL_UNPOOLED" variable set DATABASE_URL_UNPOOLED --stdin --skip-deploys --service "\$RAILWAY_WORKER_SERVICE_ID"/);
  assert.doesNotMatch(production, /STAGING_GOOGLE_CLIENT|variable set GOOGLE_CLIENT_(?:ID|SECRET)/);
  assert.match(staging, /https:\/\/localhost/);
  assert.doesNotMatch(production, /https:\/\/localhost/);
});

test("production explicitly disables claim fixtures", () => {
  const production = ci.match(/  promote-production:\r?\n(?<body>[\s\S]*)/)?.groups?.body;
  assert.ok(production);
  assert.match(production, /'production' variable set APP_ENVIRONMENT/);
  assert.match(production, /'false' variable set CLAIM_TEST_MODE/);
  assert.doesNotMatch(production, /railway_retry ['"](?:true|1|yes|on)['"] variable set CLAIM_TEST_MODE/i);
  assert.match(production, /'https:\/\/parkdex\.app,https:\/\/www\.parkdex\.app' variable set FRONTEND_ORIGINS/);
  assert.match(production, /railway service status --json --service "\$RAILWAY_API_SERVICE_ID" --environment production/);
  assert.match(production, /printf -v unpooled_reference '\$%s' "\{\{\$\{api_service_name\}\.DATABASE_URL_UNPOOLED\}\}"/);
  assert.match(production, /"\$unpooled_reference" variable set DATABASE_URL_UNPOOLED --stdin --skip-deploys --service "\$RAILWAY_WORKER_SERVICE_ID"/);
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
