# Legacy BC park import

`database/imports/legacy-bc-20261007/` adds every park from the legacy web Parkdex (formerly `map.parkdex.app`, retired with its Railway API on 2026-10-13) that is not already in the Parkdex catalogue: 1,273 parks across British Columbia. It is review input for `scripts/import_legacy_parks.py`; building it makes no database, R2 or provider change.

The full catalogue is about 10 MB, more than the 4 MiB that the content API and every installed build accept in one response. So every new park gets content reader floor 3 (`--minimum-reader 3`): builds installed today keep their current snapshot, and newer builds load the whole catalogue from a CDN release. See `docs/content-catalogue.md`.

## What is in it

The legacy production app lists 1,656 places (the same API and boundary file serve `map.parkdex.app`).

| Group | Count | Treatment |
| --- | ---: | --- |
| Islands (`category: island`) | 37 | Excluded. They are geographic check-offs, not parks, and installed builds reject the category. |
| Already in staging (revision 158) or production (revision 26) | 346 | Not touched. |
| Removed from staging by the operator on 2026-09-30 | 14 | Excluded. Production still has them. |
| New parks | 1,273 | 559 provincial, 473 municipal, 157 regional, 77 community and 7 national. |

Each new park keeps its legacy stable ID, name, category, region and pin. Its presentation is plain because per-park art and descriptions are retired: `scene` is null, the badge shape is `circle`, rarity is `common` (open from the first visit in every installed build), the seed comes from the ID, the biome comes from a name keyword (otherwise `forest`), and the blurb is a factual line such as "A municipal park in the City of Victoria." Access is the explicit unknown sentinel (`accessUnknown`, `walkM` 0, null drive routes), so the app sends visitors to Google Maps.

## Geometry and comparison

`sources/` pins the legacy production places API response, the legacy production boundary file (gzipped, the same bytes as the issue 20 and island imports), the staging revision 158 snapshot and the operator removal record. `sources/fetch-record.json` lists URLs and hashes.

The boundary file already groups source features per park. The builder keeps each feature's properties and geometry. Fourteen selected sources have self-intersecting rings; those are rebuilt with the island bundle's planar-face even-odd rule, which keeps exactly the area the app counts as inside (`normalization.json`). A 576-point grid check per normalized park finds no disagreement with the legacy even-odd interior.

`comparison-report.json` has one row per legacy park by stable ID: source feature IDs, source and output polygon, hole, ring and position counts, area kept and added, and probe points inside a secondary region and inside a hole. For all 1,273 new parks the source feature IDs match and 100% of the legacy area is kept. Counts differ only for the 14 normalized parks, where touching or crossing rings become a different but equal-area set of parts. For the 332 parks already in the catalogue, polygon and hole counts all match the current boundaries; only East Sooke differs in area (0.12%, its documented preservation override). No new park overlaps an existing park by more than 14% of either footprint (`overlaps.json`).

`boundaries.geojson.gz` is the importer input. Its decompressed SHA-256 is in `manifest.json`, which also records the projected sizes:

| | Staging | Production (after the island bundle) |
| --- | ---: | ---: |
| Snapshot for readers 1 and 2 | 334 parks, about 1.75 MB (unchanged) | 344 parks, about 1.66 MB |
| CDN index for reader 3 | 1,607 parks, about 0.95 MB | 1,617 parks, about 0.88 MB |
| CDN boundary chunks | 19 files, 9.1 MB in all, largest 524 KB | 19 files, 9.1 MB, largest 524 KB |

## Rebuild and test

```powershell
python scripts/build_bc_import.py
python scripts/test_build_bc_import.py
npx vitest run src/lib/content/catalogue-release.test.ts
```

The builder is deterministic and the test checks a rebuild against the committed files. The vitest test runs every park of the older staging and production snapshots and of the full reader 3 catalogues through the app's claim snapshot check and the account API contract, serves the older ones to readers 1 and 2, assembles the full ones the way the app does, and checks the probe points with the app's containment check.

## Apply

Order matters:

