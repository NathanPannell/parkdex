# OpenStreetMap park outlines

"Found a park" finds the parks around the player in our own copy of OpenStreetMap park outlines, `kip_osm.parks`, before it asks any live service. The table holds every public park-like area in each loaded Geofabrik extract (British Columbia and Nova Scotia), so a position inside any mapped park is found in milliseconds, whatever the park is called, even while Overpass and Nominatim are down.

## What is in the table

- Areas tagged `leisure` park, garden, nature_reserve, dog_park, common or recreation_ground; `landuse=recreation_ground`; `boundary` protected_area or national_park. Areas with `access` private or no are left out.
- One row per OSM way or relation: name, kind (the tag that made it park-like), a few tags (name, leisure, boundary, landuse, protect_class, protection_title, operator, access, designation), bounding box, area, source date, the source it was loaded from (`source_id`), and the outline as a GeoJSON MultiPolygon simplified to about 5 m (0.00005 degrees) with every part and hole kept. Every source uses the same filters and simplification.
- `kip_osm.source` has one row per loaded extract, keyed by its source ID: the data date, SHA-256, file name and the number of outlines it holds.

### Sources

| Source ID | Geofabrik extract |
| --- | --- |
| `bc` | `north-america/canada/british-columbia-latest.osm.pbf` (about 1.2 GB) |
| `nova-scotia` | `north-america/canada/nova-scotia-latest.osm.pbf` (about 100 MB) |

A source ID is a short lowercase label (`^[a-z0-9][a-z0-9-]{0,39}$`); add a row here when you add a province. Loading one source replaces only that source's outlines, and an older extract is refused per source, so British Columbia and Nova Scotia can be refreshed independently. Refresh them in the same release anyway, so their dates stay close.

An OSM way or relation is one row whichever extract carries it. Extracts overlap a little at provincial borders, so a later source can carry an outline that an earlier one already holds. That outline stays with the source that loaded it first: `plan` and `apply` report it as `sharedWithOtherSources`, and it is not counted in the later source's rows.

The migrations are `database/migrations/osm_parks_001_init.sql` and `osm_parks_002_sources.sql`. The second adds `source_id`, backfills every earlier outline to `bc` and keys `kip_osm.source` by source. It also drops the old `singleton` column, so a loader from before several sources fails instead of deleting every province's outlines. The table needs no PostGIS: the API narrows by bounding box in SQL and does the exact containment and distance test in `worker/osmParks.ts`.

## How the search uses it

`GET /api/osm/parks` asks the table for outlines whose box comes within 1 km of the position, keeps those that contain it within the location accuracy (10 to 35 m), marks parks already in Parkdex with their founder, and returns up to 8. Only when the table has no outline at all within 1 km, or cannot be read, does it fall back to Nominatim and then Overpass. The outline fetch when a park is founded (`POST /api/parks/found`, `docs/park-founders.md`) reads the table first too. The operator dashboard's "Approve and publish" reads the table of the database it is switched to.

## Refresh the table

The operator runs these from a trusted checkout. CI never needs pyosmium or the extract.

Run these steps once per source. The examples load Nova Scotia; for British Columbia use `bc` and its extract.

1. Download the Geofabrik extract:

   ```powershell
   curl.exe -L -o nova-scotia-latest.osm.pbf https://download.geofabrik.de/north-america/canada/nova-scotia-latest.osm.pbf
   ```

2. Build the slim file and its manifest, which records the source ID. This needs pyosmium and Shapely (`pip install osmium shapely`). Nova Scotia takes under a minute and British Columbia about two. The data date comes from the extract header; the output is sorted, so the same extract always gives the same file.

   ```powershell
   python scripts/osm_park_index.py extract --pbf nova-scotia-latest.osm.pbf --source-id nova-scotia --out nova-scotia-parks.geojsonl
   ```

3. Plan against each database. `plan` only reads. It checks the connected host against `--target-host` and the source ID against the manifest. It prints `action` (`replace`, `noop` for the extract already loaded for that source, or `blocked` for an extract older than that source's loaded one), the other sources it leaves alone, any `sharedWithOtherSources`, and `planSha256`.

   ```powershell
   $env:DATABASE_URL = '<target database URL>'
   python scripts/osm_park_index.py plan --source nova-scotia-parks.geojsonl --source-id nova-scotia --target-host <host> --target-environment staging --out osm-parks-nova-scotia-staging-plan.json
   ```

4. Review the plan, then apply it. `apply` checks the plan SHA-256, the source ID, the host, the slim file's SHA-256 and that this source has not changed in the table since the plan. It then replaces that source's outlines and its source record in one transaction. Other sources' outlines are not touched, and the result lists their row counts. Applying again is a no-op.

   ```powershell
   python scripts/osm_park_index.py apply --plan osm-parks-nova-scotia-staging-plan.json --reviewed-plan-sha <planSha256> --source-id nova-scotia --expected-target-host <host> --target-environment staging
   ```

5. Check every source with `status`, which only reads:

   ```powershell
   python scripts/osm_park_index.py status --target-host <host>
   Remove-Item Env:DATABASE_URL
   ```

Repeat steps 3 to 5 for production with `--target-environment production`.

A reloaded source leaves dead rows until autovacuum runs, so `tableBytes` right after a reload can be about twice the live size.

## Tests

- `scripts/test_osm_park_index.py` (content Python tests): filters, validation, source IDs and plans; the extract on `scripts/fixtures/osm-parks-mini.osm` when pyosmium is installed. With `OSM_PARKS_TEST_DATABASE_URL` set, against loopback PostgreSQL: the BC backfill, the load, sources that replace only their own outlines, and the per-source older-extract guard.
- `scripts/qa-osm-parks-sql.mjs` (`npm run test:sql`): both migrations and their replay, and the API's table search with every live service off, in British Columbia and in Halifax.
- `worker/osm-park-table.test.ts`: the table query, table first, fall-through and the outline fetch.
