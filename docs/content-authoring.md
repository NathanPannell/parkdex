# Authoring one park update

Use `scripts/publish_park_update.py` to publish one description or rarity edit, or one selected badge with its park update. It changes one Neon park row and, for a badge, one immutable asset descriptor. It does not rebuild or upload a catalogue snapshot, map, boundaries, or drive data.

## Tool requirements

Use Python 3.11 or newer. The script needs `requests`; selected badge images are decoded locally with Pillow before upload. Install them with `python -m pip install requests Pillow`. Applying a database update also needs the packages in `database/requirements.txt`, including `psycopg[binary]`. A dry run does not need database credentials or `psycopg`.

## Prepare an update

For a badge update, pass the selected WebP and a new scene slug in the park data. Slugs are lowercase words separated by hyphens. A slug is immutable once registered. Use a different slug for a different image.

The script accepts a direct partial update with only the fields being changed:

```json
{
  "id": "provincial-goldstream-park",
  "blurb": "A new park description.",
  "rarity": "rare",
  "scene": "goldstream-riverfall-flat-v1"
}
```

It also accepts the exact 13-field Park object used by the app. For a full object, every field except `blurb`, `rarity`, and `scene` must still match the current database row. The publisher rejects unrelated edits such as changing a park boundary's biome through this badge workflow.

To guard against an update prepared from stale data, wrap either shape with the old values that should still be current when it is applied:

```json
{
  "expected": {
    "scene": "waterfall-a",
    "blurb": "Salmon run, giant cedars and Niagara Falls (the little one). Go in November and bring a thermos.",
    "rarity": "uncommon"
  },
  "park": {
    "id": "provincial-goldstream-park",
    "blurb": "A new park description.",
    "rarity": "rare",
    "scene": "goldstream-riverfall-flat-v1"
  }
}
```

Expected values are optional, but recommended. The publisher locks the park row during the transaction and checks supplied expected values before a change. A successful update can be replayed with the same input. An exact replay verifies the asset descriptor and skips a second park update.

## Dry run and apply

The default run validates the JSON and local WebP, then prints the planned logical path, hash-addressed object key, URL, size, and park fields. It performs no network request or database write. A full record's unchanged fields are compared with Neon only during apply:

```powershell
python scripts/publish_park_update.py `
  --park-json .codex/outputs/goldstream-update.json `
  --badge-webp .codex/outputs/goldstream-selected.webp
```

Inspect the plan, then explicitly apply it. Supply the Cloudflare account and bucket for image uploads. `DATABASE_URL` must already be loaded into the process environment. The Cloudflare token comes from `CLOUDFLARE_API_TOKEN` or `--wrangler-config`.

```powershell
python scripts/publish_park_update.py `
  --park-json .codex/outputs/goldstream-update.json `
  --badge-webp .codex/outputs/goldstream-selected.webp `
  --account-id $env:CLOUDFLARE_ACCOUNT_ID `
  --bucket $env:PARKDEX_ASSETS_BUCKET `
  --apply
```

Do not place database URLs or tokens in the JSON, command output, or tracked files. The publisher does not print secret values.

The selected WebP must be no larger than 4 MiB for the native client transport. The publisher decodes it locally before upload, then uploads it to `releases/<sha256>/art/badges/scenes/<slug>.webp`, an immutable key accepted by the current CDN worker. No full catalogue manifest is generated. The publisher then fetches the public CDN URL and verifies the bytes, SHA-256, size, `image/webp` MIME type, CORS header, and immutable cache header. It opens a short Neon transaction only after those checks pass. In that one transaction it inserts or verifies the `r2_objects` descriptor and updates the park's `blurb`, `rarity`, and `scene`. The database triggers put the asset and park change in one revision batch.

If upload or CDN verification fails, no database operation starts. If the database transaction fails after the upload, the immutable object may remain unreferenced. Re-running the same input reuses and verifies that object, then retries the transaction. A completed replay is a no-op and does not create another park revision.

Never delete a registered scene descriptor or its immutable R2 object, even if its park retires or uses another scene later. Previously earned badges can need that original image for restoration.

## Metadata-only update

Omit `--badge-webp` to change only a park description or rarity. The scene is preserved. Supplying a different scene without a WebP is rejected.

```json
{
  "expected": { "blurb": "Salmon run, giant cedars and Niagara Falls (the little one). Go in November and bring a thermos." },
  "park": {
    "id": "provincial-goldstream-park",
    "blurb": "A corrected park description."
  }
}
```

```powershell
python scripts/publish_park_update.py `
  --park-json .codex/outputs/goldstream-metadata.json

python scripts/publish_park_update.py `
  --park-json .codex/outputs/goldstream-metadata.json `
  --apply
```

Metadata-only publication needs `DATABASE_URL` but does not need Cloudflare credentials, an account ID, or a bucket.
