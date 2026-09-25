# Publishing Parkdex visual assets

`scripts/publish_visual_assets.py` validates the generated visual batch against `data/places.json`, then either stages a small local fixture or publishes a complete immutable version to a dedicated public S3-compatible bucket. It publishes `satellite.avif`, `relief.avif`, and `<place-id>-terrain.glb` for each place. It does not publish working files, manifests, source locks, height grids, textures, or boundary files.

The batch must include one generated directory per canonical place. Each `manifest.json` must match the place ID, name, and category in the catalogue and must list the size and SHA-256 for each public asset. When `sourceLockSha256` is present, the command verifies it against the sibling `sources.json` before staging or upload. A missing or mismatched asset stops publishing.

## Validate the complete batch

Run a dry validation after the data batch finishes. This checks all catalogue places and prints byte totals, the deterministic index hash, and review counts without writing files or contacting storage:

```powershell
python .\scripts\publish_visual_assets.py `
  --generated C:\path\to\parkdex-all-1030-20260924 `
  --catalogue .\data\places.json `
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

## Upload the complete batch

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
  --upload
```

Upload requires exactly 1,030 canonical catalogue places and a complete validated output for every one. It computes the deterministic index first, then stores assets under `<prefix>/<index-sha256>/` and writes `index.json` last. Existing objects with matching SHA-256 metadata or matching bytes are skipped. A key with different bytes is rejected; the hashed prefix is immutable. Re-running the same complete batch is safe. The JSON report includes the index hash and key, bytes, review-flag counts and affected place IDs, and uploaded or skipped object counts. Error logs omit SDK exception text and credentials.

After upload, configure the GitHub Actions **staging environment** variable `PARK_VISUALS_BASE_URL` with the public origin followed by the reported versioned `prefix`, for example `https://assets.example.com/parkdex/visual-assets/v1/<index-sha256>`. The release workflow passes this value to Vercel as `NEXT_PUBLIC_PARK_VISUALS_BASE_URL`. The app appends `/index.json` and resolves the index's relative asset paths from that directory. When the variable is unset, the app keeps its local fixture fallback.
