# AGENTS.md

Operating guide for coding agents in this repository. Keep it about how the repo works. Lessons from past incidents go in `docs/learnings/`, one file each, and are indexed at the end of this file.

The app is **Parkdex**. **Kip** is its mascot. Use Parkdex in customer-facing copy. Identifiers that contain `kip` (repository, schemas, APIs, providers) stay as they are.

## What this is

A Capacitor 8 Android app (React 19, Vite, TypeScript) for collecting parks on Vancouver Island, plus its API and content pipeline.

- The app runs offline first. Claims and photos are saved on the device and backed up to an account when signed in.
- The API is Vercel Node functions backed by Neon PostgreSQL.
- Private photos go through a Cloudflare Worker, an R2 bucket and one Durable Object per account.
- Public content (park catalogue, badge art, map tiles) is published as immutable releases to R2 behind `kip-assets.parkdex.app`.

## Layout

| Path | What it holds |
| --- | --- |
| `src/` | The app. `screens/` are full screens, `components/` shared UI, `lib/` logic with colocated `*.test.ts`, `data/` bundled data. |
| `api/` | Vercel function entrypoints. `feedback-api.ts` routes into `worker/`; `api/content/*` serves the content sync API. |
| `worker/` | API logic: feedback, accounts (`worker/accounts/`), progress sync, interactions, app config, park founding (`founders.ts`, `docs/park-founders.md`), the flag game (`game.ts`) and shared moderation (`moderation.ts`). Tests sit beside each module. |
| `database/` | `001_cloud_content.sql`, ordered migrations in `migrations/`, catalogue, imports and seeds. |
| `cloudflare/` | Private photo Worker and public asset config. |
| `operator/` | The operator dashboard, a separate Vite app with its own `package.json`. |
| `scripts/` | Delivery, content publishing, imports, map and art tooling, plus their Python and Node tests. `kip-delivery.py` is the release harness. |
| `android/` | Capacitor Android project, including custom native sign-in (`NativeIdentityPlugin.java`). |
| `art-source/`, `public/` | Source art and the files the app ships. |
| `deployment.json` | Release configuration: Neon branches, Vercel projects, migration allowlists, content sync and private photo settings. |
| `docs/` | Feature contracts and runbooks. `docs/delivery.md` is the full delivery runbook. |

## Commands

```bash
npm install                 # first time
npm run dev                 # browser build at http://localhost:5190, with demo tools
npm run typecheck
npm test                    # vitest, node:test and worker tests, with coverage floors
npm run format              # Prettier; `npm run format:check` and `npm run lint` (ESLint) as in CI
npm run build
npm run e2e                 # Playwright against the built app and a local API; build first
npm run android:apk         # debug APK (app.parkdex.debug)
npm run android:aab:production
npm run local:api           # real API on 127.0.0.1:8787 against loopback PostgreSQL; see docs/local-stack.md
node scripts/publish-app-bundle.mjs --channel staging --min-native-build <n>   # over-the-air web bundle, dry run (docs/ota-updates.md)
```

For signed-in QA without a hosted environment, run `npm run local:api` and then `KIP_LOCAL_API=http://127.0.0.1:8787 npm run dev`. Test accounts come from `scripts/local-stack.seed.json`.

### Checks (run before every push)

`python scripts/kip-delivery.py ci-checks` runs the release checks that the PR checks, the staging deploy and the production deploy all run:

- install, typecheck, tests and build
- delivery tests
- content sync SQL QA and content Python tests
- legacy import tests
- account SQL tests
- private photo Worker bundle

