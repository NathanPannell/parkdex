# Legacy BC park import

`database/imports/legacy-bc-20261007/` adds every park from the legacy web Parkdex that is not already in the Parkdex catalogue. It is review input for `scripts/import_legacy_parks.py`; building it makes no database, R2 or provider change.

## What is in it

The legacy production app lists 1,656 places. The bundle selects 1,273 new parks:

| Group | Count | Treatment |
| --- | ---: | --- |
| Islands (`category: island`) | 37 | Excluded. They are geographic check-offs, not parks, and installed builds reject the category. |
| Already in staging (revision 158) or production (revision 26) | 346 | Not touched. |
| Removed from staging by the operator on 2026-09-30 | 14 | Excluded. Production still has them. |
| Phase 1: Vancouver Island and the Gulf Islands | 552 | Ready to apply. 473 municipal, 77 community and the Gulf Islands and Pacific Rim national park reserves. |
| Phase 2: the rest of BC | 721 | Built and reviewed, but blocked. See "Why phase 2 waits". |

Each new park keeps its legacy stable ID, name, category, region and pin. Its presentation is plain because per-park art and descriptions are retired: `scene` is null, the badge shape is `circle`, rarity is `common` (open from the first visit in every installed build), the seed comes from the ID, the biome comes from a name keyword (otherwise `forest`), and the blurb is a factual line such as "A municipal park in the City of Victoria." Access is the explicit unknown sentinel (`accessUnknown`, `walkM` 0, null drive routes), so the app sends visitors to Google Maps.

## Geometry and comparison

`sources/` pins the legacy production places API response, the legacy production boundary file (gzipped, the same bytes as the issue 20 and island imports), the staging revision 158 snapshot and the operator removal record. `sources/fetch-record.json` lists URLs and hashes.

The boundary file already groups source features per park. The builder keeps each feature's properties and geometry. Fourteen selected sources have self-intersecting rings; those are rebuilt with the island bundle's planar-face even-odd rule, which keeps exactly the area the app counts as inside (`normalization.json`). A 576-point grid check per normalized park finds no disagreement with the legacy even-odd interior.

`comparison-report.json` has one row per legacy park by stable ID: source feature IDs, source and output polygon, hole, ring and position counts, area kept and added, and probe points inside a secondary region and inside a hole. For all 1,273 new parks the source feature IDs match and 100% of the legacy area is kept. Counts differ only for the 14 normalized parks, where touching or crossing rings become a different but equal-area set of parts. For the 332 parks already in the catalogue, polygon and hole counts all match the current boundaries; only East Sooke differs in area (0.12%, its documented preservation override).

No new park overlaps an existing park by more than 14% of either footprint (`overlaps.json`), so none is a duplicate.

## Why phase 2 waits

Installed builds and the server both refuse a content response over 4 MiB (`MAX_RESPONSE_BYTES`). Phase 2 boundaries are about 6.3 MB, so applying it would take the snapshot to about 10 MB: fresh installs would get no catalogue and existing installs would stop updating. Phase 1 takes staging to about 3.6 MB at reader 2 (about 590 KB headroom) and production, with the island bundle, to about 3.5 MB. `manifest.json` records the projections. Phase 2 needs a content sync change for newer readers first, such as paged snapshots or boundaries served as an immutable R2 file. See `docs/learnings/content-snapshot-size.md`.

## Rebuild and test

```powershell
python scripts/build_bc_import.py
python scripts/test_build_bc_import.py
npx vitest run src/lib/content/catalogue-release.test.ts
```

The builder is deterministic and the test checks a rebuild byte for byte. `--include-phase-2-boundaries` also writes `phase-2/boundaries.geojson` (not committed; its hash is in the manifest). The vitest test runs every park of the projected staging and production catalogues through the app's claim snapshot check and the account API contract, serves them through the real snapshot and changes handlers, reads them with the current and strict v1 readers, and checks the probe points with the app's containment check.

## Apply

Run from a clean checkout at the merged commit, so the plan's source file paths and hashes stay valid between plan and apply. Load the target branch's connection from the operator's private file without printing it, plan, review, then apply. Each apply is one transaction that emits one content revision; no content channel publish is needed, because `/api/content/snapshot` and `/api/content/changes` read Neon directly and the channel pointer only names the immutable asset release.

Before applying, check the live snapshot still has room. Phase 1 adds about 1.86 MB:

```powershell
curl.exe -s -o NUL -w "%{size_download}\n" "https://staging.web.parkdex.app/api/content/snapshot?reader=2"
```

The result plus 1,860,000 must stay under 3,670,000 (4 MiB less 512 KiB).

### Staging

