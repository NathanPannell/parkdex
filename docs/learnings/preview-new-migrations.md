# Previews do not apply a PR's new migrations

Recorded: 2026-10-08. Applies to: PR previews (`scripts/kip-delivery.py preview`) for PRs that add a migration.

## What went wrong

The preview for the flag game server PR returned 503 on every new route. The harness reads the migration inventory from the trusted staging checkout, not from the candidate, so a migration that the PR adds to `deployment.json` is never applied to its own preview database. Applying it to the branch's `parkdex_kip` database did not help either: the preview app uses its own database `kip_preview_<pr>_<id>`, owned by role `kip_pr_<pr>_<id>`.

## Rule

When a PR adds a migration, apply that migration by hand to the preview database, as the preview role, before preview QA. Say in the PR that you did. Never apply candidate SQL to staging or production by hand; the merged inventory does that.

## How to check

Run a new route on the preview and confirm it does not return 503. Check that the new schema exists in `kip_preview_<pr>_<id>`, not only in `parkdex_kip`.

## History

- 2026-10-08: created.
