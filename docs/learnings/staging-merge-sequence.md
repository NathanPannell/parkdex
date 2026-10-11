# Back-to-back staging merges blocked the second dispatch

Recorded: 2026-10-11. Applies to: merging PRs into `staging`, `deploy-staging.yml` dispatch, and the prior-release gate in `scripts/kip-delivery.py`.

## What went wrong

#162 merged as `eda45e0`. #160 was then rebased onto it and merged as `3162fe4` before `eda45e0` had been assigned and verified at `staging.web.parkdex.app`. The staging dispatch for `3162fe4` failed with "Staging dispatch needs manual recovery: Vercel: The prior staging SHA has not passed stable URL verification." Its Cloudflare part had already run, so the staging photo Worker carried `3162fe4` while the stable URL still served the previous SHA.

The deploy workflows are first-attempt only (`if: github.run_attempt == 1`), so a rerun of the job is skipped and is not a recovery.

## Rule

- After each merge into `staging`, find the READY deployment for that merge SHA, run `assign-staging --apply` and `verify-staging`, and only then merge the next PR. "Merge one PR at a time" includes this verification step.
- If a dispatch is blocked by the prior-release gate, assign the prior SHA's READY deployment so the stable URL serves it. Then push a new commit to `staging` and verify that commit. Do not rerun the workflow.
- `verify-staging` for the prior SHA can fail on the photo Worker SHA after a partial dispatch. That is expected until the new push redeploys the Worker.

## How to check

`curl https://staging.web.parkdex.app/release.json` must show the merge SHA you just verified before the next merge.

## History

- 2026-10-11: created after `3162fe4`'s staging dispatch was refused because `eda45e0` was unverified.