It needs a disposable loopback PostgreSQL 18 database whose name starts with `kip_qa_`. Set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`, and put `psql` on `PATH`. Start a throwaway `initdb` cluster on a free port under the workspace `.claude/tmp/<task>/` and delete it when you finish.

The PR checks also run `npm run format:check`, `npm run lint`, `ruff format --check .` and `ruff check .` (`pip install -r scripts/requirements-lint.txt`), `npm run e2e` after `npm run build` (same `PG*` variables; it creates its own database), the operator dashboard's typecheck, tests and build, the Android debug build, `npm audit --audit-level=high` and gitleaks. `docs/delivery.md` lists each job.

Run them before every push. If any part cannot run locally, say exactly which part and why in the PR. Never report it as passed.

## Branches and pull requests

- `staging` is the integration branch. Branch from `origin/staging` as `feat/`, `fix/`, `chore/` or `ci/<short-name>` and target `staging`.
- `main` is production. It changes only through a PR from `staging` to `main`, and only when production is requested.
- One issue per PR. Each agent works in its own worktree under the workspace `.claude/worktrees/`. Do not switch branches in a shared checkout.
- Open PRs as drafts. `PR checks` runs on every push, drafts included. Mark ready once every job is green on the head commit and the diff has been reviewed.
- **Merge rule:** do not merge until every `PR checks` job is green on the current head commit. The repository is on the GitHub free plan, so GitHub cannot enforce this. Every agent must follow it. A run for an older commit does not count. Squash-merge.
- Merge one PR at a time. After a merge, any other ready PR rebases or merges `staging` and reruns its checks.
- Keep before-and-after cropped screenshots for UI changes in the PR thread.

## CI and GitHub Actions minutes

Private repositories on the free plan have about 2,000 Actions minutes a month. Keep paid runs to these:

| Workflow | Trigger | Approx. minutes |
| --- | --- | --- |
| `pr-checks.yml` | Every push to a PR into `staging` or `main`, drafts included (marking a PR ready does not rerun it). Six parallel jobs of 1 to 3 minutes; a newer push cancels the older run. | 13 per push |
| `deploy-staging.yml` | Push to `staging`. Runs checks and migrations, then queues Vercel and the photo Worker. | 4 |
| `deploy-production.yml` | Push to `main`. Same as staging, against Neon `main`. | 4 |

The PR checks are the most expensive run, so run them locally first and push when they pass rather than pushing to see. Do not add workflows that poll providers or wait for deployments; agents do that locally. Do not re-run workflows to retry a flaky step; diagnose and fix it.

## Delivery

Full steps are in `docs/delivery.md`. In short:

There are no PR preview deployments; CI is the gate.

1. **Draft PR.** Open a draft PR against `staging`. `PR checks` runs on every push.
2. **CI gate.** Fix every failing job; never weaken a check to get green. Review the diff, then mark the PR ready once every job is green on the head commit.
3. **Merge.** Squash-merge into `staging`. `deploy-staging.yml` runs the release checks, applies migrations and dispatches without waiting.
4. **Staging.** Find the READY Vercel deployment for the merge SHA, then run `assign-staging --apply` and `verify-staging`. Report "ready in staging" only after the affected journeys pass at `staging.web.parkdex.app`.
5. **Production.** Only when requested: open a PR from `staging` to `main`. After the merge, run `assign-main --apply` and `verify-main`, then verify the journeys at `web.parkdex.app`.

| Surface | Production | Staging |
| --- | --- | --- |
| Web app and API | `web.parkdex.app` | `staging.web.parkdex.app` (also `parkdex-kip-staging.vercel.app` for older Android builds) |
| Neon branch | `main` | `staging` |
| Content channel | `channels/main/current.json` | `channels/staging/current.json` |

Signed-in journeys on staging and production hosts need the operator. Do not create accounts or enter passwords there. For signed-in QA before merging, use the local stack (`docs/local-stack.md`).

## Hard rules

- Migrations are additive. Never edit a migration that has shipped; add a new file and list it in `deployment.json`.
- The content API is additive. Installed builds must keep working; see `docs/content-compatibility.md`.
- Never print, log or commit credentials, database URLs or tokens. Delivery credentials load through the operator's local loader only.
- Never copy personal data out of staging or production, into CI, a local database or a test fixture.
- Do not rename `kip` identifiers as part of a copy change.
- API stores query through `database()` from `worker/db.ts`, never `neon()` directly, so every read and write is recorded. Game events go through `emitEvent()`. See `docs/analytics.md`.
- Put task scratch files under the workspace `.claude/tmp/<task>/` and remove them when you finish.

## Learnings

Read the matching file before you change these areas. Format and how to add one: `docs/learnings/README.md`.

| Area | Learning |
| --- | --- |
| Claims, accounts, progress sync | `docs/learnings/signed-in-claim-verification.md` |
| Catalogue cutovers and new park fields | `docs/learnings/catalogue-cutover-validation.md` |
| Park boundary imports | `docs/learnings/park-boundary-import-completeness.md` |
| Catalogue size, imports and new parks | `docs/learnings/content-snapshot-size.md` |
| Browser sync and backup | `docs/learnings/browser-sync-connectivity.md` |
| Map downloads and packaging | `docs/learnings/map-first-launch.md` |
| Android orientation and launcher icons | `docs/learnings/android-orientation-and-icons.md` |
| Release status questions | `docs/learnings/release-status-needs-host-check.md` |
| Branded HTML email | `docs/learnings/gmail-rounded-header.md` |
| Image generation for art | `docs/learnings/imagegen-prompts-and-receipts.md` |
| Badge art retries | `docs/learnings/badge-retry-accounting.md` |
| Access surveys and product journeys | `docs/learnings/access-fieldwork-wording.md` |
| Status answers and planning | `docs/learnings/fetch-before-describing-state.md` |
| Deploy migrations | `docs/learnings/migration-replay-lock-conflicts.md` |
| PRs that add a migration | `docs/learnings/preview-new-migrations.md` |
| End-to-end tests and the web content origin | `docs/learnings/e2e-https-origin.md` |
| Release dispatch provider errors | `docs/learnings/production-dispatch-transient-get.md` |
| SQL QA scripts and their pools | `docs/learnings/sql-qa-pool-teardown.md` |
| Merging several PRs into staging | `docs/learnings/staging-merge-sequence.md` |
| Outbound calls from the operator dashboard | `docs/learnings/operator-edge-fetch.md` |
| Vercel project deleted or renamed | `docs/learnings/vercel-project-recovery.md` |
