# Location claims and visit postcards

New Parkdex visits require a recent device location. The client sends a location sample to
`POST /api/claim-recommendations`; the API checks the canonical sourced polygons, returns at
most one candidate, and binds that candidate to an opaque owner-specific token. A subsequent
`POST /api/claims` must name the same candidate. Unused tokens expire 60 seconds after the
original device fix, so taking a photo cannot silently turn an old location into a different
claim. If the token expires, the client must request location again and show the recommendation
again.

The API ranks qualifying geometry by exact containment before accuracy-buffer proximity, park
before island within that tier, distance, projected polygon area, then stable place ID. It uses
the reviewed `data/boundaries.geojson` geometry in BC Albers metres, including multipolygons and
holes. The map's display-simplified boundary asset is never used for claims.

Existing server-persisted visits are grandfathered. `PUT /api/visits/{placeId}` can remove or
repeat one of those visits, but cannot add a new arbitrary place. Guest import copies only
persisted guest rows and their location evidence; it cannot import client-supplied place IDs.
If a guest photo upload or deletion finishes after an import, the refreshed guest progress card
allows another explicit import to merge that change into the same imported claim lineage. An
account photo upload or deletion is an authoritative edit and later guest imports cannot replace
or restore it. Imports never graft guest photos onto an independently claimed account visit.

Coordinates, accuracy, and optional photos are private owner-scoped visit data. Coordinates are
stored to five decimal places for the postcard caption. Photos are decoded, oriented, stripped
of metadata, resized, and re-encoded as JPEG up to 1 MB before storage in PostgreSQL. Photo reads
require the same bearer token or collection key as the visit and return `Cache-Control: private,
no-store`; there are no public image URLs. Undo and account reset cascade to claim evidence and
photos. Account reset also removes that owner's unused recommendation tokens. Expired unused
recommendations are removed opportunistically during later recommendation requests rather than
by a guaranteed wall-clock cleanup job. Database backups may retain deleted bytes for the
database provider's configured backup retention period.

Client GPS is evidence for product eligibility, not tamper-proof proof of physical presence.
Modified clients and devices can spoof coordinates. The backend prevents accidental or stale
claims and applies one consistent polygon rule, but it does not provide device attestation.

Named test fixtures are available only when `CLAIM_TEST_MODE=true` and `APP_ENVIRONMENT` is not
`production`. `APP_ENVIRONMENT` defaults to `production`, and startup rejects the unsafe
production combination. Test fixtures choose server-defined canonical points; they do not allow
arbitrary coordinate overrides.
