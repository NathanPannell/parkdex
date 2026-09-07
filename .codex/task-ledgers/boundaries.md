# Park and island boundaries PR

## Goal
Add accurate park and island polygon boundaries to Every Park and open a verified PR; leave production/main unmerged.

## Scope and assumptions
- Preserve 216 catalogue IDs and anonymous visited state.
- Use real sourced Polygon/MultiPolygon geometry including parts/holes; mobile-friendly simplification and attribution. No circles/boxes as substitute boundaries.
- Subtle zoom-aware outlines under readable clustered markers; selected place clearly highlighted; map/list filters stay consistent.
- Explicitly disclose any boundary coverage gaps rather than invent geometry.

## Ownership
- boundary_data: authoritative geometry research, reproducible build, data validation and provenance.
- boundary_app: map integration, styles, build asset wiring, behavior tests.
- root: integration review, independent quality review, PR creation, CI/isolated preview and mobile/desktop browser verification.

## State
- Worktree C:/repo/every-park-boundaries, branch feat/park-island-boundaries, based on origin/main b190b69.
- Production remains https://every-park-nu.vercel.app; deployment to production not requested.
- Existing preview workflow provisions isolated Neon/Railway/Vercel resources and cleans up on PR close. User requested this PR remain open for review.

## Next
PR #2 is open as a draft. Push review fixes, recheck CI and refreshed preview, then mark ready and deliver the PR link.

## Data evidence
- All 216 IDs covered: 136 DataBC, 34 CRD, 4 CVRD, 14 RDN, 2 NRCan CLSS legislative reserves, 25 OSM island coastline relations and Bere Point OSM park way.
- All 447 source parts and 100 holes retained; 149,993 positions; 3,354,992 bytes raw / 845,382 gzip. No missing IDs or topology warnings. Geometry falls back to original source precision if simplification or rounding invalidates it.
- Catalogue and boundary validation passed; canonical places and immutable migrations are unchanged.

## Integration contract and verification
- Data: `data/boundaries.geojson`, one Polygon/MultiPolygon feature per covered canonical ID, with id/name/category/sourceName/sourceUrl/sourceId; `data/boundary-audit.json` records source and geometry coverage.
- Static boundary asset must build without upstream network; preserve `data/places.json` and immutable seed migrations.
- Browser cases: overview and clustered markers, selected provincial/regional/national/island boundaries, multipart bounds, category/visited filters, checkoff/reload/undo, mobile and desktop, loading/failure states and console errors.
- Existing preview configuration was independently checked: enabled and ready; no infrastructure changes needed. Keep the real feature PR and its resources open for review.
- Frontend integration is complete: the versioned public GeoJSON is fetched and parsed by MapLibre's worker, while a compact static ID/bounds index supports coverage messages and multipart selection fit without main-thread geometry parsing.
- Boundary layers stay beneath clusters/point hit targets, render parks above enclosing islands, mirror search/category filters, reflect visited feature state, and prefer contained parks for overlapping polygon clicks.
- Frontend verification passed: exact static asset checksum/index check, 11 Vitest tests including MapLibre style validation, lint, typecheck, optimized build, diff check, and Impeccable detector with no findings.

## Review and preview evidence
- Initial commit 5e56597: CI 34168176718 and isolated preview 34168176720 passed. PR https://github.com/NathanPannell/every-park/pull/2.
- Root browser found selected polygons obscured by mobile details; fixed with measured layout padding and resize-aware fitting. Full Strathcona boundary verified above details at 390 x 844.
- Independent review found premature boundary-ready state and gaps in provenance/OSM validation. Source-specific loading/error state and shared reviewed source manifest now address those findings; all geometry sources receive topology validation.
- Frontend fixes pass 14 tests, lint, typecheck and optimized build. Three source contract mutation tests and full boundary validation pass. Canonical geometry remains unchanged.
- Forced missing-GeoJSON local browser test showed an honest unavailable message while pins/selection remained usable; asset restored and checksum parity passed.
- Initial deployed preview showed multipart national and full-island boundaries with no console errors. Checkoff persisted through reload and was undone. Final refreshed-preview browser check remains pending.
- Refreshed application commit 4775452 passed CI and mobile/desktop deployed-browser checks, including checkoff/reload/undo with no console warnings/errors.
- Preview refresh exposed Railway watched-path skipping on frontend-only revisions. Preview uploads now include a generated backend marker and deployment message unique to SHA/run/attempt; the source gate requires the matching API and worker deployments to succeed. Independent review confirmed the scoped workflow correction. Final automated run and its browser smoke remain pending.
