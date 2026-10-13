# Local full stack

Signed-in QA without touching a hosted environment. `npm run local:api` runs the real API worker (`worker/index.ts`) on `http://127.0.0.1:8787` against a throwaway loopback PostgreSQL database, and the Vite dev server proxies `/api` to it.

Only use it with a loopback cluster you own. The script refuses any host other than `127.0.0.1`, `localhost` or `::1` and any database whose name does not start with `kip_qa_`.

## Start the API

Let the script create or reuse a throwaway cluster (first run runs `initdb`; later runs start it again):

```bash
npm run local:api -- --pgdata C:/repo/parkdex-workspace/.codex/tmp/<piece>/local-pg --pg-port 55510
```

Or point it at a cluster you already started, with `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE` (`kip_qa_*`) set.

On start it:

1. applies the feedback, account, progress and interaction migrations, `database/001_cloud_content.sql` (for `public.parks`) and every `independentMigrationPaths` migration, including `game_001_init.sql`
2. loads the staging catalogue's parks (the same IDs the dev app reads) into `public.parks`, or the bundled `src/data/parks.json` when staging is unreachable. `--catalogue <url>` points at another content snapshot
3. seeds the test-only accounts in `scripts/local-stack.seed.json` (`tester1@example.test` to `tester3@example.test`, all `@example.test`). The first two already have handles; `tester3` has none, for the handle setup screen. The shared test password is in that file.

Options: `--port` (default 8787), `--app-origin` (default `http://localhost:5190`), `--pgdata`, `--pg-port` (default 55510), and `--content`, which also installs the content sync migrations and seeds the catalogue parks with their boundaries and drive rows (badge scenes left out), so `POST /api/parks/found` can publish parks. Founding also needs OpenStreetMap outlines: load them with `scripts/osm_park_index.py plan` and `apply` against the local database (`docs/osm-park-index.md`). Use a fresh database with `--content`. `PG_BIN` overrides the PostgreSQL binaries folder (default `C:/Program Files/PostgreSQL/18/bin`). `OPENROUTER_API_KEY` and `OPENROUTER_MODERATION_MODEL` pass through when set; without a key, handles use the blocklist only.

Email is disabled, so register, verification and password reset emails are not sent. Sign in with the seeded accounts. Private photos are not available locally.

Stop the API with Ctrl+C. The script prints the `pg_ctl stop` command for a cluster it started. Delete the cluster folder when you finish.

## Point the web app at it

```bash
KIP_LOCAL_API=http://127.0.0.1:8787 npm run dev
```

Open `http://localhost:5190`. Keep the Vite dev server on port 5190: the staging content API only allows that local origin, so on another port no parks load. The dev server proxies `/api` to the local API with the page's Host header, so session and CSRF cookies stay same-origin. Development builds accept this loopback `http` origin for account requests (`isDevLoopbackHttp` in `src/lib/userDataDestination.ts`); production and field builds still require HTTPS. `KIP_LOCAL_API` must be a loopback `http` URL.

The native Android build does not use the local stack yet: its account API must be the staging or production origin.

## Check it with curl

Native (bearer) sign-in is easiest from a shell. Put the login JSON in a file so the password stays out of shell history:

```bash
curl -s -X POST http://127.0.0.1:8787/api/auth/login -H "content-type: application/json" -H "X-Kip-Auth-Transport: native" --data-binary @login.json
curl -s http://127.0.0.1:8787/api/game/me -H "authorization: Bearer <sessionToken>" -H "X-Kip-Account-ID: <account.id>"
curl -s -X POST http://127.0.0.1:8787/api/game/visits -H "content-type: application/json" -H "authorization: Bearer <sessionToken>" -H "X-Kip-Account-ID: <account.id>" -d '{"visitId":"<uuid>","parkId":"national-pacific-rim-national-park-reserve"}'
curl -s http://127.0.0.1:8787/api/game/flags
curl -s http://127.0.0.1:8787/api/game/leaderboard
```

Login is rate limited to 5 attempts per email per 15 minutes, as in production.

## Flag game API

The routes follow the contract in issue #76. Additive fields beyond the contract: `GET /api/game/me` also returns `flagSeed` (available before a handle exists), `serverTime`, and `visitedToday`, the park IDs this account already visited on the current America/Vancouver day, with `visitedTodayUntil`, the instant that day ends (null before a handle exists). `POST /api/game/takeovers/seen` returns `{ takeoversSeenAt }`.

| Error | When |
| --- | --- |
| 400 `invalid_handle` | handle is not 3 to 20 of `a-z`, `0-9`, `_` after lowercasing and trimming a leading `@` |
| 422 `handle_rejected` | blocklist or moderation model rejected the handle |
| 409 `handle_taken` | another player has it |
| 409 `handle_required` | visit or takeovers seen before choosing a handle |
| 404 `park_not_found` | park ID is not in `public.parks` |
| 409 `visit_id_reused` | the visit ID was already used for a different park |
| 410 `account_deleting` | the account is being deleted |

Time rules are in `database/migrations/game_001_init.sql`. Visits use server time. Local days are America/Vancouver. A flag falls 720 hours after its holder's last visit.

Points (#169) are in `database/migrations/game_002_points.sql`: 1 per whole hour a flag flies, +6 for planting, +4 plus 1 per whole day the taken flag flew for a take, +1 for visiting your own flag, and +24 for founding. `GET /api/game/me` lists each held park with `days` (the flag's age, for weathering) and `hours` (the holding points so far), and visits carry `pointsBreakdown: { base, days }`, where `days` is a take's day bonus.

Crews (#170) are in `database/migrations/game_003_crews.sql`: each plant or take starts a 60-minute protected hour with a 6-character crew code. Outsiders' visits during it are `logged` (+1), friends join with `POST /api/game/crews/join` (+2, up to 8 people) and hold the park together. Contract in [crews.md](crews.md). To try it locally, plant with one seed account, read the code from `GET /api/game/parks/<park>/crew` and join with another.
