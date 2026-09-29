# Parkdex delivery

Parkdex is a Vite app with a Vercel Node.js API and dedicated Neon PostgreSQL environments. Kip is its mascot; internal provider and repository identifiers retain their existing names. Account releases also use private Cloudflare photo Workers, isolated private R2 buckets, and SQLite Durable Objects per account to serialize photo uploads against deletion. The public maps and artwork CDN remains separate. Staging and production each run a daily retention cron that purges their own interaction logs older than 90 days; previews have no cron. There is no automatic retry service. Failed feedback email and incomplete account deletion remain available for explicit recovery.

The Neon project is small-cloud-35890217. Its production database is the root `main` branch `br-shy-hat-akg1paip`. The staging branch `br-odd-paper-aktgtidp` is a separate child of main. Both use database `parkdex_kip` and role `parkdex_kip_owner`. Preview databases branch from staging. Isolated PR branches use Neon parent-schema initialization and expire after 72 hours. Each receives a new branch-scoped role and a fresh database. The harness verifies no application tables exist, applies its ordered migration allowlist, and checks every application table is empty. Feedback precedes accounts, progress, and interactions. The account migration group and private photo service ship together; a tooling bootstrap may omit the whole group. Personal data and persistent role credentials are never copied into the preview application.

## One-time release setup

Disable Vercel Git deployments for the parkdex-kip project. The repository push workflows own staging and production deployment requests; no pull request or feature branch event creates a provider deployment. Keep Vercel project Preview variables empty. Preview and staging runtime values are sent with each exact deployment and are not saved as project Preview variables.

Configure the GitHub staging environment with:

- Secret VERCEL_TOKEN_STAGING, scoped to the Parkdex Vercel team and project.
- Secret KIP_STAGING_RUNTIME_JSON, containing exactly the staging runtime values DATABASE_URL, RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, OPERATOR_EMAIL, OPERATOR_PASSWORD_HASH, and SESSION_SECRET. An optional MIGRATION_DATABASE_URL can supply a direct Neon connection for psql; otherwise DATABASE_URL is used for the bounded migration step.
- Secret NEON_API_KEY_STAGING, scoped to read the staging branch endpoint inventory. The workflow checks DATABASE_URL and optional MIGRATION_DATABASE_URL against the staging child before migration or service dispatch.
- Variables VERCEL_ORG_ID and VERCEL_STAGING_PROJECT_ID.

For account releases, add runtime keys AUTH_SESSION_SECRET, KIP_PHOTO_SERVICE_URL, KIP_PHOTO_SERVICE_TOKEN, KIP_RETENTION_SECRET, and GOOGLE_WEB_CLIENT_ID. AUTH_EMAIL_FROM may override EMAIL_FROM for account messages. Operator, account, photo service, and retention secrets must be distinct. The Google value is the Web OAuth client audience shared with Android Credential Manager, with each Android package and signing certificate registered separately. Account releases fail closed when staging Google or email configuration is absent.

Add the environment secret CLOUDFLARE_KIP_STAGING_TOKEN for the deployment process only. It needs access to the configured Cloudflare account's Workers, R2 and Durable Object management APIs. It must never enter the Vercel or Worker application environment. Install the pinned Wrangler CLI 4.132.0. Provision the persistent private photo bucket and Worker explicitly from the trusted staging harness using `python scripts/kip-delivery.py provision-staging-photos` and then `--apply`; normal release dispatch must not silently create replacement persistent resources.

Configure the GitHub `production` environment separately. Set `VERCEL_ORG_ID` to the Parkdex team and `VERCEL_PRODUCTION_PROJECT_ID` to the `parkdex-kip` Vercel project ID. It may equal `VERCEL_STAGING_PROJECT_ID` when both targets use this project. Add separate secrets `VERCEL_TOKEN_PRODUCTION`, `KIP_PRODUCTION_RUNTIME_JSON`, `CLOUDFLARE_KIP_PRODUCTION_TOKEN`, and `NEON_API_KEY_PRODUCTION`. `KIP_PRODUCTION_RUNTIME_JSON` is the raw JSON bundle value. Its `DATABASE_URL` and optional `MIGRATION_DATABASE_URL` must connect to `parkdex_kip` on Neon production branch `main` (`br-shy-hat-akg1paip`); the workflow confirms both hosts against the Neon main branch API before migrations or dispatch. Account deployments also require their own `AUTH_SESSION_SECRET`, `KIP_PHOTO_SERVICE_URL`, `KIP_PHOTO_SERVICE_TOKEN`, `KIP_RETENTION_SECRET`, and `GOOGLE_WEB_CLIENT_ID`; all production secrets must be distinct from staging. The Vercel, Cloudflare, and Neon tokens must be scoped to the production project or configured provider account, and never enter an application or Worker runtime.

