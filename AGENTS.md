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
| `worker/` | API logic: feedback, accounts (`worker/accounts/`), progress sync, interactions, app config, park proposals, the flag game (`game.ts`) and shared moderation (`moderation.ts`). Tests sit beside each module. |
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
npm test                    # vitest, node:test and worker tests
npm run build
npm run android:apk         # debug APK (app.parkdex.debug)
npm run android:aab:production
npm run local:api           # real API on 127.0.0.1:8787 against loopback PostgreSQL; see docs/local-stack.md
node scripts/publish-app-bundle.mjs --channel staging --min-native-build <n>   # over-the-air web bundle, dry run (docs/ota-updates.md)
```

For signed-in QA without a hosted environment, run `npm run local:api` and then `KIP_LOCAL_API=http://127.0.0.1:8787 npm run dev`. Test accounts come from `scripts/local-stack.seed.json`.

### Release checks (run before every push)

`python scripts/kip-delivery.py ci-checks` runs the exact checks that the PR check, the staging deploy, the production deploy and the preview harness run:

- install, typecheck, tests and build
- delivery tests
- content sync SQL QA and content Python tests
- legacy import tests
- account SQL tests
- private photo Worker bundle

It needs a disposable loopback PostgreSQL 18 database whose name starts with `kip_qa_`. Set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`, and put `psql` on `PATH`. Start a throwaway `initdb` cluster on a free port under `.codex/tmp/` and delete it when you finish.

Run the full command before every push. If any part cannot run locally, say exactly which part and why in the PR. Never report it as passed.

## Branches and pull requests

- `staging` is the integration branch. Branch from `origin/staging` as `feat/`, `fix/` or `chore/<short-name>` and target `staging`.
- `main` is production. It changes only through a PR from `staging` to `main`, and only when production is requested.
- One issue per PR. Each agent works in its own worktree under the workspace `.codex/worktrees/`. Do not switch branches in a shared checkout.
- Open PRs as drafts and push freely while they are drafts. Mark ready only after the release checks pass locally and the preview has been verified.
- **Merge rule:** do not merge until `PR checks` is green on the current head. The repository is on the GitHub free plan, so GitHub cannot enforce this. Every agent must follow it.
- Merge one PR at a time. After a merge, any other ready PR rebases or merges `staging` and reruns its checks.
- Keep before-and-after cropped screenshots for UI changes in the PR thread.

## CI and GitHub Actions minutes

Private repositories on the free plan have about 2,000 Actions minutes a month. Keep paid runs to these:

| Workflow | Trigger | Approx. minutes |
| --- | --- | --- |
| `pr-checks.yml` | PR ready for review, and later pushes while ready. Drafts and docs-only changes are skipped, and a newer push cancels the older run. | 4 |
| `deploy-staging.yml` | Push to `staging`. Runs checks and migrations, then queues Vercel and the photo Worker. | 4 |
| `deploy-production.yml` | Push to `main`. Same as staging, against Neon `main`. | 4 |

Do not add workflows that poll providers, wait for deployments or run browsers. Agents do that locally. Do not re-run workflows to retry flaky provider steps; diagnose first.

## Delivery

Full steps are in `docs/delivery.md`. In short:

1. **Preview.** For a draft PR, run `scripts/preview-pr.ps1 -PullRequest <n> -Apply` from a clean trusted checkout at the current `origin/staging` SHA. It builds the synthetic merge commit and runs the release checks. It creates an isolated Neon branch, a Vercel preview and a photo Worker, with no personal data. Verify the affected journeys at the preview URL.
2. **Staging.** Mark the PR ready, wait for green `PR checks`, then merge. `deploy-staging.yml` dispatches without waiting. Find the READY deployment for the merge SHA, then run `assign-staging --apply` and `verify-staging`. Report "ready in staging" only after the affected journeys pass at `staging.web.parkdex.app`.
3. **Teardown.** With `STAGING_VERIFIED=1`, run `scripts/teardown-preview-pr.ps1 -PullRequest <n> -Apply`. Confirm every owned preview resource is absent before you reply.
4. **Production.** Open a PR from `staging` to `main`. After the merge, run `assign-main --apply` and `verify-main`, then verify the journeys at `web.parkdex.app`.

| Surface | Production | Staging |
| --- | --- | --- |
| Web app and API | `web.parkdex.app` | `staging.web.parkdex.app` (also `parkdex-kip-staging.vercel.app` for older Android builds) |
| Neon branch | `main` | `staging` |
| Content channel | `channels/main/current.json` | `channels/staging/current.json` |

Signed-in journeys on preview, staging and production hosts need the operator. Do not create accounts or enter passwords there.

## Hard rules

- Migrations are additive. Never edit a migration that has shipped; add a new file and list it in `deployment.json`.
- The content API is additive. Installed builds must keep working; see `docs/content-compatibility.md`.
- Never print, log or commit credentials, database URLs or tokens. Delivery credentials load through the operator's local loader only.
- Never copy personal data into a preview.
- Do not rename `kip` identifiers as part of a copy change.
- API stores query through `database()` from `worker/db.ts`, never `neon()` directly, so every read and write is recorded. Game events go through `emitEvent()`. See `docs/analytics.md`.
- Put task scratch files under the workspace `.codex/` and remove them when you finish.

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
