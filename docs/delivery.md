# Parkdex delivery

Parkdex is a Vite app with a Vercel Node.js API and dedicated Neon PostgreSQL environments. Kip is its mascot; internal provider and repository identifiers retain their existing names. Account releases also use private Cloudflare photo Workers, isolated private R2 buckets, and SQLite Durable Objects per account to serialize photo uploads against deletion. The public maps and artwork CDN remains separate. Staging and production each run a daily retention cron that purges their own interaction logs older than 90 days, and feedback reports archived on the operator board more than 90 days ago. There is no automatic retry service. Failed feedback email and incomplete account deletion remain available for explicit recovery.

The Neon project is small-cloud-35890217. Its production database is the root `main` branch `br-shy-hat-akg1paip`. The staging branch `br-odd-paper-aktgtidp` is a separate child of main. Both use database `parkdex_kip` and role `parkdex_kip_owner`. Migrations apply in the ordered allowlist in `deployment.json`: feedback precedes accounts, progress, and interactions. The account migration group and private photo service ship together; a tooling bootstrap may omit the whole group.

## How a change ships

There are no PR preview deployments. CI is the gate, and staging is the first hosted environment a change reaches.

1. Branch from the latest `origin/staging` and open a draft PR against `staging`.
2. `.github/workflows/pr-checks.yml` runs on every push to the PR, drafts included. Merge only when every job is green on the PR's head commit (see "PR checks" below).
3. Squash-merge into `staging`. `.github/workflows/deploy-staging.yml` reruns the release checks, applies migrations to the Neon staging branch and dispatches Vercel and the private photo Worker for the merge SHA.
4. Find the READY Vercel deployment for the merge SHA, then run `assign-staging` and `verify-staging` (see "Staging release" below). Check the affected journeys at `staging.web.parkdex.app`.
5. Production is a separate PR from `staging` to `main`, made only when production is requested.

## PR checks

Every job must pass on the PR's head commit. Nothing in PR CI talks to Neon, Vercel or Cloudflare.

| Job | What it runs |
| --- | --- |
| Release checks | `python scripts/kip-delivery.py ci-checks` against a Postgres 18 service container: `npm ci`, typecheck, tests with coverage floors, the production build, delivery tests, content sync SQL QA (every migration applied from scratch to a fresh `kip_qa_*` database, then the public content bootstrap), content Python tests, legacy import QA, the account SQL tests and the private photo Worker bundle. The staging and production deploys run the same command. |
| Format and lint | `npm run format:check` (Prettier), `npm run lint` (ESLint, zero warnings), `ruff format --check .` and `ruff check .` (Ruff from `scripts/requirements-lint.txt`). |
| E2E | Playwright, headless, against the production web build (`vite preview`) and the real API on a fresh Postgres 18 database (`e2e/api-server.ts`): onboarding, the map's nearby parks, search and a park page, My Dex, the leaderboard and settings, all signed out. The trace and report upload on failure. |
| Operator dashboard | Its typecheck, tests (six PostgreSQL suites on fresh databases) and build. |
| Android debug build | `npm run android:sync` and `gradlew assembleDebug`. It needs no signing secrets. |
| iOS changes, iOS simulator build | On `macos-26`, only when the PR touches `ios/` or the Capacitor and package config: `npm run ios:sync`, a check that the committed `ios/` project matches `cap sync`, and an unsigned `xcodebuild build` for the simulator. Otherwise the build job is skipped, which counts as passing. See `docs/ios.md`. |
| Security | `npm audit --audit-level=high` for the app and the dashboard, gitleaks over the whole history and the working tree (`.gitleaks.toml`), and a check that the only committed env files are the two Vite mode files with `VITE_` keys. |

Coverage floors are in `vitest.config.ts` (app) and the `test` script in `package.json` (API worker suite). Raise them as tests are added; never lower them. A worker test (`worker/idle.test.ts`) asserts that an idle API and its health check send no SQL.

Run the same commands locally before pushing. `ci-checks` needs the PostgreSQL setup described in AGENTS.md; `npm run e2e` needs `npm run build` first and the same `PG*` variables (without `PGDATABASE`), because it creates its own database.

## One-time release setup

Disable Vercel Git deployments for the `parkdex` Vercel project (`web.parkdex.app` and `staging.web.parkdex.app`). The repository push workflows own staging and production deployment requests; no pull request or feature branch event creates a provider deployment. Keep Vercel project Preview variables empty. Staging deploys use Vercel's Preview target, and their runtime values are sent with each exact deployment instead of being saved as project Preview variables.

Configure the GitHub staging environment with:

