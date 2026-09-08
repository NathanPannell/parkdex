# Parkdex rebrand and staging

Goal: Rebrand to Parkdex, deliver requested map/collection/account/celebration UX, open feature PR targeting staging, and deploy isolated persistent staging at staging.parkdex.app.

## Completed
- Located application at C:/repo/every-park (selected every-tree directory contains no repository).
- Fetched main and created/pushed staging at 735901b; feature branch feat/parkdex-rebrand starts from staging.

## Active work
- UI worker: frontend components/app, rebrand and all requested interaction changes.
- Logic worker: Juan de Fuca award and persisted timestamp contracts/tests.
- Infrastructure worker: persistent Neon/Railway/Vercel staging provisioning and workflows.
- Root: integration, independent review, PR delivery and deployed browser verification.

## Decisions
- Keep production isolated and parkdex.app intact.
- Keep feature PR open for review; deploy its build to staging without assuming authorization to merge PR.
- Preserve existing progress and storage compatibility; do not invent historical earning dates.

## Next
Integrate worker changes; run checks and independent quality review; push and open PR; deploy staging and verify critical desktop/mobile journeys.

## Production domain repair
- User confirmed Vercel alias worked while Parkdex domain had CORS failure.
- Infra commit 9aab887 adds persistent staging workflow and guarded production CORS repair.
- Actions run 34187704338 updated production origins and restarted current image; initial verifier raced readiness (worker correcting retry).
- Subsequent API GET/OPTIONS checks passed for apex and www. Root real browser confirms https://www.parkdex.app loads 216 places with no fetch/console error; production remains 735901b.

## Builder verification
- Backend: all 20 tests pass against a newly migrated disposable local database, including timestamped visit lists, account isolation and idempotent writes.
- Frontend: 55 tests pass; lint and typecheck clean. UI finishing keyboard dialog handling and production build before independent review.
- Neon staging branch provisioned with no expiration and five-minute compute auto-suspend. Railway/Vercel staging awaits reviewed feature push.

## PR and deployment
- App commit cbe3e2b; PR #5 https://github.com/NathanPannell/every-park/pull/5 targets staging and remains open.
- Final builder frontend result: 15 test files / 56 tests pass; lint, typecheck and production build pass.
- Independent quality review running against staging...HEAD.
- Persistent staging deployment run 34188326417 dispatched for exact cbe3e2b. PR CI run 34188334145 and isolated PR preview run 34188334311 also started.
- Repository AGENTS.md now directs future feature branches/PRs to staging and keeps production promotion explicit.

## Review and browser findings
- Independent review found login querying a returned pooled connection; moved the trail read inside its context and reran all 20 backend tests.
- Permanent production-repair workflow now restricted to main after the authorized one-time domain repair. Railway variable/redeploy operations now use existing bounded retries after an observed 90-second provider timeout.
- Deployed PR preview verified first Juan de Fuca visit awards Banana Slug and River Otter, sequential claims, earned timestamps, guest import, account shelves/see-all, reload persistence and mobile filter reset.
- Browser found badge detail was centered on desktop; corrected to full-viewport artwork/details (desktop split/mobile stack), with relevant UI checks and build passing.
- In-app browser input stalled after requesting GPS; reload recovered. Delayed GPS timeout + X dismissal regression passes; live GPS remains unverified in this environment.
- Final UI follow-up keys each queued celebration to restart animation/focus, with multi-award regression.
