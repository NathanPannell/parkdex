# Publishing Parkdex visual assets

`scripts/publish_visual_assets.py` validates the generated visual batch against `data/places.json`, then either stages a small local fixture or publishes an immutable, rights-approved version to a dedicated public bucket through S3 or Cloudflare Wrangler. It publishes `satellite.avif`, `relief.avif`, and `<place-id>-terrain.glb` for each approved place. It does not publish working files, manifests, source locks, height grids, textures, or boundary files.

The batch must include one generated directory per canonical place. Each `manifest.json` must match the place ID, name, and category in the catalogue and must list the size and SHA-256 for each public asset. When `sourceLockSha256` is present, the command verifies it against the sibling `sources.json` before staging or upload. A missing or mismatched asset stops publishing.

Public upload also requires an explicit boundary rights manifest. The publisher validates all 1,030 generated places first, then limits the public index and uploaded assets to entries marked `approved`. Places marked `hold` remain absent from the public index, so the app does not offer Map views for them. Both S3 and Wrangler reject an ungated batch before any object is written.

The rights manifest has `version: 1`, `boundarySnapshotSha256`, and a `places` object containing exactly one decision for each catalogue ID. Each decision must repeat the snapshot feature's `sourceName`, `sourceUrl`, and `sourceId`; an approved entry uses `"decision": "approved"` and a non-empty `rightsAttribution` string array, while a held entry uses `"decision": "hold"` and a non-empty `reason`. The publisher checks the snapshot's byte hash, all IDs and source fields, and each generated place manifest and hashed `sources.json` boundary feature. It appends approved `rightsAttribution` strings to the public index's attribution list, which the app displays. Any missing decision, credit, or source drift stops publication. Keep the reviewed rights manifest and its exact boundary GeoJSON snapshot together when publishing.

For the frozen 2026-09-24 snapshot, `data/visual-boundary-rights-20260924.json` approves 812 places and holds 218. The 218 holds include 91 from direct regional GIS sources with unresolved or restrictive redistribution terms and 127 aggregate regional rows whose matched upstream licence comment is blank. The 46 aggregate rows with explicit provider comments are approved after separate review of their six provider licence families. `data/visual-boundary-rights-audit-20260924.json` records the source IDs, reasons, provider terms, and exact frozen comments. The public index uses the current required provider attribution from that review; the original comments remain in the rights manifest as evidence.

