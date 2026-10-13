# Nova Scotia park import

`database/imports/ns-20261013/` adds Nova Scotia's provincial and national parks: 109 provincial parks and 3 national parks, 112 in all. It is review input for `scripts/import_legacy_parks.py`, in the same shape as the legacy BC bundle (`docs/import-legacy-bc-parks.md`). Building it makes no database, R2 or provider change. Loading it into staging is issue #182.

Every new park gets content reader floor 3 (`--minimum-reader 3`). Without the floor, readers 1 and 2 would get a snapshot of about 4.9 MB, over the 4 MiB that the content API and every installed build accept (`docs/learnings/content-snapshot-size.md`).

## Sources

`sources/fetch-record.json` pins the URL, retrieval time, size and SHA-256 of every source. The raw downloads, about 100 MB (mostly municipality boundaries and the two live catalogues), stay outside the repository.

| Source | Used for |
| --- | --- |
| Nova Scotia Parks and Protected Areas System (`Nova_Scotia_Parks_and_Protected_Areas_System_V1`, layer 1), published by Nova Scotia Environment and Climate Change | Provincial park outlines: features with `PROT_TYPE` "Provincial Park", designated under the Provincial Parks Act and managed by Natural Resources and Renewables. Also the Sable Island outline. |
| NRCan Canada Lands Survey System, `CLSS_Administrative_Boundaries` layer 1, `jurisdiction='NS'` | Cape Breton Highlands and Kejimkujik (inland and Seaside) legislative boundaries |
| Parks Canada park finder | National park pins and names |
| Nova Scotia open data: Provincial Day-use and Camping Park Entrances (`c6mf-qy4u`) | Official provincial pins, when an entrance lies inside the outline |
| Nova Scotia open data: Municipality Boundaries (`7bqh-hssn`) | The county of each pin |
| Nova Scotia open data: Topographic Database delimiters (`k3u4-5mnw`), names only | An independent check that no provincial park is missing |
| Parkdex staging and production snapshots (readers 1, 2 and 3) and both CDN catalogue releases | ID clash, overlap and size checks |

The Nova Scotia open data portal has no separate provincial parks boundary layer. Its "Nova Scotia Protected Areas System" (`ticv-5du5`, April 2024) holds only 24 provincial parks. The province's Parks and Protected Areas System layer above is the current official copy, with all 121 Provincial Parks Act features. Its 109 park names match the Topographic Database's provincial park delimiters one for one, apart from eight spellings listed in `scripts/build_ns_import.py`.

Sable Island National Park Reserve has no CLSS legislative boundary, so its outline comes from the provincial layer.

## What is in it

- **Provincial:** 121 features grouped by name into 109 parks. One feature (Bayfield Beach, 6.4e-10 ha) has no geometry; the park keeps its other feature.
- **National:** Cape Breton Highlands (one part, one hole), Kejimkujik (one park with two parts, inland and Seaside) and Sable Island (two parts).
- **Left out:** wilderness areas, nature reserves, land trust properties, national wildlife areas and national historic sites. Thirty entrance points name a provincial park with no Provincial Parks Act outline, such as Point Michaud Beach and Uisge Ban Falls; `selection.json` lists them. They have no boundary to check a visit against.

## Geometry

The provincial layer stores many holes as separate shells ("nested shells"); 24 source features are invalid. Each invalid feature is rebuilt with the planar-face even-odd rule over all its rings: a face is inside when an odd number of rings contain it. The layer's official hectares confirm this reading. For Dalem Lake the union of shells would be 78 ha against the official 47.7 ha, and even-odd gives 47.4 ha. A 576-point grid check per rebuilt feature finds no disagreement with the even-odd rule.

Features of one park stay separate parts. Where they touch or overlap (nine parks, including Sable Island), the park is their union. Coordinates are rounded to seven decimal places (under 1 cm), with no simplification.

`comparison-report.json` has one row per park: source feature IDs, source counts, counts after the repair, output counts, area kept and added, local and official hectares, the pin and how it was chosen, the county and region rule, the Topographic Database name, and probe points in a secondary part and in a hole. For national parks it also compares CLSS with the provincial layer's copy. Every park keeps at least 99.9% of its source area (the smallest parks lose a few square centimetres to rounding), and every park's area is within 2% of the official figure.