```powershell
$line = @(Get-Content "$env:USERPROFILE\.codex\secrets\parkdex-kip.env") -match '^DATABASE_URL='
$env:DATABASE_URL = ($line[0] -split '=', 2)[1].Trim('"')
$null = New-Item -ItemType Directory -Force ..\..\legacy-bc-import
$bundle = "database/imports/legacy-bc-20261007"
python scripts/import_legacy_parks.py plan `
  --source "$bundle/phase-1/boundaries.geojson" `
  --park-id-file "$bundle/phase-1/park-ids.txt" `
  --catalogue-source "$bundle/catalogue.json" `
  --new-park-review "$bundle/phase-1/new-park-review.json" `
  --target-host ep-shiny-cherry-akobwdis.c-3.us-west-2.aws.neon.tech `
  --target-environment staging `
  --out ..\..\legacy-bc-import\staging-phase-1-plan.json
```

Check the printed result: `status` is `ready`, `blockers` is empty and `changeCount` is 552. Then:

```powershell
python scripts/import_legacy_parks.py apply `
  --plan ..\..\legacy-bc-import\staging-phase-1-plan.json `
  --reviewed-plan-sha <planSha256> `
  --expected-target-host ep-shiny-cherry-akobwdis.c-3.us-west-2.aws.neon.tech `
  --target-environment staging
Remove-Item Env:DATABASE_URL
```

Expect `"result": "applied"` with 552 changes. Running apply again returns `already-current`.

### Production

Production is at revision 26 and has not had the island import. Apply the island bundle first, then phase 1, each as its own reviewed plan.

```powershell
$line = @(Get-Content "$env:USERPROFILE\.codex\secrets\parkdex-kip-main.env") -match '^DATABASE_URL='
$env:DATABASE_URL = ($line[0] -split '=', 2)[1].Trim('"')
$null = New-Item -ItemType Directory -Force ..\..\legacy-bc-import
$island = "database/imports/provincial-regional-20260929"
python -c "import json; ids = json.load(open('$island/selection.json', encoding='utf-8'))['selectedIds']; open('../../legacy-bc-import/island-ids.txt', 'w', encoding='utf-8').write(chr(10).join(ids) + chr(10))"
python scripts/import_legacy_parks.py plan `
  --source "$island/boundaries.geojson" `
  --park-id-file ..\..\legacy-bc-import\island-ids.txt `
  --catalogue-source "$island/catalogue.json" `
  --new-park-review "$island/new-park-review.json" `
  --rarity-review "$island/rarity-review.json" `
  --target-host ep-rapid-voice-ak0plhpb.c-3.us-west-2.aws.neon.tech `
  --target-environment production `
  --out ..\..\legacy-bc-import\production-island-plan.json
python scripts/import_legacy_parks.py apply `
  --plan ..\..\legacy-bc-import\production-island-plan.json `
  --reviewed-plan-sha <planSha256> `
  --expected-target-host ep-rapid-voice-ak0plhpb.c-3.us-west-2.aws.neon.tech `
  --target-environment production
```

Expect 270 changes (244 new parks, 26 existing parks). The rarity review changes seven existing rarities and needs the `park_enrichment_rollout` row that the Victoria 100 authoring setup created on staging. If production has no such row, apply stops with "Rarity changes require an authoring rollout row" and changes nothing; then plan again without `--rarity-review` (boundary updates and new parks only) and apply that plan.

Then phase 1, with the same commands as staging but the production host, `--target-environment production` and a `production-phase-1-plan.json` output. Expect 552 changes. Clear `DATABASE_URL` afterwards.

### Verify

```powershell
curl.exe -s "https://staging.web.parkdex.app/api/content/snapshot?reader=2" -o staging-snapshot.json
python -c "import json; s=json.load(open('staging-snapshot.json', encoding='utf-8')); print(s['revision'], len(s['parks']))"
```

Staging should report one more revision and 552 more parks; production about 896 parks. Both bodies must be under 4 MiB. Then open the map at Victoria on the host and confirm the new parks have pins and boundaries.

## Dry run

The 2026-10-08 dry run used a throwaway PostgreSQL 18 database loaded from the pinned snapshots:

- Staging copy (334 parks): phase 1 planned ready with 552 changes, applied as one revision, and replayed as `already-current`. The real snapshot handler then served 886 parks in 3,529,665 bytes (reader 1) and 3,609,708 bytes (reader 2); the changes handler served the import as one 1,977,491-byte batch.
- Production copy (100 parks): the island plan with `--rarity-review` was refused because the copy has no authoring rollout row; the island plan without it applied 270 changes, then phase 1 applied 552. The snapshot served 896 parks in 3,519,207 bytes at reader 2.
