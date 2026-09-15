# Independent staging and production deployments

Parkdex uses short GitHub Actions merge deployments and long-lived provider resources. The only automatic deployment events are protected-branch merge pushes to `staging` and `main`. A workflow run validates one immutable Git SHA, stamps that SHA and a release ID on the Railway API, starts the API and Vercel uploads concurrently, and exits as soon as both providers accept the requests. It never polls builds, waits for `/ready`, or runs browser smoke tests.

The release agent owns everything after queueing: it waits outside GitHub Actions for provider convergence, verifies the exact revision, performs the Vercel domain cutover, browser-tests the stable URL, and then stops. A successful Actions run means **queued**, not **live**.

Each merge deploy uses one standard Ubuntu job with an eight-minute timeout. At 6-12 deployments per week, the hard-ceiling forecast is about 208-416 runner-minutes per month after the repository becomes private. GitHub Actions budgets are account-level and monetary rather than an exact per-repository minute counter, so the workflow shape and release cadence are the enforcement mechanism for the 500-minute project target.

## Persistent topology

Routine releases reuse these resources and never recreate them:

| Target | Frontend | Public MCP | Railway API | Neon branch |
| --- | --- | --- | --- | --- |
| staging | `https://staging.parkdex.app` | `https://staging.parkdex.app/mcp` | `https://api-staging-882c.up.railway.app` | `staging` |
| production | `https://parkdex.app` | `https://parkdex.app/mcp` | `https://api-production-e72df.up.railway.app` | `main` |

The Railway environments retain their pooled and direct Neon URLs, CORS origins, public URLs, OAuth settings, and other application secrets. The API's `API_PUBLIC_URL` is the environment's frontend origin and `MCP_PUBLIC_URL` is that origin plus `/mcp`; Vercel proxies the MCP and OAuth routes to the stable Railway API. The deploy workflow updates only `APP_COMMIT_SHA` and `APP_RELEASE_ID`. Neon receives migrations through the Railway API pre-deploy command; it does not receive an application-code deployment.

Keep `parkdex.app` attached directly to the production deployment and redirect `www.parkdex.app` to the apex, never the reverse, because the apex is the production OAuth issuer. The staging alias must point to the verified Vercel Production build and must not be bound to the `staging` Git branch, because Hobby deployment protection would replace public MCP/OAuth responses on a branch domain with a Vercel sign-in page.

Vercel and Railway Git auto-deployments remain disabled so a push cannot create a second, competing release. Both staging and production use the same shared workflow and queue a staged Vercel Production build with `--prod --skip-domain --no-wait`. The release agent assigns only the environment's exact stable domain: `staging.parkdex.app` for staging and `parkdex.app` for production. Because both are production-domain aliases in one Hobby project, never use project-wide Promote, Instant Rollback, `vercel promote`, `vercel rollback`, a promote/rollback API, or `vercel deploy --prod` without `--skip-domain`; those operations can move both environments together. Keep the Production build environment free of secrets that reviewed staging code must not receive; split staging into a separate project before adding such a secret.

The API runs the checksummed, advisory-locked migration command before starting. The lock wait is capped at five minutes. Both Railway environments must therefore give the API `DATABASE_URL_UNPOOLED`. Migrations must be additive and compatible with the old and new frontend and API while the providers converge.

Before the first independent release, apply the reviewed Railway configuration once to each existing environment. Review each plan before applying it; do not use `--confirm-destructive`:

```powershell
foreach ($environment in @('staging', 'production')) {
  railway link --project $env:RAILWAY_PROJECT_ID --environment $environment
  railway config plan
  railway config apply --yes
  railway config plan --detailed-exit-code
  if ($LASTEXITCODE -ne 0) { throw "Railway configuration still differs in $environment" }
}
```

Verify in Railway that the API shows `python -m backend.app.migrate` as its pre-deploy command and has a `DATABASE_URL_UNPOOLED` variable before starting the release. The value must remain provider-managed and must not be copied into GitHub or logs.

Do not start another release to an environment while an earlier one is unresolved. GitHub concurrency serializes only the short queueing jobs; it cannot serialize provider builds after the workflow exits.