## Pins, regions and presentation

- **Pins:** national parks use the Parks Canada finder point. A provincial park uses its official entrance point when one lies inside the outline (3 parks); entrances usually sit a few metres outside, on the road. Otherwise the pin is a point inside the largest part, never the centroid.
- **Regions:** the pin's municipality gives the county, and a pinned table maps counties to the seven regions: Halifax Metro, South Shore, Yarmouth and Acadian Shores, Bay of Fundy and Annapolis Valley, Northumberland Shore, Eastern Shore and Cape Breton Island. Halifax County splits at 63.45° W (Eastern Shore from Lawrencetown on). Colchester and Cumberland split at 45.55° N (Northumberland Strait side and Fundy side). Clare, Barrington and Clark's Harbour belong to the Acadian Shores. Sable Island is in Halifax Metro.
- **Presentation:** as in the BC import. `scene` is null, the badge is a circle, rarity is common, the seed comes from the ID, the biome from a name keyword, and the blurb is a factual line such as "A provincial park on Nova Scotia's South Shore." Access is the explicit unknown sentinel.

## Size

| | Staging (revision 160) | Production (revision 29) |
| --- | ---: | ---: |
| Reader 1 snapshot | 333 parks, 1,704,623 bytes (unchanged) | 351 parks, 1,646,312 bytes (unchanged) |
| Reader 2 snapshot | 333 parks, 1,750,933 bytes (unchanged) | 351 parks, 1,667,723 bytes (unchanged) |
| Reader 3 index now | 1,057 parks, 665,102 bytes | 1,067 parks, 593,140 bytes |
| Reader 3 index with Nova Scotia | 1,169 parks, 728,869 bytes | 1,179 parks, 656,913 bytes |
| Reader 3 boundary chunks with Nova Scotia | 24 files, 10.8 MB, largest 524,098 bytes | 23 files, 10.8 MB, largest 523,825 bytes |

The builder rebuilds each live release from its downloaded index and chunks and gets the live version hash, so the projection uses the real release builder. A reader 3 install that is behind gets the import as one change batch of about 3.2 MB, under the 4 MiB limit with more than 512 KiB to spare.

## Rebuild and test

```powershell
python scripts/build_ns_import.py fetch --raw <folder outside the repository>   # downloads again and rewrites the fetch record
python scripts/build_ns_import.py build --raw <folder>
python scripts/test_build_ns_import.py
$env:NS_IMPORT_RAW_DIR = "<folder>"; python scripts/test_build_ns_import.py NovaScotiaRebuildTests
npx vitest run src/lib/content/catalogue-release.test.ts
```

A fresh `fetch` pins new hashes; the live sources change over time. `build` refuses any raw file whose hash differs from the fetch record, and the rebuild test checks the committed bundle byte for byte. The vitest test runs every Nova Scotia park through the app's claim snapshot check and the account API contract, assembles the reader 3 catalogue with them, serves the import as a change batch, and checks the probe points with the app's containment check.

## Apply (issue #182, staging only)

Use the same steps as the BC import, with this bundle and `--minimum-reader 3`, against the staging host only:

```powershell
$bundle = "database/imports/ns-20261013"
python scripts/import_legacy_parks.py plan --source "$bundle/boundaries.geojson.gz" --park-id-file "$bundle/park-ids.txt" --catalogue-source "$bundle/catalogue.json" --new-park-review "$bundle/new-park-review.json" --minimum-reader 3 --target-host <staging host> --target-environment staging --out <plan.json>
```

Expect `ready`, no blockers and 112 changes. Then apply with the reviewed plan SHA, build the catalogue release, upload it, verify the CDN copy and point staging at it, as in `docs/import-legacy-bc-parks.md`. If the staging catalogue has changed since 2026-10-13, run `fetch` and `build` again first so the ID, overlap and size checks use the current release; review any change in the official sources that this shows.

The staging load on 2026-10-13, with its plan SHA, release ID and counts, is recorded in `docs/import-nova-scotia.md`.
