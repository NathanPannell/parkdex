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
- **Reader 3** (this build, `CONTENT_READER_VERSION = 3`): `snapshot?reader=3` returns `{ schema, revision, catalogue: { schema, version, indexUrl, indexSha256, indexBytes, parkCount } }` while a pointer exists, its revision is not ahead of the database, and the changes feed still covers everything after it (`retention_floor <= revision`). The app downloads the index and every chunk over any connection, checks each file's size and SHA-256, puts boundaries back in park order and validates the result exactly like an API snapshot. Then it applies `/api/content/changes?after=<release revision>` as usual, so parks published after the release (proposals, corrections) still arrive. Without a usable pointer, reader 3 gets one snapshot body, which fails with 503 once the full catalogue is over 4 MiB.
- A reader 3 build that is already synced and is behind a batch over 4 MiB (such as a large import) gets HTTP 413 from `changes` and takes a fresh snapshot, which is the CDN release.

All boundaries are downloaded up front rather than near the map viewport. About 9 MB of chunks compress to roughly a quarter on the CDN, the local store, validation, search, the nearby list and the check-in boundary test stay as they are, and every park is available offline once synced, as before. The chunks carry a bounding box, so loading them by area can be added later without a new release format.

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
- `src/lib/content/runtime.test.ts`: the app loading a release and refusing a tampered chunk.
- `src/lib/content/catalogue-release.test.ts`: the legacy BC release against the claim and account validators and both readers.
