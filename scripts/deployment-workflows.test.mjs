import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const staging = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
const production = readFileSync(".github/workflows/deploy-production.yml", "utf8");
const release = readFileSync(".github/workflows/deploy-release.yml", "utf8");
const railwayConfig = readFileSync(".railway/railway.ts", "utf8");
const migrator = readFileSync("backend/app/migrate.py", "utf8");
const cloudflarePages = JSON.parse(readFileSync("deploy/cloudflare-pages.json", "utf8"));
const cloudflareBuild = readFileSync("frontend/scripts/cloudflare-build.mjs", "utf8");
const frontendPackage = JSON.parse(readFileSync("frontend/package.json", "utf8"));

test("old hosted test, manual release, and preview-cleanup workflows are removed", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/hosted-checkpoint.yml",
    ".github/workflows/preview-cleanup.yml",
    "scripts/preview-cleanup-disposition.mjs",
    "scripts/preview-cleanup-disposition.test.mjs",
  ]) assert.equal(existsSync(path), false, `${path} should be removed`);
});

test("the workflow directory contains only the three merge deployment files", () => {
  assert.deepEqual(readdirSync(".github/workflows").sort(), ["deploy-production.yml", "deploy-release.yml", "deploy-staging.yml"]);
  for (const [name, workflow] of [["deploy-staging.yml", staging], ["deploy-production.yml", production]]) {
    assert.doesNotMatch(workflow, /pull_request(?:_target)?:|workflow_dispatch:|schedule:|workflow_run:/, `${name} must stay merge-only`);
  }
  assert.doesNotMatch(release, /pull_request(?:_target)?:|workflow_dispatch:|schedule:|workflow_run:/);
});

