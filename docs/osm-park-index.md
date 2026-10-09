# OpenStreetMap park outlines

"Propose a park" finds the park around a pin in our own copy of OpenStreetMap park outlines, `kip_osm.parks`, before it asks any live service. The table holds every public park-like area in the British Columbia extract, so a pin inside or near any mapped park is found in milliseconds, whatever the park is called, even while Overpass and Nominatim are down.

## What is in the table

- Areas tagged `leisure` park, garden, nature_reserve, dog_park, common or recreation_ground; `landuse=recreation_ground`; `boundary` protected_area or national_park. Areas with `access` private or no are left out.
- One row per OSM way or relation: name, kind (the tag that made it park-like), a few tags (name, leisure, boundary, landuse, protect_class, protection_title, operator, access, designation), bounding box, area, source date, and the outline as a GeoJSON MultiPolygon simplified to about 5 m (0.00005 degrees) with every part and hole kept.
- `kip_osm.source` names the loaded extract: its data date, SHA-256, file name and row count.

The migration is `database/migrations/osm_parks_001_init.sql`. It needs no PostGIS: the API narrows by bounding box in SQL and does the exact containment and distance test in `worker/osmParks.ts`.

## How the search uses it

`GET /api/osm/parks` asks the table for outlines whose box comes within 1 km of the pin, keeps those that contain the pin or whose outline is within 1 km, marks parks already in Parkdex, and returns up to 8. Only when the table has nothing near the pin, or cannot be read, does it fall back to Nominatim and then Overpass. The outline fetch when a proposal is sent reads the table first too. The operator dashboard's "Approve and publish" reads the table of the database it is switched to.

## Refresh the table

The operator runs these from a trusted checkout. CI never needs pyosmium or the extract.

1. Download the Geofabrik extract (about 1.2 GB):

   ```powershell
   curl.exe -L -o british-columbia-latest.osm.pbf https://download.geofabrik.de/north-america/canada/british-columbia-latest.osm.pbf
   ```

2. Build the slim file and its manifest. This needs pyosmium and Shapely (`pip install osmium shapely`) and takes a few minutes. The data date comes from the extract header; the output is sorted, so the same extract always gives the same file.

   ```powershell
   python scripts/osm_park_index.py extract --pbf british-columbia-latest.osm.pbf --out bc-parks.geojsonl
   ```

3. Plan against each database. `plan` only reads. It checks the connected host against `--target-host` and prints `action` (`replace`, `noop` for the extract already loaded, or `blocked` for an extract older than the loaded one) and `planSha256`.

   ```powershell
   $env:DATABASE_URL = '<target database URL>'
   python scripts/osm_park_index.py plan --source bc-parks.geojsonl --target-host <host> --target-environment staging --out osm-parks-staging-plan.json
   ```

4. Review the plan, then apply it. `apply` checks the plan SHA-256, the host, the slim file's SHA-256 and that the table has not changed since the plan, then replaces every row and the source record in one transaction. Applying again is a no-op.

   ```powershell
   python scripts/osm_park_index.py apply --plan osm-parks-staging-plan.json --reviewed-plan-sha <planSha256> --expected-target-host <host> --target-environment staging
   Remove-Item Env:DATABASE_URL
   ```

Repeat steps 3 and 4 for production with `--target-environment production`.

## Tests

- `scripts/test_osm_park_index.py` (content Python tests): filters, validation, plans; the extract on `scripts/fixtures/osm-parks-mini.osm` when pyosmium is installed; the load against loopback PostgreSQL when `OSM_PARKS_TEST_DATABASE_URL` is set.
- `scripts/qa-osm-parks-sql.mjs` (`npm run test:sql`): the migration and the API's table search with every live service off.
- `worker/osm-park-table.test.ts`: the table query, table first, fall-through and the outline fetch.
