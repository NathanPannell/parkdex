# Parkdex Kip delivery

Parkdex Kip is a Vite app with one Vercel serverless API and a dedicated Neon PostgreSQL database. It has no Railway service, durable worker, scheduled job, or automatic retry service. The feedback email work is attempted during the request; failed deliveries remain available for operator review.

The Neon project is small-cloud-35890217. Its persistent staging parent is branch br-orange-lake-akrxmy23, database parkdex_kip, role parkdex_kip_owner. The root main branch is br-shy-hat-akg1paip; preview databases must branch from staging. Isolated PR branches use Neon parent-schema initialization and expire after 72 hours. Each receives a new branch-scoped role and a fresh database, with an explicit empty-schema check before applying only database/migrations/feedback_001_init.sql and a zero-row check afterward. Report rows, attachments, and staging role credentials are never copied into the preview application.

## One-time release setup

Disable Vercel Git deployments for the parkdex-kip project. The repository push workflow owns staging deployment requests; no pull request or feature branch event creates a provider deployment. Keep Vercel project Preview variables empty. Preview and staging runtime values are sent with each exact deployment and are not saved as project Preview variables.

Configure the GitHub staging environment with:

- Secret VERCEL_TOKEN_STAGING, scoped to the Parkdex Vercel team and project.
- Secret KIP_STAGING_RUNTIME_JSON, containing exactly the staging runtime values DATABASE_URL, RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, OPERATOR_EMAIL, OPERATOR_PASSWORD_HASH, and SESSION_SECRET. An optional MIGRATION_DATABASE_URL can supply a direct Neon connection for psql; otherwise DATABASE_URL is used for the bounded migration step.
- Variables VERCEL_ORG_ID and VERCEL_STAGING_PROJECT_ID.

The runtime JSON is read only by the delivery helper. It is written to a short-lived file outside the checkout when Vercel CLI needs local configuration, then removed. The workflow queues one Vercel Preview deployment with the exact staging SHA and exits when Vercel accepts it. It does not poll provider readiness or assign the stable alias. No production branch or production release workflow is configured here.

The first tooling-only PR is the bootstrap. Merge and verify its static staging release before running this workflow for feature PRs. The helper can build a static candidate that has no API or feedback migration so that bootstrap does not depend on the later API implementation.

Vercel can classify a new project's first deployment as Production even when Preview was requested. Keep the bootstrap static and verify the returned target before assigning any staging alias. If this occurs, create a second static deployment of the same SHA, verify that its target is Preview, and remove the exact unintended initial deployment. Never send feedback runtime credentials to an unverified first deployment.

## Isolated draft PR preview

Run the scripts from a clean trusted checkout exactly at the current origin/staging SHA. Authenticate GitHub CLI for read-only PR metadata. Set process environment values NEON_API_KEY, NEON_PROJECT_ID, VERCEL_TOKEN, VERCEL_ORG_ID, and VERCEL_PREVIEW_PROJECT_ID; the preview project ID must equal the staging Vercel project ID. Install Vercel CLI 50.1.3 and PostgreSQL client psql.

The default command prints a local-only plan and performs no provider reads or writes:

```powershell
pwsh -File scripts/preview-pr.ps1 -PullRequest 123
```

Add -Apply to validate and deploy. Apply requires an open same-repository draft PR targeting staging, a clean harness at the exact current staging SHA, and a full 40-character PR head SHA. It builds a synthetic merge commit in a temporary worktree and runs npm ci, typecheck, available tests, and the production build with provider credentials removed. It then creates an expiring schema-only Neon branch, applies the single feedback migration when present, and deploys the candidate to Vercel Preview with per-deployment database, session, and generated operator credentials. Preview email mode is disabled; Resend credentials and email addresses are never passed to a preview.

```powershell
pwsh -File scripts/preview-pr.ps1 -PullRequest 123 -Apply
```

The durable journal and per-PR lock are stored outside the repository under %LOCALAPPDATA%\Parkdex\kip-preview-pr. The journal contains exact provider IDs, release identity, owner, validation results, and cleanup observations, but no credentials or database URLs. The generated operator password is saved in a separate restricted per-PR credential file beside the journal. Retrieve it only for the preview review, and keep the preview available through merge and staging verification.

Before completing review, confirm /release.json reports the PR head SHA and preview; when the API exists, confirm /api/health returns HTTP 200 and {"ok":true}. Use the exact preview URL for the browser journey and inspect the feedback submit and operator review flows. Report email delivery as disabled in previews.

## Staging release and teardown

Merging to staging starts .github/workflows/deploy-staging.yml. The workflow validates the full pushed SHA, runs local checks, applies the additive feedback migration with psql, then queues a Vercel Preview deployment with --no-wait. It does not assign an alias or wait for Vercel readiness.

After the workflow succeeds, verify the deployment’s Vercel metadata and /release.json against the exact merge SHA. Confirm /api/health and the feedback API, then assign the stable staging alias only to that verified deployment:

```powershell
python scripts/kip-delivery.py assign-staging --deployment-id dpl_... --sha <40-character-merge-sha>
python scripts/kip-delivery.py assign-staging --deployment-id dpl_... --sha <40-character-merge-sha> --apply
python scripts/kip-delivery.py verify-staging --sha <40-character-merge-sha>
```

The alias command is plan-only by default. Mark the feature PR ready and merge it only after its isolated preview passes review and browser verification. After the resulting staging release serves the exact merge SHA and its affected browser journey passes, set STAGING_VERIFIED=1 and run:

```powershell
$env:STAGING_VERIFIED = "1"
pwsh -File scripts/teardown-preview-pr.ps1 -PullRequest 123
pwsh -File scripts/teardown-preview-pr.ps1 -PullRequest 123 -Apply
Remove-Item Env:STAGING_VERIFIED
```

Teardown requires the merged commit to be the exact revision currently served by staging. For a closed, unmerged PR set PREVIEW_ABANDONED=1. To remove a failed partial preview while its draft remains open, set PREVIEW_ABORTED=1. After a PR head changes, set PREVIEW_SUPERSEDED=1, tear down the old preview, and create and verify a new one for the updated head before marking the PR ready.

Teardown uses only the journaled Vercel deployment ID and Neon branch ID, verifies provenance, and attempts both deletions even if one fails. It requires three consecutive all-absent observations after a consistency grace period before recording cleanup complete. If a provider operation fails, keep the journal and rerun the same teardown command after diagnosis. Never infer ownership from a PR number or a loose resource name.