test("staging deploys only the first run of a staging push", () => {
  assert.match(staging, /push:\r?\n    branches: \[staging\]/);
  assert.match(staging, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/staging' && github\.run_attempt == 1/);
  assert.match(staging, /source_sha: \$\{\{ github\.sha \}\}/);
  assert.match(staging, /uses: \.\/\.github\/workflows\/deploy-release\.yml/);
  assert.doesNotMatch(staging, /workflow_dispatch:|pull_request:|pull_request_target:|schedule:|workflow_run:|inputs:|runs-on:|resolve-source:/);
});

test("production deploys only the first run of a main push", () => {
  assert.match(production, /push:\r?\n    branches: \[main\]/);
  assert.match(production, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && github\.run_attempt == 1/);
  assert.match(production, /source_sha: \$\{\{ github\.sha \}\}/);
  assert.match(production, /uses: \.\/\.github\/workflows\/deploy-release\.yml/);
  assert.doesNotMatch(production, /workflow_dispatch:|pull_request:|pull_request_target:|schedule:|workflow_run:|inputs:|runs-on:|resolve-source:/);
});

test("staging and production share one hosted job and resolve only long-lived URLs", () => {
  assert.match(release, /workflow_call:/);
  assert.match(release, /group: parkdex-release-\$\{\{ inputs\.target \}\}/);
  assert.match(release, /cancel-in-progress: false/);
  assert.equal((release.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 1);
  assert.match(release, /timeout-minutes: 8/);
  assert.match(release, /ref: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(release, /https:\/\/api-staging-882c\.up\.railway\.app/);
  assert.match(release, /https:\/\/api-production-e72df\.up\.railway\.app/);
});

test("source validation accepts only first-attempt pushes and rejects stale branch releases", () => {
  assert.match(release, /\[\[ "\$GITHUB_EVENT_NAME" == push \]\]/);
  assert.match(release, /\[\[ "\$GITHUB_RUN_ATTEMPT" == 1 \]\]/);
  assert.match(release, /git\/ref\/heads\/\$branch/);
  assert.match(release, /TARGET_ENVIRONMENT.*production[\s\S]*branch=main; else branch=staging/);
  assert.match(release, /\[\[ "\$GITHUB_REF" == refs\/heads\/\$branch \]\]/);
  assert.match(release, /\[\[ "\$GITHUB_SHA" == "\$EXPECTED_COMMIT_SHA" \]\]/);
  assert.doesNotMatch(release, /refs\/heads\/\$TARGET_ENVIRONMENT/);
  assert.doesNotMatch(release, /workflow_dispatch|pull_request|candidate|retry/);
  assert.match(release, /refusing to queue a stale deployment/);
});

test("the API and frontend are queued concurrently without waiting for provider readiness", () => {
  assert.match(release, /railway up --detach/);
  assert.match(release, /vercel deploy --yes --no-wait --prod --skip-domain/);
  assert.match(release, /api_pid=\$!/);
  assert.match(release, /vercel_pid=\$!/);
  assert.doesNotMatch(release, /RAILWAY_WORKER_SERVICE_ID|worker_pid|wait-for-worker|RAILWAY_PHOTO_CLEANUP_SERVICE_ID|cleanup_pid/);
  assert.match(release, /parkdex-\$TARGET_ENVIRONMENT-\$EXPECTED_COMMIT_SHA-\$GITHUB_RUN_ID/);
  assert.match(release, /railway_deployment_message=/);
  assert.match(release, /vercel_deployment_url=/);
  assert.match(release, /release_id: \$\{\{ steps\.metadata\.outputs\.release_id \}\}/);
  assert.match(release, /Release ID: \\`\$RELEASE_ID\\`/);
  assert.match(release, /if \[\[ "\$TARGET_ENVIRONMENT" == staging \]\]; then[\s\S]*frontend\/catalogue-build-data/);
  for (const name of ["boundaries.geojson", "places.json", "vancouver-island-focus.geojson", "staging-field-boundaries.geojson", "staging-field-places.json"]) {
    assert.match(release, new RegExp(`data/${name.replaceAll(".", "\\.")}`));
  }
  assert.match(release, /--build-env "PARKDEX_CATALOGUE_SCOPE=\$\{\{ inputs\.target == 'staging' && 'staging' \|\| 'canonical' \}\}"/);
  assert.match(release, /--build-env "PARKDEX_KEEP_SCOPED_ASSETS=\$\{\{ inputs\.target == 'staging' && '1' \|\| '0' \}\}"/);
  assert.doesNotMatch(release, /railway deployment list|--ci|wait-for-railway|wait-for-worker|verify-railway-deployments|smoke-catalogue|curl --fail|sleep [0-9]/);
  assert.doesNotMatch(release, /\.status.*SUCCESS|status.*ready|readyState/);
});

test("normal releases do not recreate or rewrite persistent provider configuration", () => {
  assert.doesNotMatch(release, /create-branch-action|RAILWAY_BASE_ENVIRONMENT_ID|variable set .*DATABASE_URL|variable set .*FRONTEND_ORIGINS|source disconnect|domain list/);
  assert.match(release, /variable set "\$name" --stdin --skip-deploys/);
  assert.match(release, /APP_COMMIT_SHA/);
  assert.match(release, /APP_RELEASE_ID/);
  assert.match(release, /vercel deploy --yes --no-wait --prod --skip-domain/);
});

test("both environments keep independent database and stable-domain settings in Railway IaC", () => {
  assert.match(railwayConfig, /DATABASE_URL_UNPOOLED: preserve\(\)/);
  assert.match(railwayConfig, /APP_PUBLIC_URL: preserve\(\)/);
  assert.match(railwayConfig, /API_PUBLIC_URL: preserve\(\)/);
  assert.match(railwayConfig, /MCP_PUBLIC_URL: preserve\(\)/);
  assert.match(railwayConfig, /APP_RELEASE_ID: preserve\(\)/);
  assert.equal((railwayConfig.match(/preDeployCommand: \["python -m backend\.app\.migrate"\]/g) ?? []).length, 1);
  assert.match(railwayConfig, /resources: \[api\]/);
  assert.doesNotMatch(railwayConfig, /service\("worker"|Dockerfile\.worker|service\("photo-cleanup"|cronSchedule|photo_cleanup/);
  for (const name of ["API_PUBLIC_URL", "APP_PUBLIC_URL", "APP_ENVIRONMENT", "EMAIL_PROVIDER", "ENABLE_STAGING_FIELD_PLACES", "FRONTEND_ORIGINS", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "MCP_PUBLIC_URL", "PHOTO_STORAGE_BACKEND", "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_REGION", "RESEND_API_KEY", "RESEND_FROM"]) {
    assert.match(railwayConfig, new RegExp(`${name}: preserve\\(\\)`));
  }
  assert.doesNotMatch(railwayConfig, /github\("NathanPannell\/every-park"\)|source: repository/);
  assert.match(migrator, /LOCK_TIMEOUT = "5min"/);
  assert.match(migrator, /set_config\('lock_timeout', %s, true\)/);
});

test("credentials remain secret references and exact-domain assignment is explicit", () => {
  assert.match(release, /RAILWAY_API_TOKEN: \$\{\{ secrets\.RAILWAY_API_TOKEN \}\}/);
  assert.match(release, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/);
  assert.doesNotMatch(staging, /secrets: inherit/);
  assert.doesNotMatch(production, /secrets: inherit/);
  assert.match(release, /assign staging\.web\.parkdex\.app/);
  assert.match(release, /assign only web\.parkdex\.app and confirm the staging alias is unchanged/);
  assert.doesNotMatch(release, /promote it to production domains/);
  assert.doesNotMatch(release, /echo .*RAILWAY_API_TOKEN|echo .*VERCEL_TOKEN/);
});

test("Cloudflare Pages projects are isolated and Git-integrated", () => {
  assert.equal(existsSync("frontend/wrangler.jsonc"), false, "a shared deployable Wrangler config could route production to staging");
  assert.equal(cloudflarePages.$schema, "parkdex.cloudflare-pages/v1");
  assert.equal(cloudflarePages.repository, "NathanPannell/parkdex");
  assert.equal(cloudflarePages.rootDirectory, "frontend");
  assert.equal(cloudflarePages.buildCommand, "npm run build:cloudflare");
  assert.equal(cloudflarePages.buildOutputDirectory, "out");
  assert.equal(cloudflarePages.previewDeployments, "none");
  assert.equal(cloudflarePages.failOpen, false);
  assert.deepEqual(cloudflarePages.projects, {
    "parkdex-staging": {
      productionBranch: "staging",
      apiBaseUrl: "https://api-staging-882c.up.railway.app",
    },
    "parkdex-production": {
      productionBranch: "main",
      apiBaseUrl: "https://api-production-e72df.up.railway.app",
    },
  });
  assert.equal(frontendPackage.scripts["deploy:cloudflare:staging"], undefined);
  assert.equal(frontendPackage.scripts["deploy:cloudflare:production"], undefined);
  assert.match(cloudflareBuild, /PARKDEX_CATALOGUE_SCOPE: process\.env\.CF_PAGES_BRANCH\?\.trim\(\) === "staging" \? "staging" : "canonical"/);
  assert.match(cloudflareBuild, /NEXT_PUBLIC_APP_URL: appOrigin/);
  assert.match(cloudflareBuild, /https:\/\/staging\.web\.parkdex\.app/);
  assert.match(cloudflareBuild, /https:\/\/web\.parkdex\.app/);
  assert.match(frontendPackage.scripts.start, /wrangler pages dev out/);
  assert.match(frontendPackage.scripts.start, /API_BASE_URL=http:\/\/localhost:8000/);
});
