# Catalogue migrations

`data/places.json` is the canonical active catalogue. `data/seed-migration.txt` points to the latest append-only SQL snapshot, and CI verifies the two match with:

```sh
python scripts/build_seed_migration.py --check
```

For a source refresh after v0 has deployed, rebuild and validate the JSON, then create a new numbered migration:

```sh
python scripts/build_seed_migration.py --new 0005_refresh_places.sql
```

Never edit an applied migration. `--replace-unreleased` exists only for the initial migration before its first deployment.

Each snapshot retires records missing from the new catalogue by setting `active = FALSE`, then upserts current records as active. Retired places leave the public catalogue and progress totals, while their visit rows remain. If a sourced place returns later under the same stable ID, its earlier checkoff returns with it.