Before the first production release, explicitly provision the isolated production private-photo Worker and bucket from a clean trusted checkout at the current `origin/staging` SHA. The default command prints a plan; inspect it, then apply it:

```powershell
python scripts/kip-delivery.py provision-production-photos
python scripts/kip-delivery.py provision-production-photos --apply
```

This creates `parkdex-kip-photos-production` Worker and R2 bucket with a production retention endpoint. Initial provisioning does not enable the cron. After provisioning, add its reported HTTPS Worker URL to `KIP_PRODUCTION_RUNTIME_JSON` as `KIP_PHOTO_SERVICE_URL`. The production release workflow checks the pinned main content pointer before applying migrations, then queues Vercel and the already-owned photo Worker concurrently for the exact main SHA. It applies schema migrations but never replays the historical public content bootstrap against Neon main; that branch carries the curated Victoria 100 catalogue. The Worker gets its retention cron when the production code and migration are dispatched together.

Before the first account merge, staging does not yet contain the Worker source. After completing the affected browser journeys on the isolated preview, run `python scripts/kip-delivery.py attest-preview-browser --pr 123 --deployment-id dpl_<exact-preview-id>` from the clean trusted staging harness. This checks the current PR head, staging base, exact synthetic merge tree, live Worker, READY Vercel deployment, and release endpoint before recording the head SHA, candidate SHA, deployment ID, and timestamp in the locked external journal. It records the operator's browser attestation; the operator must still inspect the actual journeys. Then run `python scripts/kip-delivery.py provision-staging-photos --from-preview-pr 123` and repeat with `--apply`. The provisioning helper rechecks the attested identities and extracts only the standalone Worker from the verified Git object. It records the source preview identity in the persistent setup journal. Do not accept an arbitrary local Worker file or provision from an unverified feature checkout.

The runtime JSON is read only by the delivery helper. It is written to a short lived file outside the checkout when Vercel CLI needs local configuration, then removed. After migrations, the workflow queues Vercel and the private photo Worker concurrently for the exact staging SHA. It exits after dispatch acceptance, without polling readiness or assigning the stable alias. The private Worker receives only its photo service token, retention endpoint, and retention secret.

The first tooling-only PR is the bootstrap. Merge and verify its static staging release before running this workflow for feature PRs. The helper can build a static candidate that has no API or feedback migration so that bootstrap does not depend on the later API implementation.

Staging now assigns `staging.web.parkdex.app` only after the exact release is READY and verified. It also keeps the former `parkdex-kip-staging.vercel.app` alias on that same deployment for already-installed Android builds. Verify both aliases with `python scripts/kip-delivery.py verify-staging --sha <40-character-merge-sha>` before considering staging cut over. Keep the legacy alias assigned while supported Android installs still use it.

Content sync is optional until its complete allowlist is present in `deployment.json`: the content migration, snapshot/changes/scene API routes, public bootstrap helper, rollback-only SQL QA, Python test modules, and pinned delivery test dependencies. The ordered feature schema applies `database/001_cloud_content.sql` before account migrations and `content_001_sync.sql` after them. A preview proves the migrated database is empty, allowing only the exact initial content clock row, before the public bootstrap runs. The helper verifies the pinned CDN release manifest, public JSON, active scene images, and generated map-only manifest. It inserts only public catalogue rows missing from the database in one transaction and records its manifest receipt last. Staging uses the same insert-only transaction after migrations; a matching receipt makes later runs no-op, while a mismatched receipt or existing baseline row fails without overwriting it. Production preserves the authored Victoria 100 Neon catalogue and does not replay the historical 122-park bootstrap. No private or user data is copied. Content SQL QA uses a unique disposable loopback database for each run and drops that exact database afterward.

Vercel can classify a new project's first deployment as Production even when Preview was requested. Keep the bootstrap static and verify the returned target before assigning any staging alias. If this occurs, create a second static deployment of the same SHA, verify that its target is Preview, and remove the exact unintended initial deployment. Never send feedback runtime credentials to an unverified first deployment.

## Isolated draft PR preview