Location-claim enforcement is intentionally a two-release convergence. Follow the adjacent-version
runbook in [Location claims and private visit postcards](claims.md#adjacent-version-rollout): ship
the claim-aware API and clients with `VISIT_CLAIM_ENFORCEMENT=compatible`, wait until that client
is N-1 (including the minimum supported Android APK), then change the persistent environment to
`required` in a later release. Enabling `required` during the first rollout breaks every old
client's only visit-creation path and violates the compatibility contract above.

## Branch and trigger controls

Both `staging` and `main` require pull requests for every change, including repository administrators. Force pushes and branch deletion are disabled. The deployment entry workflows have no `workflow_dispatch`, `pull_request`, `schedule`, or `workflow_run` trigger, and a rerun is rejected before runner allocation. Consequently, a deployment can start only from the first run of a protected-branch merge push. Docs-only merges intentionally deploy because there are no path filters.

Opening a draft PR, pushing another commit to it, creating a local preview, browser-testing it, and tearing it down consume no GitHub-hosted runner minutes. Provider build/runtime quotas still apply to the Vercel, Railway, and Neon resources while the preview exists.

## Draft PR: validate, preview, browser-test, and tear down

1. Start from `staging`, implement the change locally, and run the complete suite before pushing:

   ```powershell
   $candidateSha = git rev-parse HEAD
   node scripts/local-ci.mjs --sha $candidateSha --suite all
   ```

2. Push the feature branch and open a **draft**, same-repository PR targeting `staging`. Pushing or updating the draft does not run Actions. This local path is only for branches authored or reviewed by the trusted operator/agent; local tests and Vercel builds are not sandboxes for hostile contributor code.
3. Use a separate clean checkout whose `HEAD` is the current `origin/staging`. Authenticate the local CLIs, provide the exact provider identifiers listed below, and preview the draft PR:

   ```powershell
   pwsh -File scripts/preview-pr.ps1 -PullRequest 123 -Apply
   ```

   The wrapper obtains the head ref and SHA from GitHub, requires an open same-repository draft based on `staging`, refuses a second active preview for that PR, and rebuilds the full synthetic merge-candidate attestation. Only after validation succeeds does it invoke the provider engine. Keep the printed journal path; the active record and evidence live below `%LOCALAPPDATA%\Parkdex\preview-pr`, outside the repository.

4. The script creates one isolated, seven-day-expiring Neon schema branch and fresh database, one empty Railway environment with only the API service, and one immutable Vercel Preview deployment. It waits locally for migrations, provider builds, `/ready`, CORS, catalogue/read-write isolation, and frontend content. The Vercel project is required to have zero configured Preview environment variables before the candidate build starts. Vercel may still expose platform system variables; do not use this path for untrusted code or grant those variables external cloud trust.
5. Browser-test the printed immutable preview URL. Exercise the affected journey, guest/catalogue/collection behavior, responsive behavior when relevant, and console/network failures. Google OAuth is a known limitation because its callback URL is not registered for ephemeral deployments. Outbound email is also disabled. These limitations are not preview acceptance failures.
6. The same agent tears down the exact journal after testing, including after a failed preview:

   ```powershell
   pwsh -File scripts/teardown-preview-pr.ps1 -PullRequest 123 -Apply
   # Recovery when the active pointer is unavailable:
   pwsh -File scripts/teardown-preview-pr.ps1 -PullRequest 123 -StatePath '<exact-journal-path>' -Apply
   ```

   The teardown takes an exclusive per-PR lifecycle lock, binds the active record to the exact journal, verifies ownership before deletion, attempts all three providers, and waits through a grace window for three consecutive empty inventories. It reports `status=cleaned` only after the Vercel deployment, Railway environment, and Neon branch are stably absent. If it exits nonzero, retry the exact command and do not merge. Journal-only recovery without the active record does not open the merge gate. Neon expiry is a backstop, not a substitute for teardown; Railway and Vercel have no automatic cleanup backstop.
7. Reconfirm the draft PR head is the browser-tested SHA, mark it ready, complete review, and merge it into `staging`. The merge push is the first GitHub Actions event: it queues the normal persistent staging release. The release agent then verifies provider convergence and browser-smoke-tests `https://staging.parkdex.app` for the merge SHA.

Required local configuration is `RAILWAY_PROJECT_ID`, `RAILWAY_BASE_ENVIRONMENT_ID`, `RAILWAY_API_SERVICE_ID`, `NEON_ORG_ID`, `NEON_PROJECT_ID`, `NEON_PARENT_BRANCH=staging`, `VERCEL_SCOPE`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_NAME`, and `VERCEL_PROJECT_ID`, plus authenticated Railway, Neon, Vercel, and GitHub CLIs. Provider tokens may be supplied as local environment variables but are never written to GitHub, candidate evidence, the repository, or the preview environment.

The one-time rollout that first adds these wrappers cannot execute `scripts/preview-pr.ps1` from the trusted `origin/staging` harness because the script is not there yet. For this rollout only, require full local CI and independent review, merge to `staging`, and verify the first automatic staging deployment. Every subsequent application PR uses the isolated preview lifecycle above.

## Production: merge, verify, assign, stop

1. Open and review a pull request containing only the staging-validated release changes against `main`. Confirm staging is healthy and no staging or production release is still in flight.
2. Record the current production revision and merge the pull request.
3. The `main` push starts `deploy-production.yml`. It invokes the same queue-only workflow used by staging and exits after the providers accept the exact merged SHA.
4. The release agent waits locally for the Railway API, migrations, and staged Vercel deployment to report the expected SHA and release ID. Test the immutable Vercel deployment before changing public domains when practical.
5. Record the deployment currently assigned to `staging.parkdex.app`, assign only `parkdex.app` to the exact verified production deployment, and confirm the staging deployment did not change. Keep `www.parkdex.app` configured as a redirect to the apex. Then smoke-test the stable production URL in a real browser:

   ```powershell
   vercel alias set <vercel-deployment-url> parkdex.app --cwd frontend --scope <scope> --token $env:VERCEL_TOKEN
   ```

6. Verify frontend-to-API traffic, console and network output, and `/ready`. Record the evidence and stop once every check passes.

## Retry and rollback

- GitHub workflow reruns are intentionally blocked. If a provider rejected the merge upload, diagnose it and retry only that provider from the trusted local release session using the same SHA and environment, or merge a narrow corrective commit.
- If exactly one provider failed after accepting the request, retry only that provider with the same SHA and environment. Use at most one diagnosed transient retry before reassessing.
- If a small configuration or release-command correction is obvious, fix it, queue the same SHA again, and repeat the complete verification.
- If application behavior, schema compatibility, or provider state is ambiguous, stop new releases and prepare a rollback plan naming the last-known-good SHA, the exact Vercel and Railway targets, database compatibility assumptions, and smoke checks.
- Never automatically reverse a migration, restore Neon, delete a persistent environment, or recreate its stable domain as a recovery shortcut.
