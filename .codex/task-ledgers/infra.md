# Every Park infrastructure

## Goal and success condition

Bootstrap the authorized GitHub, Neon, Railway, and Vercel projects; deploy the integrated app from GitHub Actions; verify production `/ready`, a non-empty place catalogue, a scoped visit write/read/cleanup, and one worker database heartbeat; then validate and clean up the one-time PR preview lifecycle.

## Completed

- Required dry run resolved `NathanPannell/every-park`, Neon/Railway/Vercel project name `every-park`, Neon region `aws-us-west-2`, and local checkout `C:\repo\every-park`.
- Imported the maintained template into the pre-existing empty GitHub repository, customized it as Every Park, and pushed commit `c3639f4`.
- Added the empty runtime-secret declaration required by bootstrap and pushed commit `28f2298`.
- Created/resolved Neon project `damp-hat-81652631`, production branch `main`.
- Created/resolved Railway project `0999e6e0-d2ae-4b48-b516-55d53dba7cb5`, production environment `7670d90a-6422-4ed6-816d-7ef243f00ec2`, API service `b30d9ca5-fc77-4427-a955-b020a7ec3cf8`, and worker service `99c62f81-d2bb-40db-911d-d8a4a1d05d8f`.
- Created/linked the Vercel `every-park` project and installed provider secrets plus non-secret resource variables in GitHub. `BOOTSTRAP_COMPLETE=true`, `PREVIEWS_ENABLED=true`, and trusted preview actor are set.
- Dispatched scaffold CI run `34157834920` for SHA `28f2298`.
- Scaffold CI backend tests and frontend lint/typecheck/build passed. Railway deployed both services at the exact SHA and assigned `api-production-e72df.up.railway.app` to the API.
- Cancelled the remaining scaffold deploy gate after `/ready` consistently returned HTTP 500: the old template indexed a mapping row as `migration_count[0]` and raised `KeyError`. The app implementation replaces that endpoint, so this is not a provider wiring failure and does not warrant committing into concurrent app work.
- Logged the Windows template-customizer path regression and recovery in the private improvement history. The maintained local template already has the file-list based correction.
- Documented the app-specific production and preview contract in the README: exact-commit readiness, pooled/direct database boundaries, exact CORS origins, isolated preview cleanup, and scoped catalogue visit smoke.
- Added deployment gates for a non-empty catalogue, scoped visit write/read, anonymous and second-key isolation, required undo plus cleanup read, and a positive worker catalogue-count log bound to the exact deployed commit in both production and preview workflows.
- Added CI gates for the frontend Vitest suite, source catalogue validation, and deterministic regeneration/diff of the SQL seed migration against the reviewed JSON catalogue.
- Removed unused Neon Auth domain registration from Every Park deployment workflows and architecture docs; the app uses anonymous local collection keys and does not provision Neon Auth.

## Decisions and assumptions

- The scaffold CI is provider proof only. Every Park v0 is ready only after the integrated app is committed, CI deploys that exact SHA, and the app-specific production checks pass.
- Bootstrap no longer enters its template-customization commit path, so provider reruns do not stage or push concurrent app work.
- Production runtime uses pooled Neon URLs; migrations use the direct URL. Railway CORS must use the actual Vercel deployment and production origins emitted by CI.
- App smoke uses a generated 43-character base64url collection token, writes the first place visited with `X-Collection-Key`, verifies it in `visitedIds`, and resets it to false. Tokens and database URLs are never recorded here.
- Maintained-template follow-up: change scaffold `/ready` aggregates to named SQL aliases accessed by name and cover the configured dictionary row factory in a readiness test. This is outside the Every Park app source scope.

## Active evidence and next actions

- After app integration reaches main, dispatch/monitor CI for the exact final SHA.
- Verify production `/ready`, non-empty `/api/places`, scoped visit round-trip and cleanup, and worker catalogue-count heartbeat.
- Once production passes, run the required one-time preview PR smoke, close the PR in all outcomes, verify Vercel/Railway/Neon preview cleanup, and only then set `PREVIEW_SMOKE_COMPLETE=true`.
- Local validation: Bash parsed all three deployment scripts and `git diff --check` passed. `actionlint` and `shellcheck` are not installed locally; GitHub CI remains the workflow/runtime validator.