- Secret VERCEL_TOKEN_STAGING, scoped to the Parkdex Vercel team and project.
- Secret KIP_STAGING_RUNTIME_JSON, containing exactly the staging runtime values DATABASE_URL, RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, OPERATOR_EMAIL, OPERATOR_PASSWORD_HASH, and SESSION_SECRET. An optional MIGRATION_DATABASE_URL can supply a direct Neon connection for psql; otherwise DATABASE_URL is used for the bounded migration step.
- Optional secret KIP_STAGING_EXTRA_RUNTIME_JSON (and KIP_PRODUCTION_EXTRA_RUNTIME_JSON for production), a JSON object that adds optional runtime keys listed in `runtimeOptionalKeys`, such as OPENROUTER_API_KEY, OPENROUTER_MODERATION_MODEL, POSTHOG_PROJECT_KEY and POSTHOG_HOST. It may not repeat a key from the main bundle. Adding an optional key never requires rewriting the main bundle.
- Secret NEON_API_KEY_STAGING, scoped to read the staging branch endpoint inventory. The workflow checks DATABASE_URL and optional MIGRATION_DATABASE_URL against the staging child before migration or service dispatch.
- Variables VERCEL_ORG_ID and VERCEL_STAGING_PROJECT_ID.

For account releases, add runtime keys AUTH_SESSION_SECRET, KIP_PHOTO_SERVICE_URL, KIP_PHOTO_SERVICE_TOKEN, KIP_RETENTION_SECRET, and GOOGLE_WEB_CLIENT_ID. AUTH_EMAIL_FROM may override EMAIL_FROM for account messages. Operator, account, photo service, and retention secrets must be distinct. The Google value is the Web OAuth client audience shared with Android Credential Manager, with each Android package and signing certificate registered separately. Optional GOOGLE_NATIVE_CLIENT_ID names a second web client that the server hands to the Android app instead, and whose ID tokens it also accepts. Google allows each package and signing fingerprint pair in only one Cloud project, and app.parkdex's Play signing fingerprints belong to the staging project, so production sets it to the staging project's web client. It must be a Google OAuth client ID and usually goes in the extra runtime bundle. Account releases fail closed when staging Google or email configuration is absent.

Add the environment secret CLOUDFLARE_KIP_STAGING_TOKEN for the deployment process only. It needs access to the configured Cloudflare account's Workers, R2 and Durable Object management APIs. It must never enter the Vercel or Worker application environment. Install the pinned Wrangler CLI 4.132.0. Provision the persistent private photo bucket and Worker explicitly from the trusted staging harness using `python scripts/kip-delivery.py provision-staging-photos` and then `--apply`; normal release dispatch must not silently create replacement persistent resources.

Configure the GitHub `production` environment separately. Set `VERCEL_ORG_ID` to the Parkdex team and `VERCEL_PRODUCTION_PROJECT_ID` to the `parkdex-kip` Vercel project ID. It may equal `VERCEL_STAGING_PROJECT_ID` when both targets use this project. Add separate secrets `VERCEL_TOKEN_PRODUCTION`, `KIP_PRODUCTION_RUNTIME_JSON`, `CLOUDFLARE_KIP_PRODUCTION_TOKEN`, and `NEON_API_KEY_PRODUCTION`. `KIP_PRODUCTION_RUNTIME_JSON` is the raw JSON bundle value. Its `DATABASE_URL` and optional `MIGRATION_DATABASE_URL` must connect to `parkdex_kip` on Neon production branch `main` (`br-shy-hat-akg1paip`); the workflow confirms both hosts against the Neon main branch API before migrations or dispatch. Account deployments also require their own `AUTH_SESSION_SECRET`, `KIP_PHOTO_SERVICE_URL`, `KIP_PHOTO_SERVICE_TOKEN`, `KIP_RETENTION_SECRET`, and `GOOGLE_WEB_CLIENT_ID`; all production secrets must be distinct from staging. The Vercel, Cloudflare, and Neon tokens must be scoped to the production project or configured provider account, and never enter an application or Worker runtime.

Before the first production release, explicitly provision the isolated production private-photo Worker and bucket from a clean trusted checkout at the current `origin/staging` SHA. The default command prints a plan; inspect it, then apply it:

```powershell
python scripts/kip-delivery.py provision-production-photos
python scripts/kip-delivery.py provision-production-photos --apply
```

This creates `parkdex-kip-photos-production` Worker and R2 bucket with a production retention endpoint. Initial provisioning does not enable the cron. After provisioning, add its reported HTTPS Worker URL to `KIP_PRODUCTION_RUNTIME_JSON` as `KIP_PHOTO_SERVICE_URL`. The production release workflow checks the pinned main content pointer before applying migrations, then queues Vercel and the already-owned photo Worker concurrently for the exact main SHA. It applies schema migrations but never replays the historical public content bootstrap against Neon main; that branch carries the curated Victoria 100 catalogue. The Worker gets its retention cron when the production code and migration are dispatched together.

