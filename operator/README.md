# Parkdex operator dashboard

A separate web app for running Parkdex: the feedback board, park proposals and per-build remote configuration. It reads and writes the same Neon tables as the main app (`kip_feedback`, `kip_proposals`, `kip_app_config`) through the shared modules in `../worker`.

It has no sign-in of its own. Vercel Authentication is the only access control.

## Access model

On the Hobby plan, Vercel Authentication (Standard Protection) covers every preview deployment URL and any custom domain aliased to a preview deployment. It does not cover production domains. So this app is deployed as preview only:

- Deploy with `vercel deploy --prebuilt` and never pass `--prod`.
- Point the stable URL at the latest preview deployment with `vercel alias set`.
- Set environment variables for the Preview target only.
- As a backstop, the API returns 403 for every request when `VERCEL_ENV` is `production`, so an accidental production deployment shows an empty shell and no data.

Writes also require the request's `Origin` to match the dashboard host.

Drafts live in `kip_park_drafts.drafts` (`database/migrations/park_drafts_001_init.sql`), outside synchronized content. Installed apps see nothing until a draft is published, and publishing only writes fields and values every supported build already reads (see `docs/content-compatibility.md`). A badge is uploaded to `releases/<sha256>/art/badges/scenes/<slug>.webp` on the Kip CDN and verified there before the park row is written, the same layout as `scripts/publish_park_update.py`. Each new image gets a new slug.

## Pages

- **Feedback:** a board with New, Reviewing, Planned and Closed columns. Drag a card to change its status (long-press on touch screens), with Undo. Click a card for the full report, screenshot, follow-up and email delivery retry. Keyboard users open a card and set its status from the panel. `/feedback/review?id=<report>` opens a report directly; operator emails use this link.
- **Proposals:** parks players suggested from the map, with an outline sketch, Google Maps link, GeoJSON download and status.
- **Import from map:** search the legacy map's 1,656 parks (map.parkdex.app) and create a draft from one. A draft copies the park's complete boundary (every feature, in source order, holes kept) and its full legacy record.
- **Drafts:** set the category, rarity, name, short name, biome and badge shape, write an optional description, attach a reference photo and upload an optional WebP badge. "Copy AI brief" copies a JSON brief with the record, boundary and photo link for an LLM or image model. Publish copies the draft into `public.parks`, `public.boundaries` and the drive tables in one transaction. Drive and walk access start as unknown (walk 0, no routes), the importer's existing sentinel.
- **Builds:** rows in `kip_app_config.builds` that choose each build's content database, feature flags, and minimum and latest builds.

## Local development

```
npm ci
npm ci --prefix operator
npm run dev --prefix operator
```

The dev server loads the shared worker modules directly, so it also needs the root dependencies. The production build does not.

With no `DATABASE_URL`, the dev server serves fictional in-memory data at http://127.0.0.1:5191 and email sending is off. Set `DATABASE_URL` in the shell to point it at a real database. Use a Neon branch you own, not production.

```
npm run typecheck --prefix operator
npm test --prefix operator
```

`server/drafts.pg.test.ts` runs the draft store and publish transaction against the real content triggers when `OPERATOR_DRAFTS_TEST_DATABASE_URL` points at a disposable loopback database named `kip_qa_*`. It applies the content and drafts migrations itself.

## Build and deploy

`npm run build` writes a Vercel Build Output bundle to `operator/.vercel/output`: the static UI plus one Edge Function at `/api/*` that bundles the shared worker modules. The Vercel project therefore needs no access to the rest of the repository.

Runtime environment variables (Preview target only):

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Neon connection string for the data the dashboard should edit (sensitive) |
| `RESEND_API_KEY` | Needed only to retry failed feedback emails (sensitive) |
| `EMAIL_MODE` | `resend`, or `disabled` to turn retries into a no-op |
| `DASHBOARD_ENVIRONMENT` | Label shown in the sidebar, for example `production` |
| `STAGING_DATABASE_URL` | Optional staging branch connection string (sensitive). When set, a sidebar toggle switches the whole dashboard to staging; the choice is the `parkdex_operator_db` cookie |
| `CLOUDFLARE_API_TOKEN` | R2 write token, needed only to publish a draft with a badge (sensitive) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account that owns the content bucket |
| `ASSETS_BUCKET` | Optional; defaults to `parkdex-kip-content` |
| `LEGACY_BOUNDARY_URL`, `LEGACY_PLACES_URL` | Optional; default to map.parkdex.app's boundary file and the production places API |

Deploy from the `operator` folder after linking it to the `parkdex-operator` Vercel project (`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, or `vercel link`):

```
npm run build --prefix operator
vercel deploy --prebuilt --cwd operator
vercel alias set <deployment-url> <stable-host>
```

The build writes `builds.json` with a preview target, because `vercel deploy --prebuilt` reads its target from there. Vercel still makes a project's first deployment its production deployment, so the `parkdex-operator` project's production deployment is a static "Nothing to see here" page with no API and no env vars. Leave it in place; replacing it with the dashboard would publish the UI shell on parkdex-operator.vercel.app.

The live setup: project `parkdex-operator`, stable host `operator.parkdex.app` (Vercel DNS) aliased to the latest preview, reading the production Neon branch.

Then set `OPERATOR_DASHBOARD_URL` to the stable host in the main app's runtime secret bundle, so operator emails link to the dashboard.