The imagery and elevation sources have separate open terms. The [Copernicus Sentinel Data Legal Notice](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice) permits modified Sentinel-2 derivatives with the `Contains modified Copernicus Sentinel data [Year]` credit already recorded in generated manifests. The [NRCan CDEM dataset](https://open.canada.ca/data/en/dataset/7f245e4d-76c2-4caa-951a-45d1d2051333) uses the [Open Government Licence, Canada](https://open.canada.ca/en/open-government-licence-canada). The public index normalizes the older CDEM credit to include the licence's fallback attribution phrase and URL, which the app displays as a link. Keep each `sources.json` scene URL and DEM URL in the private generation audit; the publisher uploads only the derived public assets.

## Publish the held places from independent points

The optional dual-source mode fills the 218 held slots using a separate point-centered, boundary-free render batch. It reads the rights manifest and frozen boundary snapshot first, then validates only the 812 approved polygon output directories. It does not open held polygon manifests, source locks, or assets. The point manifest and point output directories must match the 218 held IDs exactly, and the 812 plus 218 sets must be disjoint and cover the full catalogue.

The independent point manifest is a JSON array of rows with exactly these keys: `id`, `name`, `category`, `lon`, `lat`, `sourceName`, `sourceUrl`, `sourceId`, `licence`, and `attribution`. Coordinates must be finite and inside British Columbia. Each point source name, URL, record ID, licence, and attribution must be non-empty; the source URL must use HTTP or HTTPS. Store this file outside both generated roots. Its SHA-256 covers its exact bytes, including whitespace and line endings.

Dual-source mode also requires a separate `--point-rights-manifest`, stored outside both generated roots and the point input file. Its schema is `{ "version": 1, "pointManifestSha256": "<sha256>", "places": { "<id>": { "decision": "approved", "sourceName": "...", "sourceUrl": "...", "sourceId": "...", "licence": "...", "attribution": "...", "officialTermsUrl": "https://...", "reviewEvidenceUrl": "https://..." } } }`. Each approved decision must cover exactly one point ID, match every source field byte-for-byte, and link to HTTPS terms and review evidence. A missing decision, hold, mismatch, or licence that explicitly withholds public redistribution fails before either upload backend writes an object. The merged index records the point-rights manifest hash and publishes its terms and evidence URLs with the point-source credit.

Each point render is an 8 km square centered on its independent pin in the pin's UTM zone. The publisher recomputes the EPSG and square bounds from the point, and checks the values in both `sources.json` and `manifest.json`. It requires `pyproj` for this dual-source check and reports a clear install error if unavailable. Install it with `python -m pip install -r backend/requirements.txt`. The existing 812-only boundary publication path does not import or require `pyproj`.

Every point output has the standard three public assets and their byte counts and SHA-256 values in `manifest.json`. Its manifest and `sources.json` both bind to the raw point manifest SHA-256; `sources.json.inputRecord` must match the original point row exactly. Both record `renderMode: "point-centered-boundary-free"`, and the place manifest includes the copied `pointSource` record and exact `representativePin`. The publisher rejects boundary files and any recursively nested keys containing `boundary`, `geometry`, or `polygon`. It also checks the source-lock hash and all three public asset hashes before either upload backend can write anything.

The mixed index preserves the current index schema and adds top-level `publicationProvenance` hashes for the boundary rights manifest, boundary snapshot, independent point manifest, and point rights manifest. Point-rendered entries carry `renderMode`, their public `pointSource`, and `pointRights` with the official terms and review evidence URLs. Their `attribution` includes the point provider's attribution, licence, source record, and terms URL. Boundary-only publication remains available with the existing command and publishes only the 812 approved places.

Once both batches are prepared, validate the combined output without uploading:

```powershell
python .\scripts\publish_visual_assets.py `
  --generated C:\path\to\parkdex-all-1030-20260924 `
  --catalogue .\data\places.json `
  --rights-manifest .\data\visual-boundary-rights-20260924.json `
  --boundaries C:\path\to\parkdex-boundaries-1030.geojson `
  --point-generated C:\path\to\point-centered-held-places `
  --point-manifest C:\path\to\independent-point-manifest.json `
  --point-rights-manifest C:\path\to\point-source-rights.json `
  --dry-run
```

Replace the mode with `--upload` or `--upload-wrangler` only after reviewing the dry-run report and point-source credits.

The decisions can be rebuilt deterministically from the exact frozen boundary snapshot, regional source import, and checked-in rights audit. The builder rejects changed input hashes, missing source-record matches, unverified provider families, or a count other than 812 approved and 218 held:

```powershell
python .\scripts\build_visual_rights_manifest.py `
  --boundaries C:\path\to\parkdex-boundaries-1030.geojson `
  --regional-import C:\path\to\new-regional-parks.geojson `
  --rights-audit .\data\visual-boundary-rights-audit-20260924.json `
  --output .\data\visual-boundary-rights-20260924.json
```

Use the original 1,030-feature boundary snapshot. The batch's `catalogue-boundaries.geojson` copy has semantically identical features but different bytes, so it does not match the reviewed snapshot SHA-256.

## Validate the complete batch

Run a dry validation after the data batch finishes. This checks all catalogue places and prints byte totals, the deterministic index hash, and review counts without writing files or contacting storage:

```powershell
python .\scripts\publish_visual_assets.py `
  --generated C:\path\to\parkdex-all-1030-20260924 `
  --catalogue .\data\places.json `
  --rights-manifest .\data\visual-boundary-rights-20260924.json `
  --boundaries C:\path\to\parkdex-boundaries-1030.geojson `
  --dry-run
```

For faster local iteration, a dry run can validate selected complete places:

```powershell
python .\scripts\publish_visual_assets.py `
  --generated C:\path\to\parkdex-all-1030-20260924 `
  --catalogue .\data\places.json `
  --ids provincial-brackendale-eagles-park,island-cormorant-island `
  --dry-run
```

## Stage a local fixture

Staging requires explicit place IDs and an absent or empty destination directory. It copies only the selected places' three public assets and a root `index.json`; this is suitable for the staging app's local integration and UI review.

```powershell
python .\scripts\publish_visual_assets.py `
  --generated C:\path\to\parkdex-all-1030-20260924 `
  --catalogue .\data\places.json `
  --ids provincial-brackendale-eagles-park,island-cormorant-island `
  --stage-dir C:\temp\parkdex-visual-assets-fixture
```

The index has `version: 1` and a `places` object keyed by canonical place ID. Each entry contains `satellite`, `relief`, `model`, `attribution`, `acquired`, `needsReview`, and `reviewFlags`. `assetSha256` and `assetBytes` record integrity for the three published files and bind the index hash to the asset bytes. A null `reviewFlags` value in a non-review manifest is normalized to an empty array. For older review-required manifests with no explicit flags, the publisher reconstructs reasons from geometry validity, filled DEM fraction, scene quality, mixed acquisition dates, and fallback scene use. It uses `batch-review-required` if the manifest has no evidence to identify a specific reason. Explicit non-empty flags are preserved.

## Configure the public bucket

Create or select a dedicated public visual-assets bucket outside this script. Do not use the private postcard bucket. The upload command checks that its configured bucket name differs from `R2_BUCKET` when that private-bucket variable is set. The publisher does not create buckets, change access policy, or configure a custom domain.

For R2, enable public access through a dedicated custom domain or the account's approved public bucket endpoint. For S3, use a bucket policy that grants public `GetObject` only under the visual-asset prefix. Keep write credentials scoped to that bucket and prefix.

For an AWS S3 bucket, the public-read statement can be scoped to the asset prefix like this. Replace the bucket placeholder and adjust the prefix if `PARKDEX_VISUAL_ASSETS_S3_PREFIX` is different:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadParkdexVisualAssets",
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::<public-visual-assets-bucket>/parkdex/visual-assets/v1/*"
    }
  ]
}
```

The application only needs the public index URL, such as:

```text
https://assets.example.com/parkdex/visual-assets/v1/<index-sha256>/index.json
```

Configure bucket CORS for the staging and production web app origins. The GLB is loaded as a browser model, so cross-origin reads must be allowed.

### Cloudflare R2 with Wrangler

Cloudflare Wrangler expects its own `rules` object and lowercase field names. This configuration follows the [Cloudflare R2 CORS documentation](https://developers.cloudflare.com/r2/buckets/cors/):

```json
{
  "rules": [
    {
      "allowed": {
        "origins": [
          "https://staging.web.parkdex.app",
          "https://web.parkdex.app"
        ],
        "methods": ["GET", "HEAD"]
      },
      "exposeHeaders": ["ETag", "Content-Length", "Content-Type", "Cache-Control"],
      "maxAgeSeconds": 86400
    }
  ]
}
```

Save it as `cors.json`, then apply and verify it with Wrangler:

```powershell
npx wrangler r2 bucket cors set <PUBLIC_VISUAL_ASSETS_BUCKET> --file cors.json
npx wrangler r2 bucket cors list <PUBLIC_VISUAL_ASSETS_BUCKET>
```

### AWS S3 CORS

AWS S3 uses an array of CORS rules with capitalized field names. Use this format only for an AWS S3-compatible provider that expects the S3 CORS schema:

```json
[
  {
    "AllowedOrigins": [
      "https://staging.web.parkdex.app",
      "https://web.parkdex.app"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type", "Cache-Control"],
    "MaxAgeSeconds": 86400
  }
]
```

Keep the public read policy limited to the visual-asset prefix. Set a long cache lifetime for the immutable hashed prefix. The publisher sets `Cache-Control: public, max-age=31536000, immutable` on each uploaded object.

## Upload the complete batch through S3

Install `boto3` in the Python environment used for publishing, then set task-specific variables for the dedicated public bucket. The access key and secret must never point to the private postcard bucket:

```powershell
python -m pip install boto3
$env:PARKDEX_VISUAL_ASSETS_S3_ENDPOINT = 'https://<account-or-provider-endpoint>'
$env:PARKDEX_VISUAL_ASSETS_S3_BUCKET = '<public-visual-assets-bucket>'
$env:PARKDEX_VISUAL_ASSETS_S3_ACCESS_KEY_ID = '<write-key-id>'
$env:PARKDEX_VISUAL_ASSETS_S3_SECRET_ACCESS_KEY = '<write-secret>'
$env:PARKDEX_VISUAL_ASSETS_S3_REGION = 'auto'
$env:PARKDEX_VISUAL_ASSETS_S3_PREFIX = 'parkdex/visual-assets/v1'
```

Then upload with no `--ids` argument:

```powershell
python .\scripts\publish_visual_assets.py `
  --generated C:\path\to\parkdex-all-1030-20260924 `
  --catalogue .\data\places.json `
  --rights-manifest .\data\visual-boundary-rights-20260924.json `
  --boundaries C:\path\to\parkdex-boundaries-1030.geojson `
  --upload
```

Upload requires exactly 1,030 canonical catalogue places and a complete validated output for every one, plus the rights manifest and snapshot. It computes an index for approved places only, then stores their assets under `<prefix>/<index-sha256>/` and writes `index.json` last. Existing objects with matching SHA-256 metadata or matching bytes are skipped. A key with different bytes is rejected; the hashed prefix is immutable. Re-running the same complete batch is safe. The JSON report includes validated, approved, and held counts, the index hash and key, bytes, review-flag counts and affected place IDs, and uploaded or skipped object counts. Error logs omit SDK exception text and credentials.

## Upload the complete batch through Cloudflare Wrangler

Use this path when the dedicated R2 bucket is available through `wrangler login` but scoped S3 API credentials are unavailable. The script pins Wrangler 4.139.0 through `npx`; Node.js and npx must be on `PATH`. Wrangler must already be authenticated to the Cloudflare account containing the public bucket. For this Parkdex run, the Wrangler backend accepts only the dedicated `parkdex-visual-assets` bucket, including when the private bucket variable is unset. This mode uses the remote bucket explicitly and never writes to Wrangler's local R2 emulator.

```powershell
$env:PARKDEX_VISUAL_ASSETS_WRANGLER_BUCKET = 'parkdex-visual-assets'
$env:PARKDEX_VISUAL_ASSETS_WRANGLER_PREFIX = 'parkdex/visual-assets/v1'
python .\scripts\publish_visual_assets.py `
  --generated C:\path\to\parkdex-all-1030-20260924 `
  --catalogue .\data\places.json `
  --rights-manifest .\data\visual-boundary-rights-20260924.json `
  --boundaries C:\path\to\parkdex-boundaries-1030.geojson `
  --upload-wrangler `
  --wrangler-workers 2 `
  --wrangler-delay-seconds 0.5
```

The default is two concurrent transfers and at least 0.5 seconds between Wrangler command starts across all workers. Reduce workers or increase the delay if the account experiences rate limiting. The script prints a secret-free progress record after every 100 assets. Each fresh key is checked for absence, its local bytes are rehashed against the validated manifest immediately before upload, and the object is stored with the correct MIME type and `Cache-Control: public, max-age=31536000, immutable`. On retry, each existing remote object is downloaded to a temporary file and SHA-256 checked before it is skipped. A mismatched key stops the run; the publisher never overwrites conflicting bytes. Temporary downloads are removed automatically.

The same 1,030-place validation, rights gate, index-hash prefix, and index-last rule apply to both upload backends. A failed or interrupted Wrangler run may leave approved asset objects in the hashed prefix but no index. Re-run the exact command to resume; matching objects are skipped, remaining objects are sent, and `index.json` is published only after every asset succeeds. Wrangler failures print a generic key-specific error without exposing CLI output, tokens, or endpoint details.

After upload, configure the GitHub Actions **staging environment** variable `PARK_VISUALS_BASE_URL` with the public origin followed by the reported versioned `prefix`, for example `https://assets.example.com/parkdex/visual-assets/v1/<index-sha256>`. The release workflow passes this value to Vercel as `NEXT_PUBLIC_PARK_VISUALS_BASE_URL`. The app appends `/index.json` and resolves the index's relative asset paths from that directory. When the variable is unset, the app keeps its local fixture fallback.
