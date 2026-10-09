# Parkdex operator dashboard

A separate web app for running Parkdex. It reads and writes the same Neon tables as the main app (`kip_feedback`, `kip_app_config`, the content tables) through the shared modules in `../worker`.

It has no sign-in of its own. Vercel Authentication is the only access control.

## Access model

On the Hobby plan, Vercel Authentication (Standard Protection) covers every preview deployment URL and any custom domain aliased to a preview deployment. It does not cover production domains. So this app is deployed as preview only:

- Deploy with `vercel deploy --prebuilt` and never pass `--prod`.
- Point the stable URL at the latest preview deployment with `vercel alias set`.
- Set environment variables for the Preview target only.
- As a backstop, the API returns 403 for every request when `VERCEL_ENV` is `production`, so an accidental production deployment shows an empty shell and no data.

Writes also require the request's `Origin` to match the dashboard host.

## Sections

The sidebar has four sections. Each owns one folder in the UI and one in the API, so they can change independently.

| Section | Pages | UI | API |
| --- | --- | --- | --- |
| Feedback | `/feedback` (`/feedback/review?id=<report>` is the link in operator emails), `/feedback/archive` | `src/feedback/` | `server/feedback/`, `/api/feedback/*` |
| Parks | `/parks`, `/parks/<id>`, `/parks/osm/<type>-<id>` | `src/parks/` | `server/parks/`, `/api/parks/*` |
| Analytics | `/analytics/overview`, `/analytics/accounts`, `/analytics/events` | `src/analytics/` | `server/analytics/`, `/api/analytics/*` |
| App and updates | `/app/builds`, `/app/updates` | `src/app/` | `server/app/`, `/api/app/*` |

