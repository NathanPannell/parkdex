# CDN content catalogue

The app and the content API both refuse a response over 4 MiB, so one snapshot cannot carry a catalogue of about 1,600 parks (about 10 MB, mostly boundaries). Newer app builds load the whole catalogue from immutable files on the CDN instead, while builds installed before this change keep the small snapshot they read today.

## How it works

| Piece | Where | What it does |
| --- | --- | --- |
| Reader floor | `public.content_park_reader_floor` (`content_004_catalogue_release.sql`) | A park with a row here is left out of `/api/content/snapshot` and `/api/content/changes` for readers below `minimum_reader`, with its boundary and drive rows. Every park stays in `public.parks`, so the game's park check and published proposals keep working. |
| Catalogue pointer | `public.content_catalogue` | One row naming the current CDN release: its version, the content revision it was built at, and the index URL, SHA-256 and size. |
| Release files | `releases/<version>/catalogue/` on `kip-assets.parkdex.app` | `index.json` holds every park, the drive data, scene descriptors, the map pointer and a list of boundary chunks. `boundaries/NNN.json` hold the boundaries, about 512 KiB each, grouped by 2-degree area. The version is the SHA-256 of `index.json`, which names every chunk by hash. |

Neither new table has content triggers, so changing them emits no content revision. Hidden parks (`docs/park-visibility.md`) are left out of every release.

### What each reader gets

- **Readers 1 and 2** (every build installed before this change): `snapshot` and `changes` as before, without floored parks. A change batch whose every change is a floored park arrives as an upsert of the unchanged hub list, because readers reject empty batches and applying the same hubs is a no-op.
- **Reader 3** (this build, `CONTENT_READER_VERSION = 3`): `snapshot?reader=3` returns `{ schema, revision, catalogue: { schema, version, indexUrl, indexSha256, indexBytes, parkCount } }` while a pointer exists, its revision is not ahead of the database, and the changes feed still covers everything after it (`retention_floor <= revision`). The app downloads the index and the chunks near the player over any connection (see below), checks each file's size and SHA-256, puts boundaries back in park order and validates the result exactly like an API snapshot. Then it applies `/api/content/changes?after=<release revision>` as usual, so parks published after the release (proposals, corrections) still arrive. Without a usable pointer, reader 3 gets one snapshot body, which fails with 503 once the full catalogue is over 4 MiB.
- A reader 3 build that is already synced and is behind a batch over 4 MiB (such as a large import) gets HTTP 413 from `changes` and takes a fresh snapshot, which is the CDN release.

### Only the boundaries near the player stay on the device

Parkdex needs the internet for now, so a reader 3 build keeps a lean catalogue (`src/lib/content/leanCache.ts`):

- Every park, drive time and badge descriptor from the index stays on the device (about 1 MB), so search, pins and the nearby list work as before.
- Only the boundary chunks holding a park within 50 km of the player download with the index. Chunks are picked by their parks, not their bounding boxes, because some chunks span the country.
- Other chunks load when the player zooms the map in on them (zoom 8 or more, at most 3 per view) or opens one of their parks. Loaded chunks are kept least recently used first and evicted above 3 MB; nearby chunks are never evicted. Park guides stay under 5 MB.
- The stored state remembers the release's chunk list (`catalogue` in `ContentSyncState`, a `catalogue` sync row). A boundary that arrives through `changes` after the release is pinned and never evicted, because the release only has the older copy.
- Builds before this one read a lean cache as incomplete and fetch one fresh snapshot, so rolling back an over-the-air bundle is safe.

A catalogue that came as one API snapshot (no pointer) is kept whole, as before.

### Old content is cleaned up after an update

When the app bundle (web deploy, over-the-air bundle or Play build) or the pinned map changes, the first sync after the update replaces a catalogue saved whole with a lean one and then deletes data that belongs to old releases: the first-format release and its files, older map inventories and their chunks, saved map squares, map detail that is not around the player and badge art that is not near the player or claimed. Retained and archived badges, claims, photos, the account and the personal store are never touched. Every step can be repeated; a marker (`parkdex-cache-generation-v1`) is written only when all of them finish, so an interrupted cleanup runs again on the next start.

## Publish a release

A release is built from one database at one revision, so build it after the parks it should carry are in that database, and build one per environment.

1. Apply the content change (for example, an import with `--minimum-reader 3`).
2. Build the release. It only reads.

   ```powershell
   python scripts/content_catalogue.py build --out ..\..\content-catalogue\staging --target-host <host> --target-environment staging
   ```

3. Upload it with the existing uploader, which never overwrites a different object and uploads the manifest last, then check the public copy:

   ```powershell
   python scripts/publish_content.py upload --snapshot ..\..\content-catalogue\staging --account-id 6f0eb57971124f41fadc7897ace74dac --bucket parkdex-kip-content --report ..\..\content-catalogue\staging-upload.json
   python scripts/publish_content.py verify-cdn --snapshot ..\..\content-catalogue\staging --report ..\..\content-catalogue\staging-cdn.json
   ```

4. Point readers at it. Without `--apply` this reports what would change. With it, the tool checks every local file, fetches every file from the CDN and compares hashes, checks that the connected database is the one the release was built from and that the change history still covers it, and writes the pointer in one transaction. A replay is a no-op.

   ```powershell
   python scripts/content_catalogue.py point --release ..\..\content-catalogue\staging --expected-target-host <host> --target-environment staging
   python scripts/content_catalogue.py point --release ..\..\content-catalogue\staging --expected-target-host <host> --target-environment staging --apply
   ```

No channel pointer changes: `channels/<env>/current.json` still names the asset release, and the catalogue pointer lives in the database next to the content clock.

Build a new release when the changes after the current one grow large (every reader 3 install replays them on first sync), and always before running `prune_content_changes()` past the pointer's revision, because the API falls back to one snapshot body once the history no longer covers the release.

## Tests

- `worker/content_sync.test.ts`: pointer responses, fallbacks and the no-op hub batch.
- `scripts/test_content_catalogue.py`: deterministic, content-addressed releases, chunk sizes and the uploader layout.
- `scripts/qa-content-catalogue-sql.mjs` (part of `npm run test:sql`): floors in the real SQL, the builder and pointer tool against PostgreSQL, and the app's reader assembling the release.
- `src/lib/content/runtime.test.ts`: the app loading a release, refusing a tampered chunk, keeping only nearby boundaries, loading others on demand and cleaning up old content after an update.
- `src/lib/content/leanCache.test.ts`: nearby selection, the LRU cap and the cleanup rules.
- `src/lib/content/catalogue-release.test.ts`: the legacy BC release against the claim and account validators and both readers.
