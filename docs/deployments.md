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

Keep `parkdex.app` attached directly to the production deployment and redirect `www.parkdex.app` to the apex, never the reverse, because the apex is the production OAuth issuer. The staging alias must point to the verified Vercel Production build so deployment protection cannot replace public MCP/OAuth responses with a Vercel sign-in page.

Vercel and Railway Git auto-deployments remain disabled so a push cannot create a second, competing release. Both staging and production use the same shared workflow and queue a staged Vercel Production build with `--prod --skip-domain --no-wait`. Staging later assigns `staging.parkdex.app` to the verified deployment; production later promotes the verified deployment to the production domains. The current Hobby setup intentionally uses one Vercel project so both targets follow the identical build path. Keep its Production build environment free of secrets that reviewed staging code must not receive; split staging into a separate project before adding such a secret.

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

## Branch and trigger controls

Both `staging` and `main` require pull requests for every change, including repository administrators. Force pushes and branch deletion are disabled. The deployment entry workflows have no `workflow_dispatch`, `pull_request`, `schedule`, or `workflow_run` trigger, and a rerun is rejected before runner allocation. Consequently, a deployment can start only from the first run of a protected-branch merge push. Docs-only merges intentionally deploy because there are no path filters.

## Staging: validate locally, deploy, browser-test, then merge

1. Start from an issue or prompt, create a feature branch from `staging`, and open a same-repository pull request targeting `staging`.
2. Run the full validation locally and complete code review. Do not expose provider credentials to unreviewed code.
3. From a separate clean checkout whose `HEAD` is the current `origin/staging`, build a full merge-candidate attestation and deploy the exact reviewed PR head to persistent staging:

   ```powershell
   $featureRef = '<feature-branch>'
   $pullRequest = 123
   git fetch --no-tags origin staging $featureRef
   $candidateSha = git rev-parse "origin/$featureRef"
   $evidence = Join-Path $env:TEMP "parkdex-merge-candidate-$candidateSha.json"
   node scripts/merge-candidate.mjs --base origin/staging --head $candidateSha --head-ref $featureRef --suite all --output $evidence
   pwsh -File scripts/local-release.ps1 -Mode Staging -PullRequest $pullRequest -CommitSha $candidateSha -HeadRef $featureRef -AttestationPath $evidence -Apply
   ```

   The local session must be authenticated to Railway and Vercel and must provide the exact project, API service, staging-environment, organization, and Vercel project identifiers. Persistent staging requires `RAILWAY_STAGING_ENVIRONMENT_ID`; the preview-only `RAILWAY_BASE_ENVIRONMENT_ID` is not a fallback. Before mutating anything, the command verifies the API migration command, pooled and direct database variables, absent Git source, and the exact stable staging API domain. The staging command changes only `APP_COMMIT_SHA` and `APP_RELEASE_ID`; it preserves stable provider configuration.
4. The local command waits until the Railway API deployment, `/ready`, and immutable Vercel deployment prove the exact SHA and release ID, then assigns `staging.parkdex.app`. Record the external release journal and exact provider identities in the task ledger.
5. Browser-test `https://staging.parkdex.app`, exercising the affected journey and inspecting console and network failures. Report `OK` only for the exact tested SHA.
6. Reconfirm that the PR head and base have not changed, then merge the PR into `staging`.
7. The protected `staging` merge push queues the resulting merge SHA. The release agent repeats convergence verification, assigns only the verified Vercel deployment to the staging domain, and smoke-tests the merged revision before declaring staging complete.

The one-time rollout that first enables this local staging command cannot pre-deploy itself through the still-disabled script on `origin/staging`. For that rollout only, merge after full local CI and independent review, then treat the first automatic staging deployment as the candidate: verify provider convergence and browser-test the exact merge SHA before publishing the same infrastructure change to `main`.

## Production: merge, verify, promote, stop

1. Open and review a pull request containing only the staging-validated release changes against `main`. Confirm staging is healthy and no staging or production release is still in flight.
2. Record the current production revision and merge the pull request.
3. The `main` push starts `deploy-production.yml`. It invokes the same queue-only workflow used by staging and exits after the providers accept the exact merged SHA.
4. The release agent waits locally for the Railway API, migrations, and staged Vercel deployment to report the expected SHA and release ID. Test the immutable Vercel deployment before changing public domains when practical.
5. Promote that exact staged Vercel deployment, then smoke-test the stable production URL in a real browser:

   ```powershell
   vercel promote <vercel-deployment-url> --cwd frontend --scope <scope> --token $env:VERCEL_TOKEN
   ```

6. Verify frontend-to-API traffic, console and network output, and `/ready`. Record the evidence and stop once every check passes.

## Retry and rollback

- GitHub workflow reruns are intentionally blocked. If a provider rejected the merge upload, diagnose it and retry only that provider from the trusted local release session using the same SHA and environment, or merge a narrow corrective commit.
- If exactly one provider failed after accepting the request, retry only that provider with the same SHA and environment. Use at most one diagnosed transient retry before reassessing.
- If a small configuration or release-command correction is obvious, fix it, queue the same SHA again, and repeat the complete verification.
- If application behavior, schema compatibility, or provider state is ambiguous, stop new releases and prepare a rollback plan naming the last-known-good SHA, the exact Vercel and Railway targets, database compatibility assumptions, and smoke checks.
- Never automatically reverse a migration, restore Neon, delete a persistent environment, or recreate its stable domain as a recovery shortcut.
