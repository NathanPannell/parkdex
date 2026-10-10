# SQL QA pools can be torn down before their connections close

Recorded: 2026-10-09. Applies to: `scripts/qa-*-sql.mjs`, `scripts/qa-postgres-adapter.mjs`.

## What went wrong

PR checks for the park founders PR failed in `npm run test:sql` on Linux CI while every local Windows run passed. `pool.end()` in node-postgres resolves as soon as it has asked its idle connections to close, not when they have closed. The founders QA then dropped its database `WITH (FORCE)`, the server terminated a connection that was still closing (57P01), and the pool emitted an `error` event nobody listened for. The process died printing the whole client object, and the release harness kept only the tail of that dump, so the message was lost.

## Rule

Every pool used by SQL QA has an `error` listener. `qa-postgres-adapter.mjs` ignores errors once the pool is ending and fails the run with a one-line reason otherwise; a script with its own `pg.Pool` must do the same. Failure output from the release harness shows the first error as well as the tail (`failure_detail` in `scripts/kip-delivery.py`).

## How to check

`node scripts/qa-postgres-adapter-end.mjs` (part of `npm run test:sql`) holds back the pool's close messages so the server's termination always wins, and passes only when the run survives it. `python -m unittest discover -s scripts -p "test_kip*.py"` covers `FailureDetail`.

## History

- 2026-10-09: created.
