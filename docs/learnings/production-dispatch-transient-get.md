# One transient provider GET aborted a production release

Recorded: 2026-10-08. Applies to: `api_json` and `urlopen_read` in `scripts/kip-delivery.py`, `_r2_object` in `scripts/kip_private_photos.py`, and `deploy-production.yml` / `deploy-staging.yml` dispatch.

## What went wrong

The production deploy for release merge `0d9e7fd7eb98f0de9fc33e6acdfed2789a3aa84c` failed in "Queue exact production services concurrently" with "Production dispatch needs manual recovery: Cloudflare: api.cloudflare.com API GET request could not complete." Migrations on Neon `main` had already succeeded and Vercel deployed fine, but the private photo Worker was not redeployed. `api_json` turned the first network error on an idempotent GET into a release failure, and nothing retried it.

The deploy workflows are first-attempt only (`if: github.run_attempt == 1`, and `dispatch_release_services` refuses `GITHUB_RUN_ATTEMPT != 1`), so re-running the job is not a recovery. Recovery needs a new push to `main`. Until then `verify-main` fails with "Private-photo Worker ownership metadata mismatch for KIP_RELEASE_SHA", because the live Worker still carries the previous release SHA.

## Rule

- Provider reads go through `urlopen_read`, which retries a GET up to 3 attempts in total (2 s, then 5 s) on `URLError`, `TimeoutError`, `ConnectionError` and HTTP 429, 500, 502, 503 and 504. Other HTTP errors, including 404, fail at once.
- Never retry POST, PUT, PATCH or DELETE. The provider may have applied the write before the connection dropped. Check state before repeating a write.
- Keep the final error messages unchanged so runbooks and alerts still match.
- Take an injectable `sleep` in any new retry loop so tests do not wait.
- If dispatch still fails after retries, do not re-run the workflow. Diagnose, then push a new commit to `main` (or `staging`) and run `verify-main` (or `verify-staging`) against it.

## How to check

`python scripts/kip-delivery.py ci-checks` runs the delivery tests. `ProviderGetRetry` and `R2ObjectGetRetry` in `scripts/test_kip_delivery.py` prove that GETs retry transient failures, give up after 3 attempts with the same message, do not retry 404 or other client errors, and never retry writes.

## History

- 2026-10-08: created after the production dispatch for `0d9e7fd` failed on one Cloudflare GET.
