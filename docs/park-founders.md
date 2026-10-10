# Found a park

A signed-in player with a handle, standing in a park, takes a photo. When the photo check approves it straight away, the player becomes the park's founder, the photo becomes the park's public cover, today's visit is recorded (planting or taking the flag) and the player earns a one-time 10 point founder bonus. Everything is online. Design: issue #126.

`database/migrations/founders_001_init.sql` adds `kip_founders.parks` (one founder and cover per park), `kip_founders.photo_checks` (one row per check, no image, no position), the bonus in `kip_game.player_scores` (`kip_founders.bonus_points()` is the only place the 10 lives) and the two analytics event types. Code: `worker/founders.ts` (routes), `worker/founders-store.ts`, `worker/founderPhoto.ts` (questions and decision), `worker/jpeg.ts` (metadata stripping), `worker/parkLocation.ts` (be-there check).

## Rules

- **Be there.** The position must be inside the outline, allowing `min(max(accuracyM, 10), 35)` metres outside its edge. Accuracy worse than 100 m is refused.
- **Outline.** A catalogue park uses its boundary. An OpenStreetMap park uses `kip_osm.parks`, then Nominatim and Overpass. An outline that is already a Parkdex park (`catalogueMatch`) is founded as that park, never published again. Unnamed OpenStreetMap outlines cannot be founded. Hidden parks are refused.
- **Photo.** JPEG only, at most 1.5 MiB decoded and 2,048 px a side. APP1 to APP15 and COM segments (EXIF with GPS, XMP, ICC, comments) and anything after the end of the image are removed before the photo is checked, stored or served.
- **Check.** One Decisions API call: `verdict` (approve, reject, unsure) and six yes/no flags. Approved only when `verdict` is `approve` with at least 0.8 (`FOUNDER_PHOTO_APPROVE_THRESHOLD`) and no flag is above 0.5. Any flag rejects the photo with those flags; anything else is unsure. No answer within 8 s, or no `OPENROUTER_API_KEY`, is a retryable 503.
- **Founding.** One transaction under an advisory lock on the park: the founder guard, for an OpenStreetMap park the proposal audit row (with `founder_account_id`), the draft and the operator dashboard's publish statements, then the founder row with the photo, then `kip_game.record_visit`. The park's marker is a point inside the part of the outline the founder is in, never their position. A second founder gets 409.
- **Limits.** 20 photo checks an hour and 5 foundings a day per account.
- **Account deletion** removes the founder row, the photo and the bonus. The park stays and can be founded again.

## API

Errors use the shared shape `{ "error": { "code", "message" }, "code", "message" }`.

### `GET /api/osm/parks?lat=&lng=&accuracy=`

Public, rate limited per address (10 per minute). `accuracy` is metres; without it the tolerance is 10 m. Returns only outlines that contain the position within the tolerance, best first (inside, then nearest, then smallest).

```json
{
  "attribution": "© OpenStreetMap contributors",
  "parks": [{
    "type": "way", "id": 23938892, "name": "Paterson Park", "kind": "leisure=park", "areaM2": 87742,
    "containsPin": true, "distanceM": 0,
    "geometry": { "type": "MultiPolygon", "coordinates": [] },
    "inCatalogue": { "parkId": "osm-way-23938892", "name": "Paterson Park" },
    "founder": { "handle": "tester_one" },
    "hasCover": true
  }]
}
```

`inCatalogue`, `founder` and `hasCover` are `null`, `null` and `false` for a park not in Parkdex. Errors: 400 `invalid_location`, 422 `location_imprecise`, 429 `rate_limited_osm`, 503 `osm_unavailable`.

### `POST /api/parks/found`

Signed in (Bearer, or cookie with `X-CSRF-Token`), handle required. Exact keys; `target` is either `osm` or `parkId`. Reuse `attemptId` only to retry the same photo after a lost response or a 503.

```json
{
  "attemptId": "6f1c2f0e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
  "position": { "lat": 49.0895, "lng": -123.059, "accuracyM": 12 },
  "target": { "osm": { "type": "way", "id": 23938892 } },
  "photo": { "mime": "image/jpeg", "base64": "<JPEG bytes>", "width": 1280, "height": 796 }
}
```

200, founded (`visit` has the `POST /api/game/visits` shape; its `outcome` is `planted`, `took`, `held` or `already_today`):

```json
{
  "outcome": "founded",
  "park": { "id": "osm-way-23938892", "name": "Paterson Park" },
  "coverUrl": "https://web.parkdex.app/api/parks/osm-way-23938892/cover/<sha256>.jpg",
  "visit": { "visitId": "…", "parkId": "osm-way-23938892", "outcome": "planted", "pointsEarned": 0, "previousHolder": null, "flagSince": "2026-10-09T04:46:43.368Z" },
  "founderPoints": 10
}
```

