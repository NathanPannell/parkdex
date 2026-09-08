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
