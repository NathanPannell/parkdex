# Kip cloud content baseline

The current bundled content has been copied to a separate Neon database and Cloudflare R2. The Android app and its local content readers are unchanged. This is a one-time baseline import, not a new content publishing system or an account backend.

## Frozen source

- Source: staging commit `0838a3a47e792ce3c65b5b2d3dd52ba65352f327`.
- Content version: `5f0d137050ac8f83a0dd42f98291010577fae75a7538d62127690fd0f7630744`.
- [Public publication manifest](https://kip-assets.parkdex.app/releases/5f0d137050ac8f83a0dd42f98291010577fae75a7538d62127690fd0f7630744/manifest.json).
- The exact same manifest bytes are recorded in `database/content-manifest.json`.

| Existing content | Count |
| --- | ---: |
| Park records, with all 13 existing fields | 122 |
| Complete GeoJSON boundary Features | 122 |
| Live badge scene images | 20 |
| Kip pose and rig artwork | 23 |
| Existing product artwork | 3 |
| Map binary chunks | 46 |
| Map glyph files | 18 |
| Existing map chunk manifest | 1 |
| Park catalog, boundaries, and drive-estimate files | 3 |

There are 114 original files totaling 99,527,167 bytes. R2 contains those files plus the publication manifest: 115 objects and 99,583,413 bytes. Source artwork under `art-source`, build output, executable app code, and the duplicate unchunked map archive are not uploaded.

`src/data/parks.json`, `src/data/drive.json`, `public/boundaries.geojson`, and all tracked `public/art` files are copied without rewriting. The already-downloaded, ignored `public/map` files are used as-is. The import never fetches or rebuilds parks, routes, boundaries, artwork, or basemap data.

## Database

| Setting | Value |
| --- | --- |
| Neon project | `parkdex-kip` / `small-cloud-35890217` |
| Region | `aws-us-west-2` |
| PostgreSQL | 18 |
| Root / default branch | `main` / `br-shy-hat-akg1paip` |
| Staging branch | `staging` / `br-orange-lake-akrxmy23`, child of `main` |
| Database | `parkdex_kip` |
| Owner role | `parkdex_kip_owner` |
| Compute | 0.25 CU, suspend after 300 idle seconds |

The original populated branch was renamed from `staging` to `main`, then a new `staging` branch was created from it. Both branches contain identical schemas and baseline data. Each has its own compute and connection endpoint, with the settings above. Both reference the same immutable R2 content. Full row equality and the branch relationship are recorded in `docs/evidence/cloud-content/neon-branches.json`.

The migration creates exactly four application tables:

- `parks`: the existing `id`, `name`, `short`, `category`, `region`, `lat`, `lng`, `biome`, `shape`, `rarity`, nullable `scene`, `seed`, and `blurb` fields.
- `boundaries`: the park ID and the complete original GeoJSON Feature in JSONB.
- `r2_objects`: logical path, immutable object key, public URL, SHA-256, byte length, and content type. These are file references, not additional park fields.
- `version_manifests`: the content version and its publication manifest. Ordered park and boundary IDs preserve the original array order.

The existing map manifest remains exactly `{"size":95805433,"chunkBytes":2097152,"count":46}` in its original 49-byte file. The separate publication manifest is delivery metadata describing versions, checksums, and file references; it does not change the app's data schema. There are no account, claim, photo, analytics, or new park tables.

## R2 and CDN

- Cloudflare account: `6f0eb57971124f41fadc7897ace74dac`.
- Private R2 bucket: `parkdex-kip-content`, Standard storage, WNAM.
- Dedicated direct-upload Pages project: `parkdex-kip-content` / `2c125c50-821f-46a8-90c6-bf55df12f93e`.
- Public CDN origin: `https://kip-assets.parkdex.app`.
- External DNS: `kip-assets.parkdex.app` CNAME to `parkdex-kip-content.pages.dev`.
- The Pages Worker has only the `CONTENT` R2 binding and exposes GET, HEAD, and OPTIONS for versioned file paths. It has no database binding or credentials.

Objects use `releases/<content-version>/<existing-path>`. Responses preserve MIME types, expose CORS headers, support conditional and range requests, and cache successful complete downloads with `public, max-age=31536000, immutable`. A real edge-cache HIT was verified on the custom hostname. Direct R2 public access is not needed.

This account has no Cloudflare-managed DNS zones. A Pages custom subdomain supports the existing external DNS provider while providing a working Cache API. No nameservers or existing app hosts were changed. There is no Git integration, scheduled process, or automatic deployment workflow for this content service.

## Reproduce and verify

Install the tooling dependencies:

```powershell
python -m pip install -r database/requirements.txt
```

Create a snapshot from the frozen source. Pinning `--source-commit` prevents later tooling commits from changing manifest provenance. Point `--map-source` to the existing map folder containing `island/` and `fonts/`; do not run `npm run map` because that would fetch a newer basemap.

```powershell
python scripts/cloud_content.py snapshot --source-commit 0838a3a47e792ce3c65b5b2d3dd52ba65352f327 --map-source <existing-public-map-directory> --output-dir .codex/cloud-snapshot
```

The generated `manifest.json` must match `database/content-manifest.json` byte-for-byte. The snapshot tool rejects uncommitted or changed source inputs, missing chunks, malformed map manifests, unresolved badge scenes, and inconsistent park/boundary IDs.

Load the intended branch's database URL into `DATABASE_URL` using private local credential storage. The current operator staging connection is in `$USERPROFILE/.codex/secrets/parkdex-kip.env`; the separate main connection is in `$USERPROFILE/.codex/secrets/parkdex-kip-main.env`. Both files are restricted to that user and include the branch name and ID. Do not pass a URL in a command line, commit it, or put it in an Android build.

```powershell
python scripts/cloud_content.py import --snapshot .codex/cloud-snapshot
python scripts/cloud_content.py verify --snapshot .codex/cloud-snapshot
```

The import applies `database/001_cloud_content.sql` and seeds records in one transaction. It accepts empty or already-identical rows, rejects conflicting data or unexpected tables, and verifies every row before committing. Rerunning the import was verified to preserve the same baseline. A different catalog/version requires a separately reviewed change; this importer deliberately does not update or delete existing data.

For R2, use a Cloudflare API token in `CLOUDFLARE_API_TOKEN`, or explicitly pass `--wrangler-config <private-config-file>` after refreshing Wrangler authentication. The uploader checks existing bytes, never overwrites a conflicting object, verifies each upload by downloading it again, and publishes the manifest last.

```powershell
python scripts/publish_content.py upload --snapshot .codex/cloud-snapshot --account-id 6f0eb57971124f41fadc7897ace74dac --bucket parkdex-kip-content --report .codex/r2-upload.json
python scripts/publish_content.py verify-cdn --snapshot .codex/cloud-snapshot --report .codex/cdn-verification.json
```

The CDN module can be deployed manually after its tests pass. Pages does not accept `account_id` in its Wrangler configuration, so select the account through `CLOUDFLARE_ACCOUNT_ID`. Its `staging` branch label is a content-infrastructure deployment setting and does not release the Android app.

```powershell
node --test cloudflare/content-worker.test.mjs
node scripts/build-content-worker.mjs
$env:CLOUDFLARE_ACCOUNT_ID = '6f0eb57971124f41fadc7897ace74dac'
Push-Location cloudflare
npx wrangler pages deploy ../.codex/cdn-dist --project-name parkdex-kip-content --branch staging --commit-hash <reviewed-commit>
Pop-Location
```

The checked-in verification record is `docs/evidence/cloud-content/verification.json`. It records full database equality and replay, all public object hashes, HTTP semantics, Chrome cross-origin JSON/image/map/glyph checks, and the verified deployment. Browser test processes and tabs were closed after testing. Map attribution remains embedded in the unchanged source/map data; the existing visible Protomaps/OpenStreetMap attribution must be retained when connecting Android.