The staging photo Worker and bucket already exist. If they ever need provisioning again, run `python scripts/kip-delivery.py provision-staging-photos` from a clean trusted checkout at the current `origin/staging` SHA, read the plan, then repeat with `--apply`. Do not provision from a feature checkout or an arbitrary local Worker file.

The runtime JSON is read only by the delivery helper. It is written to a short lived file outside the checkout when Vercel CLI needs local configuration, then removed. After migrations, the workflow queues Vercel and the private photo Worker concurrently for the exact staging SHA. It exits after dispatch acceptance, without polling readiness or assigning the stable alias. The private Worker receives only its photo service token, retention endpoint, and retention secret.

The first tooling-only PR is the bootstrap. Merge and verify its static staging release before running this workflow for feature PRs. The helper can build a static candidate that has no API or feedback migration so that bootstrap does not depend on the later API implementation.

Staging now assigns `staging.web.parkdex.app` only after the exact release is READY and verified. It also keeps the former `parkdex-kip-staging.vercel.app` alias on that same deployment for already-installed Android builds. Verify both aliases with `python scripts/kip-delivery.py verify-staging --sha <40-character-merge-sha>` before considering staging cut over. Keep the legacy alias assigned while supported Android installs still use it.

Content sync is optional until its complete allowlist is present in `deployment.json`: the content migration, snapshot/changes/scene API routes, public bootstrap helper, rollback-only SQL QA, Python test modules, and pinned delivery test dependencies. The ordered feature schema applies `database/001_cloud_content.sql` before account migrations and `content_001_sync.sql` after them. The content SQL QA applies every migration to a fresh database before the public bootstrap runs. The helper verifies the pinned CDN release manifest, public JSON, active scene images, and generated map-only manifest. It inserts only public catalogue rows missing from the database in one transaction and records its manifest receipt last. Staging uses the same insert-only transaction after migrations; a matching receipt makes later runs no-op, while a mismatched receipt or existing baseline row fails without overwriting it. Production preserves the authored Victoria 100 Neon catalogue and does not replay the historical 122-park bootstrap. No private or user data is copied. Content SQL QA uses a unique disposable loopback database for each run and drops that exact database afterward.

Vercel can classify a new project's first deployment as Production even when Preview was requested. Keep the bootstrap static and verify the returned target before assigning any staging alias. If this occurs, create a second static deployment of the same SHA, verify that its target is Preview, and remove the exact unintended initial deployment. Never send feedback runtime credentials to an unverified first deployment.

## Staging release

Run `python scripts/kip-delivery.py ci-checks` locally before every push; it is the same check list as the release checks job and both push workflows.

Merging to staging starts .github/workflows/deploy-staging.yml. The workflow validates the full pushed SHA, runs the same release checks, applies each additive migration atomically with psql, then dispatches all required services concurrently. It does not assign an alias or wait for provider readiness.

After the workflow succeeds, find the READY Vercel deployment whose `githubCommitSha` is the merge SHA and whose `kipEnvironment` is `staging`. Then assign the stable staging aliases only to that deployment and verify them:

```powershell
python scripts/kip-delivery.py assign-staging --deployment-id dpl_... --sha <40-character-merge-sha>
python scripts/kip-delivery.py assign-staging --deployment-id dpl_... --sha <40-character-merge-sha> --apply
python scripts/kip-delivery.py verify-staging --sha <40-character-merge-sha>
```

The alias command is plan-only by default and rejects a deployment that is not READY or whose project, SHA or environment differ. `verify-staging` checks `/release.json`, `/api/health` and the private photo Worker on both staging hosts. It and `verify-main` recheck the stable host for up to 90 seconds, because a freshly assigned alias can briefly serve the previous release, and report the mismatch if it never catches up. Report "ready in staging" only after the affected journeys pass at `staging.web.parkdex.app`.

## Production release

Production is a separate merge from `staging` to `main`. The main push workflow validates the exact full SHA and the public `main` content pointer before applying Neon migrations or dispatching services. Publish the immutable content release through `docs/cloud-content.md` first; the production host serves `web.parkdex.app` and reads the `main` channel. A missing pointer or manifest hash mismatch stops the workflow before migrations.

After the workflow succeeds, inspect the Vercel Production deployment and confirm its commit SHA and `release.json` match the main merge SHA. Confirm `/api/health`, the main content channel, and the private photo Worker all report that SHA. Then assign the stable host and verify it:

```powershell
python scripts/kip-delivery.py assign-main --deployment-id dpl_... --sha <40-character-merge-sha>
python scripts/kip-delivery.py assign-main --deployment-id dpl_... --sha <40-character-merge-sha> --apply
python scripts/kip-delivery.py verify-main --sha <40-character-merge-sha>
```

Alias assignment is plan-only by default and rejects deployments without READY status, Production target, exact project ID, release SHA, and `kipEnvironment=production`. Do not report production ready until the stable web host and the requested browser journeys have been verified against that exact SHA.