- Apply only after this PR and the flag game screens (#91) are on the environment. The deploy applies `content_004_catalogue_release.sql`. Without #91 the map draws one DOM pin per park, and 1,600 of them make the map unusable on a phone.
- Run the import, the release build, the upload and the pointer back to back. Between the import and the pointer, a reader 3 install that needs a fresh snapshot gets a content error and retries; readers 1 and 2 are unaffected throughout.

Run from a clean checkout at the merged commit, so plan and apply see the same source files. Database steps load the branch's connection from the operator's private file; R2 steps run through the delivery loader, which passes `CLOUDFLARE_API_TOKEN` to that one command. Expect `ready`, no blockers and 1,273 changes from each import plan.

### Staging (`ep-shiny-cherry-akobwdis.c-3.us-west-2.aws.neon.tech`)

```powershell
$line = @(Get-Content "$env:USERPROFILE\.codex\secrets\parkdex-kip.env") -match '^DATABASE_URL='
$env:DATABASE_URL = ($line[0] -split '=', 2)[1].Trim('"')
$null = New-Item -ItemType Directory -Force ..\..\legacy-bc-import
$bundle = "database/imports/legacy-bc-20261007"
$hostName = "ep-shiny-cherry-akobwdis.c-3.us-west-2.aws.neon.tech"
python scripts/import_legacy_parks.py plan --source "$bundle/boundaries.geojson.gz" --park-id-file "$bundle/park-ids.txt" --catalogue-source "$bundle/catalogue.json" --new-park-review "$bundle/new-park-review.json" --minimum-reader 3 --target-host $hostName --target-environment staging --out ..\..\legacy-bc-import\staging-plan.json
python scripts/import_legacy_parks.py apply --plan ..\..\legacy-bc-import\staging-plan.json --reviewed-plan-sha <planSha256> --expected-target-host $hostName --target-environment staging
python scripts/content_catalogue.py build --out ..\..\legacy-bc-import\staging-release --target-host $hostName --target-environment staging
```

Upload and check the release through the loader (from the same directory):

```powershell
python C:\Users\n8tew\.codex\private\kip-delivery\with-delivery-env.py <harness> -- python scripts/publish_content.py upload --snapshot ..\..\legacy-bc-import\staging-release --account-id 6f0eb57971124f41fadc7897ace74dac --bucket parkdex-kip-content --report ..\..\legacy-bc-import\staging-upload.json
python scripts/publish_content.py verify-cdn --snapshot ..\..\legacy-bc-import\staging-release --report ..\..\legacy-bc-import\staging-cdn.json
```

Point readers at it, dry run first:

```powershell
python scripts/content_catalogue.py point --release ..\..\legacy-bc-import\staging-release --expected-target-host $hostName --target-environment staging
python scripts/content_catalogue.py point --release ..\..\legacy-bc-import\staging-release --expected-target-host $hostName --target-environment staging --apply
Remove-Item Env:DATABASE_URL
```

### Production (`ep-rapid-voice-ak0plhpb.c-3.us-west-2.aws.neon.tech`)

Production is at revision 26 and has not had the island import. After the production release, load `parkdex-kip-main.env` the same way and run the island bundle first, then the same BC steps with the production host, `--target-environment production` and `production-` file names.

```powershell
$line = @(Get-Content "$env:USERPROFILE\.codex\secrets\parkdex-kip-main.env") -match '^DATABASE_URL='
$env:DATABASE_URL = ($line[0] -split '=', 2)[1].Trim('"')
$null = New-Item -ItemType Directory -Force ..\..\legacy-bc-import
$island = "database/imports/provincial-regional-20260929"
$hostName = "ep-rapid-voice-ak0plhpb.c-3.us-west-2.aws.neon.tech"
python -c "import json; ids = json.load(open('$island/selection.json', encoding='utf-8'))['selectedIds']; open('../../legacy-bc-import/island-ids.txt', 'w', encoding='utf-8').write(chr(10).join(ids) + chr(10))"
python scripts/import_legacy_parks.py plan --source "$island/boundaries.geojson" --park-id-file ..\..\legacy-bc-import\island-ids.txt --catalogue-source "$island/catalogue.json" --new-park-review "$island/new-park-review.json" --rarity-review "$island/rarity-review.json" --target-host $hostName --target-environment production --out ..\..\legacy-bc-import\production-island-plan.json
python scripts/import_legacy_parks.py apply --plan ..\..\legacy-bc-import\production-island-plan.json --reviewed-plan-sha <planSha256> --expected-target-host $hostName --target-environment production
```

Expect 270 island changes. The island rarity review changes seven existing rarities and needs the `park_enrichment_rollout` row that the Victoria 100 setup created on staging. If production has none, apply stops with "Rarity changes require an authoring rollout row" and changes nothing; plan again without `--rarity-review` and apply that plan. The island parks get no reader floor: they fit the older snapshot.

### Verify

```powershell
curl.exe -s -o older.json -w "%{http_code} %{size_download}\n" "https://staging.web.parkdex.app/api/content/snapshot?reader=2"
curl.exe -s "https://staging.web.parkdex.app/api/content/snapshot?reader=3"
```

Reader 2 should still get 334 parks in about 1.75 MB (344 and about 1.66 MB on production). Reader 3 should get the `catalogue` pointer with `parkCount` 1,607 (1,617 on production) and an index URL that answers 200. Then open the map on the host, search for "Wells Gray" and check that its boundary draws.

## Dry run

The 2026-10-08 dry run used throwaway PostgreSQL 18 databases loaded from the live staging snapshot (revision 158, unchanged) and the pinned production snapshot:

- Staging copy: the import planned `ready` with 1,273 changes, applied as one revision in 19 seconds, and replayed as `already-current`. The release build wrote a 954,267-byte index and 19 chunks (9,136,957 bytes, largest 524,253). The pointer dry run, the refusal without a CDN copy and the apply all behaved as above. The real handlers then served readers 1 and 2 the same 334 parks in 1,705,887 and 1,752,258 bytes, reader 3 a 437-byte pointer, reader 2 the import batch as a 599-byte no-op, and reader 3 a 413 for that batch.
- Production copy: the island plan with `--rarity-review` was refused for lack of a rollout row; without it, 270 changes applied; the BC import added 1,273; the release has 1,617 parks, an 882,508-byte index and 19 chunks. Readers 1 and 2 get 344 parks in 1,640,773 and 1,661,757 bytes.
- The web app (with #91 merged locally) loaded the release from local copies of the CDN files, showed every park, found Wells Gray in search, and counted a visit inside Tweedsmuir's and Wells Gray's secondary regions but not inside a Tweedsmuir hole.
