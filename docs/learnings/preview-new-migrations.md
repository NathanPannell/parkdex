# A PR's new migrations are tested from its own inventory

Recorded: 2026-10-08. Applies to: PRs that add a migration.

## What went wrong

The preview for the flag game server PR returned 503 on every new route. The preview harness read the migration inventory from the trusted staging checkout, not from the candidate, so a migration that the PR added to `deployment.json` was never applied to its own preview database.

## Rule

PR previews are retired (2026-10-19). CI now applies the PR's own `deployment.json` inventory from scratch to a fresh Postgres 18 database in the release checks (content sync SQL QA) and in the e2e API server. When a PR adds a migration, list it in `deployment.json` in the same PR, so CI applies it. Never apply candidate SQL to staging or production by hand; the merged inventory does that.

## How to check

The release checks job shows the content sync SQL QA passing, and a test that calls a new route against the e2e API (or a SQL QA script) passes in the same run.

## History

- 2026-10-08: created for PR previews.
- 2026-10-19: previews retired; CI applies each PR's own inventory.
