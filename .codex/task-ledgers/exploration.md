# Exploration, badges and accounts

## Goal
Deliver at least 20 native-species achievement badges with reusable images; explicit two-trail Banana Slug Medal; nearby unseen park discovery and location; authority-grouped filtered collection; secure email/password accounts and saved progress; gap-preserving explored map and rounded expanded display boundaries.

## Decisions
- Worktree C:/repo/every-park-exploration, feat/exploration-accounts, from merged boundary work origin/main 3f55b59.
- Preserve canonical place IDs, guest visits, authoritative boundary data and incumbent mobile visual identity.
- Trail completion is explicit and distinct from visiting a park.
- Deliver through PR/isolated preview; no production merge inferred.

## Ownership
- accounts: backend, migration and security tests.
- frontend: app shell, account/discovery/achievement UI and tests.
- map: map, display geometry and tests.
- root: image sourcing/licenses, integration coordination, independent quality review, preview and browser verification.

## Next
Agree shared API/map contracts; implement; run checks; independent review; PR/preview/browser verification.

## Image sourcing milestone
- 22 individually licensed Commons photographs downloaded locally (1.65 MB total), manifest in frontend/lib/badge-images.json, complete credits in data/badge-image-credits.md.
- Allowed image licenses: public domain, CC BY and CC BY-SA; exclude NC/ND. Preserve creator/source/license links and crop disclosure in UI.
- Decoded all 22 images and visually inspected a contact sheet; selected a clear NOAA Southern Resident orca image near San Juan Island instead of an Antarctic ecotype image.
- Existing production design visually inspected: forest/cream field guide, map-dominant layout, compact dock.
- Local disposable integration database: everypark_accounts on localhost:5434; backend worker owns migration/testing.

## Integration milestone
- Backend migration 0006 and 17 backend tests pass. Local API :8000 uses isolated everypark_accounts DB.
- Map builder passed 12 geometry/style tests and typecheck: 4 km footprints, rounded unioned links capped at 24 km, 0.8 km openings for unseen places. No large concave-hull triangles across unexplored areas.
- Root integration read identified guest/account async edge cases; accounts worker now owns an isolated frontend progress hook with focused tests while frontend worker completes UI/CSS and integrates it.
- Local frontend :3000 started for mobile/desktop integration checks; optimized build must run after stopping dev server.
- Pending: integrated frontend checks, independent quality review, PR/preview runtime and real-browser verification.

## Review and verification milestone
- Initial local browser batch covered 390x844 mobile and 1280x900 desktop: badge photos/account form readable; found invisible trail text, expanded giant groups, empty-map CTA omission and still-angular park edge. Builders addressed all four in the integrated UI/display geometry.
- Independent quality review reproduced a concurrent login throttle bypass. Root added ordered per-scope PostgreSQL transaction advisory locks and a real 10-thread barrier-start regression: exactly five password checks/401s, five429s.
- Full backend suite now18passed. Current frontend suite38passed; actual hook reload/async tests and final lint/typecheck/build remain in progress.
- Canonical boundary asset check and new softened display checksum/216-ID checks pass. Canonical fit-index false stale error came from Windows checkout line endings; local sync restored expected bytes without content diff.
- Dev server48668 stopped to allow optimized build. Local backend restart for throttle fix pending accounts worker.

## Final local verification
- Frontend: 50 tests, lint, typecheck, canonical/display asset checks and optimized build pass. All 216 display polygons valid; canonical geometry unchanged. LF attributes stabilize hashes across Windows/Linux.
- Backend: 20 tests pass, including direct authenticated visit/trail persistence and identity isolation. Final throttle uses short atomic reservations, releasing pooled connections before password hashing; readiness remains responsive under concurrent login checks. This supersedes the advisory-lock approach above.
- Browser: guest visit earns first badge; both explicit trail completions earn Banana Slug; registration and optional import restore one visit and two trail checkoffs. Initial mobile/desktop visual fixes incorporated.
- Next: publish branch/PR, wait isolated preview checks, verify deployed browser journeys.