200, not approved (`flags` is empty when unsure; `message` is the first flag's message or the unsure message):

```json
{ "outcome": "rejected", "flags": [{ "code": "people", "message": "We spotted people. Take one without anyone in it." }], "message": "We spotted people. Take one without anyone in it." }
{ "outcome": "unsure", "flags": [], "message": "We couldn't tell. Try another angle." }
```

| Flag | Message |
| --- | --- |
| `people` | We spotted people. Take one without anyone in it. |
| `lighting` | It's too dark or blurry. Take one in good light and hold the phone steady. |
| `not_park` | That doesn't look like the park. Point the camera at the park itself. |
| `inappropriate` | This photo can't be used. Take a photo of the park itself. |
| `not_photo` | That looks like a screen or an edited image. Take a fresh photo of the park. |
| `personal_info` | We can read personal details, like a licence plate or a house number. Take one without them. |

| Status and code | When |
| --- | --- |
| 400 `invalid_request`, `invalid_position`, `invalid_photo` | malformed body, position or photo, or the JPEG's size differs from `width` and `height` |
| 401 `authentication_required` | not signed in |
| 404 `park_not_found` | unknown or hidden park, or an unknown OpenStreetMap outline |
| 409 `handle_required` | no handle yet |
| 409 `already_founded` | the park has a founder; the message names `@handle` |
| 409 `attempt_id_reused` | the attempt ID was used with another photo |
| 409 `founding_blocked` | an operator draft holds the park's id |
| 413 `photo_too_large`, `request_too_large` | over 1.5 MiB or 2,048 px |
| 422 `location_imprecise` | accuracy worse than 100 m |
| 422 `not_in_park` | outside the outline and tolerance |
| 422 `unnamed_park`, `no_outline` | an unnamed OpenStreetMap outline, or a catalogue park without a boundary |
| 429 `rate_limited_founding` | 20 checks an hour or 5 foundings a day |
| 503 `photo_check_unavailable` | the model did not answer; retry with the same `attemptId` |
| 503 `osm_unavailable`, `service_unavailable` | retry later |

### `GET /api/parks/:parkId/cover/:sha256.jpg`

Public. `image/jpeg`, `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<sha256>"`, 304 for a matching `If-None-Match`. 404 for an unknown park or hash and for hidden parks. No shared-cache directive, so a hidden park or a deleted account's photo stops being served.

### `GET /api/parks/:parkId/summary`

Public; signed-in callers also get their own count. `Cache-Control` is `public, max-age=60` without a session and `private, no-store` with one. 404 for unknown or hidden parks. Visits count every row in `kip_game.visits` for the park, imported claims included.

```json
{
  "parkId": "osm-way-23938892",
  "founder": { "handle": "tester_one", "foundedAt": "2026-10-09T04:46:43.368Z" },
  "coverUrl": "https://web.parkdex.app/api/parks/osm-way-23938892/cover/<sha256>.jpg",
  "visits": { "total": 1, "last30Days": 1, "mine": 1 }
}
```

`founder` and `coverUrl` are `null` for a park without a founder; `mine` is `null` without a session.

### Additions to existing routes

- `GET /api/game/flags` adds `founders: [{ parkId, handle, coverUrl }]` for every founded park.
- `GET /api/game/me` adds `founderPoints`, the bonus already included in `score`.
- `POST /api/park-proposals` answers 410 `proposals_retired` with "Update Parkdex to add parks. You can now found a park while you're standing in it." Installed builds show messages up to 200 characters as the error and never retry, so 410 is safe; reviewing stored proposals stays in the operator dashboard.

## Analytics

`founder_photo_checked` (`outcome`: approve, reject, unsure or unavailable; `flags`: comma-separated; `source`: osm_new or existing) for every check, and `park_founded` (`source`) for every founding, plus the usual visit outcome event. Routes group park IDs as `/api/parks/:park/...`.

## Testing

- `worker/jpeg.test.ts`, `worker/park-location.test.ts`, `worker/founder-photo.test.ts`, `worker/founders.test.ts`.
- `scripts/qa-founders-sql.mjs` (`npm run test:sql`, own throwaway database): the full migration inventory replayed twice, then the real routes and stores for a new and a catalogue park, concurrent founders, the bonus, one visit per day, hidden parks, covers, summaries, analytics rows and account deletion.
- Locally: `npm run local:api -- --content` installs the content tables so parks can be founded; load OpenStreetMap outlines with `scripts/osm_park_index.py` (`docs/osm-park-index.md`).