- **Feedback:** a board with New, Reviewing, Planned and Done columns (Done is the stored `closed` status). Drag a card to change its status (long-press on touch screens), with Undo. Click a card for the full report, app version and build, screenshot, follow-up and email delivery retry. Keyboard users open a card and set its status from the panel. **Clear done** archives every done report (with Undo); the Archive page searches them and restores them to Done. The daily retention run on staging and production (`/api/retention/interactions/purge`, called by the photo Worker's cron) deletes archived reports, their screenshots and email rows 90 days after archiving (`worker/feedbackArchive.ts`, migration `feedback_002_archive`). Feedback carries no account, so cards cannot show a handle yet.
- **Parks:** a map-first park manager over the catalogue of the toggled database.
  - The list searches name and id, filters by category, region, live or hidden, founder and source (curated, legacy import with a reader floor, `osm-*`, player proposal), sorts by name or visits, and counts every choice. Tiles at the top compare live, hidden and founded parks with the `kip_osm.parks` outlines and an estimate of those not in Parkdex (no `osm-*` park and no catalogue pin in the outline's box). Keys: `/` searches, arrows move, Enter opens.
  - The map shows pins coloured by category, outlines of the parks in view, hidden parks, founded parks (cover on hover) and OpenStreetMap outlines. Outlines load from the server for the view only (`/api/parks/outlines`, `/api/parks/osm`, from zoom 10 and 11.5); OpenStreetMap outlines are matched with `worker/catalogueMatch`, and "Only not in Parkdex" keeps the unmatched ones.
  - A park page edits every field and the outline (one guarded transaction, 409 `park_changed` when someone else saved first), shows visits (total, last 30 days, players), the flag holder, the founder and cover, and the park's `content_changes`.
  - Hide and unhide are one click (`content_park_hidden`, source `operator`, `docs/park-visibility.md`). Delete asks first, lists what goes with the park and recommends Hide; it deletes the park, its draft and (by cascade) its founder in one content revision, and leaves visits and tenures as history. Parks in the enrichment queue cannot be deleted.
  - "Remove founder and cover" deletes the founder row (and the founder bonus) so the park can be founded again; "Replace cover" stores a JPEG with its metadata removed.
  - Create from OSM prefills name, category guess, nearest region and outline for an outline that is not in Parkdex, and publishes it with `publishStatements` as founding does.
- **Analytics:** follows the database toggle.
  - *Overview:* headline numbers with period deltas (accounts, signed-in players per day, week and month, handles, parks founded, visits by outcome, photo approve rate, open feedback) and daily charts drawn with uPlot. Signed-in players are accounts with a server event in the window.
  - *Accounts:* a paged table that never shows emails; the detail panel masks the email and each reveal is recorded in `kip_account.security_events`. **Delete account** marks the account deleting and signs it out, then runs the app's own cleanup (`deleteAccountData`, then `completeDeletion` in `worker/accounts`), so private photos go through the photo service of the same environment. Deletions waiting on the photo service are listed with a Resume button.
  - *Optional schemas:* production can run a release behind staging. Analytics reads check for newer schemas first (`server/analytics/schema.ts`, today `kip_founders` from `founders_001`, cached per database for a minute). Without one, those tiles, charts and columns are null with an `unavailable` note such as "founders not deployed", and the page shows "Not in this database yet". `OPERATOR_DEMO_WITHOUT_FOUNDERS=1` shows that state in the local demo.
  - *Events:* server events from `kip_analytics.events` with filters, an hourly or daily histogram, expandable rows and a CSV export of up to 50,000 rows (db_read and db_write are hidden unless asked for), and app events from PostHog's query API through fixed HogQL templates plus a guarded SELECT-only box with a forced LIMIT. The PostHog key never reaches the browser; without it the tab shows the setup steps.
- **App and updates:** Build config edits rows in `kip_app_config.builds` (each build's server, feature flags, and minimum and latest builds), with a short glossary. Installed apps read it from production, so it always uses production and ignores the database toggle. The retired `rankProgression` and `parkProposals` flags are no longer offered for new rows; `worker/appConfig.ts` still lists them because installed builds may read them. Updates (also production only) shows each over-the-air channel's pointer and what installed builds do with it, the bundles in R2, the publish history (`kip_app_config.ota_publishes`, migration `app_config_003`) and a setup checklist. It can point a channel at a bundle already in R2, guarded by generation, ETag and native build checks with readback through R2 and the CDN (`server/app/ota.ts`, `docs/ota-updates.md`). New bundles still come from `scripts/publish-app-bundle.mjs --apply --record`.

Old links redirect: `/proposals*` to `/parks` and `/builds` to `/app/builds`. The Proposals queue, Import from map, Drafts pages and badge upload are retired. `server/drafts.ts` stays only for `publishStatements`, which park founding (`worker/founders-store.ts`, `worker/parkPublish.ts`) and `scripts/qa-founders-sql.mjs` import.

## Code layout

- `src/App.tsx` is the shell: sidebar, top bar with the environment badge, the staging banner and one page component per section. `src/routes.ts` holds the section and sub-route table and the redirects.
- `src/ui/` holds the shared primitives: `PageHeader`, `Card`, `Table`, `StatTile` and `StatGrid`, `EmptyState`, `Notice`, `Tabs`, `Drawer`, `useConfirm` (confirm dialog) and `useToast`. Section-only UI stays in the section folder, with its own CSS file.
- `src/shell/` holds the sidebar, the top bar, `SectionTabs`, `useDashboard()` (the current environment and `switchDatabase`) and the temporary `Placeholder` page.
- `server/api.ts` does only the shared work: the same-origin check, database selection, `/api/health` and the error shape, then hands the request to the section whose prefix matches. `server/http.ts` has the helpers every section uses (`json`, `allowMethods`, `databaseUrl`, `HttpError`).
- Each `server/<section>/routes.ts` exports `<section>Routes(request, context)`, which returns a response or `null` (a 404), plus the section's `Env` and `Dependencies` interfaces. `context.env` is the database the toggle chose (reading it is a 503 when staging is chosen but not configured), `context.baseEnv` is always production, and `context.otherEnv` is the database the operator is not looking at. In-memory stores for tests and the local demo live in `server/<section>/memory.ts` and are combined in `server/demo.ts`.

## Local development

```
npm ci
npm ci --prefix operator
npm run dev --prefix operator
```

The dev server loads the shared worker modules directly, so it also needs the root dependencies. The production build does not.

With no `DATABASE_URL`, the dev server serves fictional in-memory data at http://127.0.0.1:5191 and email sending is off. The Updates page then talks to a fake R2, CDN and update endpoint (`server/app/fakeCloud.ts`); start it with `OPERATOR_DEMO_OTA=empty` to see the state before the first publication. Set `DATABASE_URL` in the shell to point it at a real database. Use a Neon branch you own, not production.

```
npm run typecheck --prefix operator
npm test --prefix operator
```

Three integration tests run against the real content triggers when their variable points at a disposable loopback database named `kip_qa_*` (one database each). They apply the content and drafts migrations themselves.

- `server/drafts.pg.test.ts` (`OPERATOR_DRAFTS_TEST_DATABASE_URL`): the `publishStatements` transaction park founding uses.
- `server/parks/liveParks.pg.test.ts` (`OPERATOR_PARKS_TEST_DATABASE_URL`): live park edits.
- `server/parks/manager.pg.test.ts` (`OPERATOR_PARK_MANAGER_TEST_DATABASE_URL`): the park manager routes over every deploy migration, including hide and unhide, delete, create from OSM, founder moderation and the 409.
- `server/app/history.pg.test.ts` (`OPERATOR_OTA_TEST_DATABASE_URL`): the over-the-air publish history. It drops and recreates `kip_app_config` in its database.
- `server/analytics/analytics.pg.test.ts` (`OPERATOR_ANALYTICS_TEST_DATABASE_URL`): the analytics queries and operator account deletion, against every deploy migration. Use a fresh database for each run.
- `server/analytics/analytics.legacy.pg.test.ts` (`OPERATOR_ANALYTICS_LEGACY_TEST_DATABASE_URL`): the same pages on a database without `founders_001`, like production a release behind. Use a fresh database for each run.

The feedback archive and retention SQL run in the root SQL QA (`scripts/qa-feedback-archive-sql.mjs`, part of `npm run test:sql`).

## Build and deploy

`npm run build` writes a Vercel Build Output bundle to `operator/.vercel/output`: the static UI plus one Edge Function at `/api/*` that bundles the shared worker modules. The Vercel project therefore needs no access to the rest of the repository.

Runtime environment variables (Preview target only):

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Neon connection string for the data the dashboard should edit (sensitive) |
| `RESEND_API_KEY` | Needed only to retry failed feedback emails (sensitive) |
| `EMAIL_MODE` | `resend`, or `disabled` to turn retries into a no-op |
| `DASHBOARD_ENVIRONMENT` | Label shown in the top bar, for example `production` |
| `STAGING_DATABASE_URL` | Optional staging branch connection string (sensitive). When set, a sidebar toggle switches every section except Build config and Updates to staging; the choice is the `parkdex_operator_db` cookie |
| `CLOUDFLARE_API_TOKEN` | Optional. R2 read and write on the content bucket, for the Updates bundle list and pointer moves (sensitive) |
| `CLOUDFLARE_ACCOUNT_ID` | Optional. The Cloudflare account that owns the content bucket |
| `ASSETS_BUCKET` | Optional. The content bucket, default `parkdex-kip-content` |
| `KIP_PHOTO_SERVICE_URL`, `KIP_PHOTO_SERVICE_TOKEN` | Optional. The production photo service, the same values the app's API uses (token sensitive). Without them, Delete account is off for production |
| `STAGING_KIP_PHOTO_SERVICE_URL`, `STAGING_KIP_PHOTO_SERVICE_TOKEN` | Optional. The staging photo service, used while the toggle shows staging |
| `POSTHOG_PERSONAL_API_KEY` | Optional. A PostHog personal API key with the Query Read scope for the Parkdex project (sensitive). Without it, App events shows the setup steps |
| `POSTHOG_PROJECT_ID` | Optional. The numeric PostHog project ID |
| `POSTHOG_APP_HOST` | Optional. Defaults to `https://us.posthog.com` |

Deploy from the `operator` folder after linking it to the `parkdex-operator` Vercel project (`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, or `vercel link`):

```
npm run build --prefix operator
vercel deploy --prebuilt --cwd operator
vercel alias set <deployment-url> <stable-host>
```

The build writes `builds.json` with a preview target, because `vercel deploy --prebuilt` reads its target from there. Vercel still makes a project's first deployment its production deployment, so the `parkdex-operator` project's production deployment is a static "Nothing to see here" page with no API and no env vars. Leave it in place; replacing it with the dashboard would publish the UI shell on parkdex-operator.vercel.app.

The live setup: project `parkdex-operator`, stable host `operator.parkdex.app` (Vercel DNS) aliased to the latest preview, reading the production Neon branch.

Then set `OPERATOR_DASHBOARD_URL` to the stable host in the main app's runtime secret bundle, so operator emails link to the dashboard.
