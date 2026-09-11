# Catalogue photo coverage

## Goal and success condition

Run a systematic, rights-safe photo search for all 198 catalogue places, add every verified usable asset within the existing variant budgets, preserve attribution and redistribution obligations, and open a staging-targeted pull request with coverage evidence. This task does not authorize merge, deployment, production changes, paid services, or contacting photographers.

## Baseline

- Base: `6cf98a90110c43b51483070562817b3ef8c2b76a` on `feat/catalogue-photo-coverage`.
- Catalogue: 198 places: 2 national, 117 provincial, 55 regional, and 24 islands.
- Existing verified assets: 18 place records / 36 WebP variants: 2 national, 14 provincial, 2 regional, 0 islands.
- Park coverage: 18 / 174 (10.3%). Whole catalogue coverage: 18 / 198 (9.1%).
- Owned search partition: all missing national and provincial entries (103 missing; both national parks already covered).
- Partner search partition: missing regional and island entries. Initial metadata slots remain reserved by place ID so the partitions cannot collide.

## Decisions and constraints

- Search Commons first using exact park names, known aliases, and documented named features. Use another open source only when its file-level license permits redistribution and commercial use.
- Accept only place-specific imagery with explicit location evidence. Exclude generic nearby scenery, NC/ND licenses, all-rights-reserved work, unclear rights, generated imagery, and uncertain locations.
- Record source page, original file URL, creator, license and URL, location evidence and URL, alt text, and transformations for each accepted asset.
- Preserve the existing 320 px / 64 KB thumbnail and 960 px / 425 KB detail budgets; never upscale.
- Independently verify and visually inspect partner candidates before adding them.
- Keep unavailable entries explicit in the search report with the attempted queries and rejection reason.

## Progress

- Baseline inventory complete.
- National/provincial systematic search complete: 103/103 gaps received exact-name and expanded Commons searches; 46 candidates passed source, rights, location, and visual review, while 57 remain unavailable. Hesquiat Lake was withheld because the file established the lake but not a position inside the park parcel.
- Regional/island systematic search complete: 77/77 gaps received Commons-first and commercial-license Openverse fallback searches; 43 candidates passed independent metadata and visual review, five uncertain candidates were withheld, and 29 were unmatched.
- Integrated 89 new records / 178 new WebP variants into the existing manifest. Every candidate was inspected in contact sheets; current Commons metadata was re-fetched, and the two Flickr landing pages were independently checked for their displayed CC BY 2.0 license and place title.
- Focused place-image validation passes at 107 total records. Final integrated verification passed: 24 test files / 125 tests, lint, typecheck, and the production Webpack build. The default Turbopack build was also attempted; it could not traverse the worktree's external `node_modules` junction, an environment-only restriction, while the equivalent production Webpack build completed.
- Browser verification exercised a real mobile search and place detail flow against a local fixture generated from `data/places.json`. Arbutus Grove returned one exact result, its local detail image loaded at nonzero width, and its visible creator/original/license credits rendered. External map tiles were blocked by the browser sandbox; the catalogue API and local photo asset succeeded.
- Independent quality review cleared commit `b1c07eaf640ec8f0ede0ceb39bc51c74281a05df` with no material findings after reviewing all 89 photos and decoding all 178 variants. Three optional metadata/documentation cleanups were applied afterward without changing any image assets.

## Evidence and sources

- Existing manifest: `frontend/lib/place-images.ts`.
- Catalogue: `data/places.json`.
- Existing asset policy and credits: `frontend/public/places/README.md`.
- Added-credit index: `frontend/public/places/CATALOGUE_CREDITS.md`.
- National/provincial search log: `.codex/photo-search-report-national-provincial.md`.
- Regional/island search log: `.codex/photo-search-report-regional-islands.md`.
- Partner research ledger: `.codex/task-ledgers/photo-regional-islands.md`.
- Mobile search screenshot: `.codex/catalogue-photo-search-mobile.png`.
- Mobile detail and visible credit screenshot: `.codex/catalogue-photo-detail-mobile.png`.

## Final coverage

- National: 2 / 2 (100%).
- Provincial: 60 / 117 (51.3%).
- Regional: 21 / 55 (38.2%).
- Parks overall: 83 / 174 (47.7%), up from 18 / 174 (10.3%).
- Islands: 24 / 24 (100%), up from 0 / 24.
- Whole catalogue: 107 / 198 (54.0%), up from 18 / 198 (9.1%).
- Shipped asset set: 107 manifest records and 214 local WebP variants.

## Next action

Keep draft PR #39 unmerged and undeployed for user review.
