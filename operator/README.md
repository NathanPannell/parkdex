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

## Pages

- **Feedback:** a board with New, Reviewing, Planned and Closed columns. Drag a card to change its status (long-press on touch screens), with Undo. Click a card for the full report, screenshot, follow-up and email delivery retry. Keyboard users open a card and set its status from the panel. `/feedback/review?id=<report>` opens a report directly; operator emails use this link.
- **Proposals:** parks players suggested from the map, with an outline sketch, Google Maps link, GeoJSON download and status.
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

## Build and deploy

`npm run build` writes a Vercel Build Output bundle to `operator/.vercel/output`: the static UI plus one Edge Function at `/api/*` that bundles the shared worker modules. The Vercel project therefore needs no access to the rest of the repository.

Runtime environment variables (Preview target only):

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Neon connection string for the data the dashboard should edit (sensitive) |
| `RESEND_API_KEY` | Needed only to retry failed feedback emails (sensitive) |
| `EMAIL_MODE` | `resend`, or `disabled` to turn retries into a no-op |
| `DASHBOARD_ENVIRONMENT` | Label shown in the sidebar, for example `production` |

Deploy from the `operator` folder after linking it to the `parkdex-operator` Vercel project (`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, or `vercel link`):

```
npm run build --prefix operator
vercel deploy --prebuilt --cwd operator
vercel alias set <deployment-url> <stable-host>
```

Then set `OPERATOR_DASHBOARD_URL` to the stable host in the main app's runtime secret bundle, so operator emails link to the dashboard.
