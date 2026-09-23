# Location claims and private visit postcards

New Parkdex visits are created only for an authenticated account. The client sends a recent
device location to `POST /api/claim-recommendations`; the API checks the canonical sourced
polygons, returns at most one candidate, and binds that candidate to an opaque account-scoped
token. A subsequent `POST /api/claims` must name the same candidate. Tokens expire 60 seconds
after the original device fix and are consumed atomically, so replayed or cross-account tokens
cannot create a visit. Collection keys are never accepted by claim or postcard endpoints.

The API ranks qualifying geometry by exact containment before boundary-tolerance proximity, park
before island within that tier, distance, projected polygon area, then stable place ID. Issue #84
defines the tolerance as the reported horizontal accuracy clamped to 10-50 metres: the 10-metre
floor absorbs small discrepancies in published boundary lines, while fixes worse than 50 metres
are rejected. It uses
the reviewed `data/boundaries.geojson` geometry in BC Albers metres, including multipolygons and
holes. The map's display-simplified boundary asset is never used for claims. Startup verifies
that each canonical boundary has an active catalogue place.

Existing server-persisted visits are grandfathered. `PUT /api/visits/{placeId}` can remove or
repeat one of those visits, but cannot add a new arbitrary place once claim enforcement is
required. Guest collection-key progress
remains readable/removable for compatibility and can still be imported into an account; it does
not create location-claim evidence. Account reset and undo cascade claim metadata and attempt to
remove the corresponding private object.

## Adjacent-version rollout

Claim enforcement has an explicit two-release bridge because an older client cannot construct a
signed recommendation token. `GET /api/places` includes the additive capability
`visitClaims: { supported: true, enforcement: "compatible" | "required" }`.
Claim-aware clients prefer the claim flow in both modes. If the field is absent, the client is
talking to the immediately previous API and uses its authenticated visit `PUT` contract. While
the field guide is offline or the capability is still unknown, the client offers neither a new
legacy visit nor a claim; undo of an existing local visit remains available.

`VISIT_CLAIM_ENFORCEMENT=compatible` is the safe first-release setting and the default. It keeps
the new claim endpoints active while temporarily allowing an authenticated N-1 client to create
an unclaimed `account_visits` row through `PUT /api/visits/{placeId}`. It never reopens guest visit
creation. `VISIT_CLAIM_ENFORCEMENT=required` is steady state: a new row is accepted only through
the recommendation/claim flow, while repeat and removal of grandfathered rows still work.

Use this exact rollout sequence independently in staging and production:

1. Release the additive migrations, API, and claim-aware frontend with
   `VISIT_CLAIM_ENFORCEMENT=compatible`. Do not flip enforcement as part of this release.
2. Verify all four convergence paths: new frontend + old API falls back to authenticated `PUT`;
   old frontend + compatible API can still create an account visit; new frontend + compatible
   API uses `/api/claim-recommendations` and `/api/claims`; guest creation remains rejected.
3. Leave the bridge in place until the claim-aware frontend is the N-1 web client. For Android,
   the minimum supported APK must also be claim-aware; an installed APK does not converge merely
   because the web deployment did.
4. In a later release/configuration change, set `VISIT_CLAIM_ENFORCEMENT=required`. Verify both N
   and N-1 clients claim, and verify authenticated legacy `PUT` creation returns
   `409 location_claim_required`. If client convergence is uncertain, restore `compatible`; no
   schema rollback is needed.

Postcard requests are capped before multipart parsing, then decoded, EXIF-transposed, stripped of metadata, resized, and re-encoded as
an RGB JPEG up to 1 MB. The normalized bytes are written to private Cloudflare R2 through its
S3 API. Postgres stores only the account-scoped object key and normalized representation
metadata. Reads and deletes are authenticated API operations with `Cache-Control: private,
no-store`; the API never returns an R2 URL. A failed database update cleans up a newly uploaded
object. Object keys are wholly random and contain no account, place, or coordinate identifier.
Replacements and removals commit the new metadata plus a durable deletion intent before touching
the old object. The request immediately attempts the idempotent delete after commit. Durable
failures retain due-time ordering and capped backoff metadata for manual retry with
`python -m backend.app.photo_cleanup`; no recurring service polls Neon. A confirmed
Android photo is written to account/place-scoped app-private storage before its claim is sent, so
both an ambiguous claim response and a failed upload can recover after a restart; the copy is
cleared after upload success or when that account signs out.

For local/test runs, set `PHOTO_STORAGE_BACKEND=memory` or `filesystem` (with
`PHOTO_STORAGE_PATH`) or inject `backend.app.main.set_photo_storage(...)`. In staging/production,
`PHOTO_STORAGE_BACKEND=auto` requires `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY`; postcard uploads and reads return a clear `503 photo_storage_unavailable`
response when private storage is not configured, while removals still commit a durable deletion
intent for later retry. Named test fixtures are available only when
`CLAIM_TEST_MODE=true`, `APP_ENVIRONMENT` is exactly `local` or `test`, and no
`RAILWAY_ENVIRONMENT_NAME` is present. Preview, staging, production, and every Railway runtime
reject fixture mode fail closed. Fixtures choose server-defined canonical points and do not allow
arbitrary coordinate overrides.

Recommendation checks are limited to 60 per account and 5,000 globally per 15 minutes; photo
uploads are limited to 30 per account and 2,000 globally in the same window. Capacity is reserved
before expensive geometry or image work. The API always permits the packaged Capacitor WebView
origin `https://localhost`; browser origins remain configured with `FRONTEND_ORIGINS`.

Client GPS is evidence for product eligibility, not tamper-proof proof of physical presence.
Modified clients and devices can spoof coordinates. The backend prevents accidental or stale
claims and applies one consistent polygon rule, but it does not provide device attestation.
