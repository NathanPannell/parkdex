# Keep every content response under 4 MiB

Recorded: 2026-10-08. Applies to: catalogue imports, park proposals and any change that adds parks or boundaries (`worker/content_sync.ts`, `src/lib/content/transport.ts`, `docs/content-catalogue.md`).

## What went wrong

The legacy BC import planned to add 1,273 parks. Their boundaries alone are about 7.6 MB, which would have pushed `/api/content/snapshot` to about 10 MB. The server refuses a snapshot over 4 MiB with a 503, and every installed build also rejects a content response over 4 MiB. A fresh install would have got no catalogue, and existing installs would have stopped updating. Nothing in the import tooling checked the size.

## Rule

Before any change that adds parks or boundaries, project the snapshot size that each reader version gets, for staging and production, and keep at least 512 KiB of headroom for readers 1 and 2. Parks that do not fit go to newer readers only, with a reader floor (`--minimum-reader 3`) and a CDN catalogue release (`scripts/content_catalogue.py`). Do not raise the limit on the server alone: installed builds keep their own 4 MiB limit. Keep each catalogue file well under 4 MiB too.

## How to check

`python scripts/test_build_bc_import.py` checks the projected sizes in the BC bundle manifest. `src/lib/content/catalogue-release.test.ts` serves the older catalogues through the real snapshot handler and fails if either is over 3.5 MiB. For a dry run, import into a local database, serve the snapshot through `createSnapshotHandler` at each reader version and measure the body; `scripts/content_catalogue.py build` prints the index and chunk sizes.

## History

- 2026-10-08: created.
- 2026-10-08: reader floors and the CDN catalogue replaced splitting the import by region.
