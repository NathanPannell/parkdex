# Keep the whole content snapshot under 4 MiB

Recorded: 2026-10-08. Applies to: catalogue imports, park proposals and any change that adds parks or boundaries (`worker/content_sync.ts`, `src/lib/content/transport.ts`).

## What went wrong

The legacy BC import planned to add 1,273 parks. Their boundaries alone are about 7.6 MB, which would push `/api/content/snapshot` to about 10 MB. The server refuses a snapshot over 4 MiB with a 503, and every installed build also rejects a content response over 4 MiB. A fresh install would get no catalogue, and existing installs would stop updating. Nothing in the import tooling checked the size.

## Rule

Before any change that adds parks or boundaries, project the snapshot size for both staging and production at reader 1 and reader 2, and keep at least 512 KiB of headroom. A single import batch must also fit one changes response. If a change does not fit, split it, or wait for a content sync change that serves larger catalogues to newer readers. Do not raise the limit on the server alone: installed builds keep their own 4 MiB limit.

## How to check

`python scripts/test_build_bc_import.py` checks the projected sizes recorded in the BC bundle manifest. `src/lib/content/catalogue-release.test.ts` serves the projected staging and production catalogues through the real snapshot and changes handlers and fails if either is over 3.5 MiB. For a dry run, serve the snapshot from a local database through `createSnapshotHandler` and measure the body.

## History

- 2026-10-08: created.
