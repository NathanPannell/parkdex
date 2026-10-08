# Legacy park import

To add one new park at a time, use the operator dashboard's Import from map page instead ([operator/README.md](../operator/README.md)). It creates a hidden draft and publishes it when you are ready. This script remains the tool for reviewed batch imports and boundary repairs.

`scripts/import_legacy_parks.py` imports reviewed legacy boundary features into the synchronized Parkdex database. Planning reads a local GeoJSON file or an HTTPS URL and reads the target database. Planning does not write to the database. Applying is database only and does not write to R2.

Install the database tools and pinned geometry validator:

```powershell
python -m pip install -r database/requirements.txt
```

Set `DATABASE_URL` in the process environment. Always supply the exact connected database host and an environment label. Select source park IDs explicitly. The default boundary source is the public staging legacy boundary file.

The pinned issue 20 repair input is `database/imports/legacy-boundaries-20260928/boundaries.geojson`. Its manifest records the full source export and subset hashes, GIS source IDs, geometry counts, and the reason each park was selected. For a fresh database, first use the existing reset process with its historical seed unchanged. Then create and review a separate repair plan from this committed geometry-only input and apply it as a second operation.

```powershell
python scripts/import_legacy_parks.py plan `
  --source database/imports/legacy-boundaries-20260928/boundaries.geojson `
  --park-id municipal-district-of-saanich-244 `
  --target-host 127.0.0.1 `
  --target-environment local-qa `
  --out .codex\legacy-park-import\review-plan.json
```

Repeat `--park-id` for each selected source feature, or pass `--park-id-file` with one stable ID per line for large batches (blank lines and `#` comments are ignored). A `--source` file ending in `.gz` is read decompressed and pinned by its stored bytes. `--minimum-reader N` gives every new park a content reader floor, written in the same transaction, so readers below `N` never receive it (`docs/content-catalogue.md`). Add `--id-map old-id:new-id` only for an explicit source to target ID mapping. Mapping changes the boundary feature ID; it never renames a database park.

The plan output reports its SHA, target identity, selected count, readiness, and blockers. The JSON plan records the full desired public feature, legacy source feature IDs and provenance, polygon and hole counts, position count, bounding box, prior target geometry summary and hash, source SHA values, target database identity, and synchronized content revision. The desired public feature contains exactly `properties.id` and `properties.biome`. Source provenance remains in the plan.

Review every selected park's stable ID, grouped source feature IDs, polygon count, hole count, position count, source and prior target bounding boxes, and the embedded desired coordinates. If a target park does not exist, planning records the missing inputs and returns a blocked plan until both the legacy places catalogue and new park review JSON are provided.

For a new park, the review file has this shape. `presentation` must provide `short`, `biome`, `shape`, `rarity`, `seed`, and `blurb`; `scene` defaults to null. `walkM` and `drive` are required. Drive entries follow the current ordered target hubs. A route is `[distanceKm, durationMin]` or `null`. At least one route must be reviewed unless access is explicitly unknown. For unknown access, set `accessUnknown` to `true`, `walkM` to `0`, and every drive entry to `null`. This paired value is the existing database and client sentinel for unknown access. The importer rejects a nullable or negative walk distance, rejects all-null drive values without the explicit review key, and rejects mixed values when `accessUnknown` is true. It never supplies an access default. `accessUnknown` is review metadata and is not stored in the drive row or sync payload. New park snapshots also satisfy the account backup contract: bounded text fields, no disallowed control characters, a safe integer seed from 0 to 1,000,000, and supported catalogue enum values.

```json
{
  "parks": {
    "legacy-stable-id": {
      "presentation": {
        "short": "Reviewed short name",
        "biome": "coast",
        "shape": "hex",
        "rarity": "common",
        "seed": 812,
        "blurb": "Reviewed park description."
      },
      "walkM": 24,
      "drive": [[18.2, 23], [14.5, 18], null]
    }
  }
}
```

Use the explicit sentinel when the walk and driving routes have not been verified:

```json
{
  "parks": {
    "legacy-stable-id": {
      "presentation": {
        "short": "Reviewed short name",
        "biome": "coast",
        "shape": "hex",
        "rarity": "common",
        "seed": 812,
        "blurb": "Reviewed park description."
      },
      "accessUnknown": true,
      "walkM": 0,
      "drive": [null, null, null]
    }
  }
}
```

For existing parks, rarity changes require a separate reviewed input so boundary-only plans keep their existing behavior. The JSON file keys each selected source park ID and supplies its desired rarity. An optional rationale is recorded in the plan. The input file hash is pinned and rechecked during apply.

```json
{
  "parks": {
    "legacy-stable-id": {
      "rarity": "uncommon",
      "rationale": "Reviewed against the regional rarity scale."
    }
  }
}
```

Pass it to planning with `--rarity-review .codex\legacy-park-import\rarity-review.json`. A string value such as `"uncommon"` is also accepted when no rationale is needed. Object values must include both rarity and a non-empty rationale. Each existing-park plan records its expected current rarity and reviewed desired rarity. Apply changes only that rarity field, preserving name, text, scene, drive rows, and art. If the rarity is already current, exact replay remains a no-op. A stale rarity fails the plan guard. Before a real rarity update, the importer locks the authoring rollout row and rejects affected parks that have selected art which is not yet published.

Apply only after review. Copy the `planSha256` value printed by planning into `--reviewed-plan-sha`, and repeat the same expected host and environment. The importer verifies the plan digest and re-reads every source to confirm its hash. It then locks and checks target identity, content revision, and each prior boundary hash before making changes in one transaction.

```powershell
python scripts/import_legacy_parks.py apply `
  --plan .codex\legacy-park-import\review-plan.json `
  --reviewed-plan-sha <planSha256> `
  --expected-target-host 127.0.0.1 `
  --target-environment local-qa
```

Boundary-only existing-park imports update only the boundary row. Existing-park imports with reviewed rarity changes update the boundary and rarity rows while preserving all other park metadata, badge art, drive data, and private tables. New park imports insert the reviewed catalogue identity, presentation fields, boundary, walk distance, and all hub positions in the same transaction. PostgreSQL's content triggers validate the resulting catalogue and emit one synchronized revision.

Exact replay is a no-op, including when the database has a newer content revision, if every selected desired boundary, reviewed rarity, and any new park and drive rows already match. Any partial drift, changed source, changed old boundary or rarity, revision mismatch, or target identity mismatch requires a new plan. Invalid topology, malformed positions, missing or duplicate selected IDs, and non-2D coordinates fail before the database write.

The importer uses Shapely only to validate topology. It wraps Polygon coordinates as a one-part MultiPolygon and preserves source polygon order, every ring, and every XY position without simplification or repair.

Run the unit tests with:

```powershell
python scripts/test_import_legacy_parks.py
```

The PostgreSQL integration test runs only when `LEGACY_IMPORT_TEST_DATABASE_URL` (or the compatibility alias `PARKDEX_LEGACY_IMPORT_TEST_DATABASE_URL`) points to a disposable database named `kip_qa_issue20_*` or `kip_qa_legacy_import_*` on loopback. It applies its own schema, seeds its own rows, and exercises boundary updates, new park insertion, rarity preservation and replay, stale rarity rejection, frozen-art rejection, replay after a newer revision, target drift rejection, and transaction rollback.
