# Nova Scotia staging load

On 2026-10-13 the Nova Scotia bundle (`database/imports/ns-20261013/`, #187) and the Nova Scotia OSM outlines (#185) were loaded into **staging only** (issue #182). Production is a separate step, done only when the operator asks. The bundle itself, its sources and its review are described in `docs/import-nova-scotia-parks.md`.

Everything ran from a clean checkout detached at `7202a49` (the #187 merge, which `staging.web.parkdex.app/release.json` was serving), against the staging Neon branch (`ep-shiny-cherry-akobwdis.c-3.us-west-2.aws.neon.tech`, database `parkdex_kip`). No production database, channel or host was touched, and no map pointer changed.

## What was loaded

| | Count |
| --- | ---: |
| Provincial parks | 109 |
| National parks | 3 (Cape Breton Highlands, Kejimkujik, Sable Island) |
| **New parks** | **112**, all with reader floor 3 |
| Parts / holes / positions | 395 / 119 / 123,863 |

| Region | Provincial | National |
| --- | ---: | ---: |
| Bay of Fundy and Annapolis Valley | 19 | 1 (Kejimkujik) |
| Cape Breton Island | 20 | 1 (Cape Breton Highlands) |
| Eastern Shore | 15 | |
| Halifax Metro | 11 | 1 (Sable Island) |
| Northumberland Shore | 23 | |
| South Shore | 14 | |
| Yarmouth and Acadian Shores | 7 | |

## Results

| Step | Result |
| --- | --- |
| Import plan | `ready`, no blockers, 112 `insert-park` changes, all at reader floor 3, at revision 161. Plan SHA-256 `8a1ff5f0fc2d52ceb74f5e8d5a0741bd2c5d11a84d485cd8da50466d0271fa08`. Every plan row's polygon, hole and position count matches `comparison-report.json`. |
| Import apply | `applied` as content revision **162** in 33 s. Revision 162 holds exactly 112 park, 112 boundary and 112 drive upserts, all Nova Scotia IDs. |
| Catalogue release | Version **`c2c9882db946e593c90c5410fa6814a4df07afffe9e9b08cfd2316153f7629ee`**, revision 162: 1,168 parks, index 728,040 bytes, 24 boundary chunks, 10,782,511 bytes in all, largest 524,098 bytes. |
| Upload and CDN | 26 objects (11,522,861 bytes) uploaded and verified; `verify-cdn` got 200 and the right hash for all 26. |
| Staging pointer | Dry run, then `--apply`: `cd7e13ec…` (revision 160) → `c2c9882d…` (revision 162), 0 changes to replay. |
| OSM, BC refresh | Plan `9c9493d4429aa86763a9f5a4c216ade98e1d454c3d8fa5d81be045d88fbf37e7`, `replaced`, 13,856 → 13,818 rows (2026-10-07 → 2026-10-12 extract). |
| OSM, Nova Scotia | Plan `89221e97e86cb71b486a12ea9e39aa622faf9e8bcca7b105ed0cc5a1abc8e39f`, `replaced`, 2,355 rows (1,720 named), `otherSources {bc: 13818}`, `sharedWithOtherSources {}`. |

The release has 1,168 parks, one fewer than the bundle's projection of 1,169. The difference is `proposed-bell-park-2f66`. It was hidden at revision 161 (a community park), after the old release was built at revision 160, so the new release correctly leaves it out. Apart from that park, every existing park row in the index is identical to the old release, the 112 added IDs are exactly `park-ids.txt`, and the map pointer and drive hubs in the index are unchanged.

### Row counts before and after

| | Before | After |
| --- | ---: | ---: |
| Content revision | 161 | 162 |
| `public.parks` | 1,607 | 1,719 |
| by category | community 80, municipal 534, national 7, provincial 693, regional 293 | community 80, municipal 534, national **10**, provincial **802**, regional 293 |
| `public.boundaries` | 1,607 | 1,719 |
| Reader floor 3 rows | 1,273 | 1,385 |
| Catalogue pointer | `cd7e13ec…`, revision 160, 1,057 parks | `c2c9882d…`, revision 162, 1,168 parks |
| `content_map` | `54c37487…` | `54c37487…` (unchanged) |
| OSM `bc` | 13,856 rows (8,741 named), 2026-10-07 | 13,818 rows (8,742 named), 2026-10-12 |
| OSM `nova-scotia` | none | 2,355 rows (1,720 named), 2026-10-12 |
| `kip_osm.parks` table | 16,982,016 bytes | 36,274,176 bytes right after the loads; autovacuum ran at 09:23 UTC with 0 dead rows |

Neither BC outline that the refresh removes (`relation/7119801` North Hoy Creek Park, `way/53785332` Jericho Beach Public Tennis & Pickleball Courts) was a park on staging, and no park on staging had been founded.

## Verification

- **BC unchanged.** Only Nova Scotia IDs changed at revision 162. The non-Nova Scotia category counts are the same before and after. The BC OSM rows stayed at 13,818 through the Nova Scotia load.
- **Readers 1 and 2.** `/api/content/snapshot` still serves 333 parks in 1,704,623 and 1,750,933 bytes, byte for byte the same as before the load (no Nova Scotia park). That leaves 2.49 and 2.44 MB under 4 MiB. Reader 2's change feed after 161 is a 607-byte no-op hub batch.
- **Reader 3.** The snapshot returns the new pointer (`parkCount` 1,168, `indexBytes` 728,040), and the index answers 200. A reader 3 install that is behind gets revision 162 as one 3,199,486-byte change batch, 994,818 bytes under 4 MiB. A browser profile that was synced to 161 took that batch (HTTP 200) on its next open.
- **Validators.** A temporary vitest test (not committed) downloaded the index and all 24 chunks from the CDN and checked each file's size and SHA-256. It assembled the catalogue with the app's reader (`parseCatalogueIndex`, `parseCatalogueChunk`, `assembleCatalogueSnapshot`) and ran every one of the 1,168 parks through the claim path, `freezeParkSnapshot` then `validateParkSnapshot`, with 0 failures. It also parsed the live reader 1 snapshot with the current and strict v1 readers and the reader 2 snapshot with the current reader.
- **Boundaries.** For all 112 parks, the loaded boundary's polygon, hole and position counts match `comparison-report.json`. Using the app's `insideBoundary` on the CDN copies, all 112 pins are inside, all 57 secondary-part probes are inside (including Kejimkujik Seaside) and all 37 hole probes are outside. Kejimkujik has 2 parts.
- **`/api/osm/parks` on staging.** Halifax Public Gardens (44.6427, -63.5822) returns `way/3813085`. The geometry now comes from the table: 7 positions, the same as the slim file; before the load, Nominatim answered with 9. Point Pleasant Park returns `relation/6707202`. At Kejimkujik's pin, `relation/15670732` and `relation/17520507` come back with `inCatalogue` set to `national-kejimkujik-national-park-and-national-historic-site`, so the app offers "Become the founder".
- **Web app** (`staging.web.parkdex.app`, signed out, phone viewport). Search finds "Kejimkujik", and its sheet shows "National Park · Bay of Fundy and Annapolis Valley" and 404 km². Search finds "Crystal Crescent Beach", which shows "Provincial Park · Halifax Metro" and 5.4 km². The map draws Kejimkujik's boundary over detailed tiles. The console shows only the signed-out 401s.

### Not checked here

Hosted builds have no location override: demo tools (teleport, simulated trips) exist only in dev builds (`src/lib/demo.ts`), and there is no `?at=` parameter. So these need the operator with a phone, or a local dev build:

- planting a flag at a Nova Scotia park
- My Dex grouping it under Nova Scotia (#174)
- "Found a park" inside a Nova Scotia outline that is not in the catalogue
- an offline map download in Halifax, and the first-launch test (`docs/learnings/map-first-launch.md`)

### Finding: parts of large parks far from the pin are offered as new parks

`/api/osm/parks` matches outlines to catalogue parks only among parks whose **pin** is within 5 km of the player (`CATALOGUE_MATCH_KM`, `nearbyParks` in `worker/proposalReview.ts`). At Kejimkujik Seaside, about 71 km from Kejimkujik's pin, the API returns "Kejimkujik National Park Seaside" (`relation/17790005`, `way/342211953`) and "St. Catherines River" with `inCatalogue: null`. A player there would be offered them as **new** parks, even though the point is inside the catalogue park. The probe at (43.85124, -64.82927) shows this on staging now.

The same check over the Nova Scotia slim file finds 8 named outlines that sit inside a Nova Scotia catalogue park but more than 5 km from its pin:

- Kejimkujik: Seaside ×2 and St. Catherines River (71 to 73 km away), and the inland relation 15670732 (11 km)
- Sable Island: Sable Island National Park Reserve and Sable Island Migratory Bird Sanctuary (15 km)
- Cole Harbour - Lawrencetown: Atlantic View Regional Trail Park and Conrods and Lawrencetown (5.5 km)

Whether one of these is offered depends on where the player stands. Fixing it means a search that also matches by boundary, which is a code change outside this load.

## Commands

From the checkout at `7202a49`, in a shell with every `PG*` variable cleared and `DATABASE_URL` set to the staging URL from `parkdex-kip.env`. A wrapper refused any branch other than `br-odd-paper-aktgtidp` and any host other than staging's. Output files went to the workspace `.codex/ns-staging-load/`.

```powershell
$H = "ep-shiny-cherry-akobwdis.c-3.us-west-2.aws.neon.tech"
$bundle = "database/imports/ns-20261013"
$S = "C:\repo\parkdex-workspace\.codex\tmp\osm-sources"
$OUT = "C:\repo\parkdex-workspace\.codex\ns-staging-load"

python scripts/import_legacy_parks.py plan --source "$bundle/boundaries.geojson.gz" --park-id-file "$bundle/park-ids.txt" --catalogue-source "$bundle/catalogue.json" --new-park-review "$bundle/new-park-review.json" --minimum-reader 3 --target-host $H --target-environment staging --out $OUT\staging-plan.json
python scripts/import_legacy_parks.py apply --plan $OUT\staging-plan.json --reviewed-plan-sha 8a1ff5f0fc2d52ceb74f5e8d5a0741bd2c5d11a84d485cd8da50466d0271fa08 --expected-target-host $H --target-environment staging
python scripts/content_catalogue.py build --out $OUT\staging-release --target-host $H --target-environment staging

# R2 through the delivery loader (CLOUDFLARE_API_TOKEN for this one command)
python C:\Users\n8tew\.codex\private\kip-delivery\with-delivery-env.py <this checkout> -- python scripts/publish_content.py upload --snapshot $OUT\staging-release --account-id 6f0eb57971124f41fadc7897ace74dac --bucket parkdex-kip-content --report $OUT\staging-upload.json
python scripts/publish_content.py verify-cdn --snapshot $OUT\staging-release --report $OUT\staging-cdn.json

python scripts/content_catalogue.py point --release $OUT\staging-release --expected-target-host $H --target-environment staging
python scripts/content_catalogue.py point --release $OUT\staging-release --expected-target-host $H --target-environment staging --apply

python scripts/osm_park_index.py status --target-host $H
python scripts/osm_park_index.py plan --source "$S\bc-parks.geojsonl" --source-id bc --target-host $H --target-environment staging --out $OUT\plan-osm-bc-staging.json
python scripts/osm_park_index.py apply --plan $OUT\plan-osm-bc-staging.json --reviewed-plan-sha 9c9493d4429aa86763a9f5a4c216ade98e1d454c3d8fa5d81be045d88fbf37e7 --source-id bc --expected-target-host $H --target-environment staging
python scripts/osm_park_index.py plan --source "$S\nova-scotia-parks.geojsonl" --source-id nova-scotia --target-host $H --target-environment staging --out $OUT\plan-osm-ns-staging.json
python scripts/osm_park_index.py apply --plan $OUT\plan-osm-ns-staging.json --reviewed-plan-sha 89221e97e86cb71b486a12ea9e39aa622faf9e8bcca7b105ed0cc5a1abc8e39f --source-id nova-scotia --expected-target-host $H --target-environment staging
python scripts/osm_park_index.py status --target-host $H
```

The slim OSM files matched their manifests (`a45240e6…` for BC, `e8069465…` for Nova Scotia). The bundle's size checks were made against the staging catalogue release `cd7e13ec…`, which was still live, and the readers 1 and 2 snapshots still had the bundle's pinned hashes. So `fetch` and `build` were not re-run.

## Production

Not done. Production needs its own plan against `parkdex-kip-main.env`, its own catalogue release and pointer, and its own OSM loads. Start that only when the operator asks.
