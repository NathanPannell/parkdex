# Migration replay can deadlock with live traffic

Recorded: 2026-10-08. Applies to: deploy migrations (`scripts/kip-delivery.py run_migration`), especially `content_001_sync.sql`.

## What went wrong

The staging deploy for the flag game identity PR failed in the migration step with `deadlock detected`. Migrations replay on every deploy, and `content_001_sync.sql` drops and recreates triggers on `public.parks` inside one transaction that already holds a lock on `content_map`. A content request that read `parks` and then `content_map` at the same moment deadlocked with it. The deploy job only runs on the first attempt, so it could not simply be rerun, and staging stayed on the previous release until the next push.

## Rule

Migrations run with a 5 second `lock_timeout` and are retried up to four times on a deadlock or lock timeout. This is safe only because every migration is idempotent and runs in one transaction. Keep both properties for every new migration. Avoid taking exclusive locks on hot tables when a migration replays; prefer `CREATE OR REPLACE` and guarded `IF NOT EXISTS` blocks over drop-and-create.

## How to check

`python -m unittest discover -s scripts -p "test_kip*.py"` covers the retry (`MigrationLockRetry`). After a deploy, the migration log shows `migration-retry=` lines when a retry happened.

## History

- 2026-10-08: created.