Run the scripts from a clean trusted checkout exactly at the current origin/staging SHA. Authenticate GitHub CLI for read-only PR metadata. Set process environment values NEON_API_KEY, NEON_PROJECT_ID, VERCEL_TOKEN, VERCEL_ORG_ID, and VERCEL_PREVIEW_PROJECT_ID; the preview project ID must equal the staging Vercel project ID. Install Vercel CLI 50.1.3 and PostgreSQL client psql.

The default command prints a local-only plan and performs no provider reads or writes:

```powershell
pwsh -File scripts/preview-pr.ps1 -PullRequest 123
```

Add -Apply to validate and deploy. Apply requires an open same-repository draft PR targeting staging, a clean harness at the exact current staging SHA, and a full 40-character PR head SHA. It builds a synthetic merge commit in a temporary worktree and runs npm ci, typecheck, application and delivery tests, and the production build with provider credentials removed. The `safe_env` filter limits inherited environment variables, but it is not a filesystem sandbox: candidate build scripts still run as the local OS user and can read files that user can read. Run a candidate from an external or otherwise untrusted contributor under an isolated user or container with no release credential access. Account candidates also run the real PostgreSQL suites and a credential-free Wrangler bundle validation before creating resources. Supply PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD for a disposable local PostgreSQL 18 database. Both the harness and SQL adapter reject remote hosts or database names outside `kip_qa_*` (the existing task database `kip_accounts_qa` is also allowed). The staging workflow uses an ephemeral PostgreSQL service for these checks. Neon and the unique per-release photo service provision independently, then Vercel receives their isolated runtime endpoints. Preview email and Google sign-in remain disabled; persistent integration credentials never enter the preview.

```powershell
pwsh -File scripts/preview-pr.ps1 -PullRequest 123 -Apply
```

The durable journal and per-PR lock are stored outside the repository under %LOCALAPPDATA%\Parkdex\kip-preview-pr. The journal contains exact provider IDs, release identity, owner, validation results, and cleanup observations, but no credentials or database URLs. Concurrent photo provisioning writes an identity-bound sidecar, merged into the main journal when it finishes or during recovery. Generated operator, auth, photo, and retention credentials stay in a separate restricted per-PR credential file. Keep the preview available through merge and staging verification.

Before completing review, confirm /release.json reports the PR head SHA and preview; when the API exists, confirm /api/health returns HTTP 200 and {"ok":true}. Use the exact preview URL for the browser journey and inspect the feedback submit and operator review flows. Report email delivery as disabled in previews.

## Staging release and teardown

Merging to staging starts .github/workflows/deploy-staging.yml. The workflow validates the full pushed SHA, runs local checks, applies each additive migration atomically with psql, then dispatches all required services concurrently. It does not assign an alias or wait for provider readiness.

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

Teardown verifies both staging API and private Worker serve the merged SHA before retiring an account preview. It verifies provenance for the exact Vercel deployment, Neon branch, Worker, private bucket, and Durable Object namespace. It attempts independent provider deletions even if one fails, purges only the exact owned bucket, and verifies namespace removal. Three consecutive complete-inventory all-absent observations are required before recording cleanup complete. If an operation fails, keep the journal and rerun the same teardown command after diagnosis. Never infer ownership from a PR number or a loose resource name.

## Production release

Production is a separate merge from `staging` to `main`. The main push workflow validates the exact full SHA and the public `main` content pointer before applying Neon migrations or dispatching services. Publish the immutable content release through `docs/cloud-content.md` first; the production host serves `web.parkdex.app` and reads the `main` channel. A missing pointer or manifest hash mismatch stops the workflow before migrations.

After the workflow succeeds, inspect the Vercel Production deployment and confirm its commit SHA and `release.json` match the main merge SHA. Confirm `/api/health`, the main content channel, and the private photo Worker all report that SHA. Then assign the stable host and verify it:

```powershell
python scripts/kip-delivery.py assign-main --deployment-id dpl_... --sha <40-character-merge-sha>
python scripts/kip-delivery.py assign-main --deployment-id dpl_... --sha <40-character-merge-sha> --apply
python scripts/kip-delivery.py verify-main --sha <40-character-merge-sha>
```

Alias assignment is plan-only by default and rejects deployments without READY status, Production target, exact project ID, release SHA, and `kipEnvironment=production`. Do not report production ready until the stable web host and the requested browser journeys have been verified against that exact SHA.
