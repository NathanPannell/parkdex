# Private visit-photo storage

## Decision

Parkdex stores normalized visit photos in private Cloudflare R2 buckets. Railway remains the only application boundary for uploads, reads, replacements, and deletions; Neon stores the owner-scoped postcard row plus an opaque object key and image metadata, never the image bytes.

Use separate buckets for persistent environments, for example `parkdex-photos-staging` and `parkdex-photos-production`. Buckets must remain private. Do not enable an `r2.dev` public URL, and do not expose R2 credentials to the browser, Android bundle, Cloudflare Pages, Vercel, or pull-request previews.

This fits the current Cloudflare Pages → Railway → Neon architecture while avoiding image growth in Postgres WAL, backups, and query traffic. R2's S3-compatible API lets Railway use a conventional object-store adapter, while its zero-egress pricing keeps authenticated API streaming practical for the pilot.

## Field-pilot flow

1. The authenticated client sends one photo to the visit-photo endpoint only after the location claim exists.
2. Railway verifies ownership before reading or processing the upload.
3. Railway rejects request bodies over the multipart allowance before FastAPI parses or spools them. Pillow then decodes the image, applies EXIF orientation, rejects unsafe or animated inputs, scales the long edge to at most 1,600 pixels, strips metadata by re-encoding, and produces a JPEG no larger than 1 MB.
4. Railway writes that canonical JPEG to R2 under a wholly random `postcards/<nonce>.jpg` key containing no owner or place identifier.
5. In the same owner-scoped update, Neon records the object key, media type, dimensions, byte length, SHA-256 digest, and update time.
6. Reads remain authenticated and are streamed through Railway with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
7. Replacement writes the new object first, then atomically commits the new metadata and a deletion-outbox row for the old key. Removal atomically clears metadata and records the same durable tombstone. The request immediately attempts the idempotent object delete after commit, removes successful tombstones, and retains failures for manual retry with `python -m backend.app.photo_cleanup`. No recurring service polls the outbox.

Before sending a claim that includes a confirmed photo, Android first copies the bounded photo into the app-private data directory, scoped to the authenticated account and place. That closes the claim-response-loss window as well as the ordinary failed-upload path: the retry survives navigation and process restart, is removed after a successful upload, and is cleared when that account signs out. Browser development builds use same-origin IndexedDB when available. Photo bytes are never stored in Preferences or the system gallery.

Local and automated tests use the same object-store contract with in-memory or private filesystem adapters. Persistent staging and production fail closed when R2 is not configured; they never silently put photo bytes in Neon or on an ephemeral Railway filesystem.

## Runtime configuration

Railway API environments require:

- `PHOTO_STORAGE_BACKEND=r2`
- `R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`
- `R2_BUCKET=<environment-specific-private-bucket>`
- `R2_ACCESS_KEY_ID=<Railway-only-secret>`
- `R2_SECRET_ACCESS_KEY=<Railway-only-secret>`
- `R2_REGION=auto`

`PHOTO_STORAGE_BACKEND=memory` and `filesystem` are accepted only when `APP_ENVIRONMENT` is `local` or `test`. `PHOTO_STORAGE_PATH` is for a disposable local field harness, never preview, staging, or production Railway services.

## Security and lifecycle

- Authorize before processing an upload and before every read, replace, or delete.
- Trust decoded image content, not the filename or client-provided media type.
- Never retain the original upload, EXIF/IPTC/XMP data, or GPS metadata.
- Limit the pilot to one canonical photo per claimed visit, 8 MB input, and 1 MB normalized output.
- Object keys contain no email, account ID, place name, coordinates, or other user data.
- Commit a durable deletion intent when a photo, visit, or account is deleted. The immediate delete path records failures with capped exponential backoff metadata so a manual cleanup batch cannot let one failing object starve newer removals; an operational orphan audit remains required before general availability.
- R2 lifecycle rules should remove abandoned quarantine objects after 24 hours once direct uploads are introduced.

## Later hardening

For larger traffic, add a three-step quarantine protocol: Railway issues a short-lived owner-scoped presigned PUT, the client uploads to a private quarantine key, and a completion endpoint queues a worker to verify, normalize, and publish the canonical object. Unprocessed objects are never served. The worker should use a database-backed job/outbox for retry and orphan cleanup rather than an in-process background task.

Continue proxying reads through Railway until measurement justifies short-lived signed GET URLs. Cloudflare Images can be reconsidered if managed variants become more valuable than the additional per-image cost and provider coupling.

References: [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [upload behavior](https://developers.cloudflare.com/r2/objects/upload-objects/), [lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), and [data security](https://developers.cloudflare.com/r2/reference/data-security/).
