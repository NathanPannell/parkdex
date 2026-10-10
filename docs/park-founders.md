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
- `GET /api/game/me` adds `founderPoints`, the bonus already included in `score`, and `foundingReviews` (see [Manual review](#manual-review)).
- `POST /api/parks/found` adds `reviewableUntil` to `rejected` and `unsure` answers (see [Manual review](#manual-review)).
- `POST /api/park-proposals` answers 410 `proposals_retired` with "Update Parkdex to add parks. You can now found a park while you're standing in it." Installed builds show messages up to 200 characters as the error and never retry, so 410 is safe; reviewing stored proposals stays in the operator dashboard.

## Manual review

When the photo check rejects a founding photo or can't decide (`rejected` or `unsure`), the player can ask the operator to look at it (#153). Design decided with the operator on 2026-10-10.

### Rules

- **Photo outcomes only.** `rejected` and `unsure` can be appealed. Not being in the park, hidden and unnamed parks, "already founded" and `photo_check_unavailable` stay hard failures.
- **Photo only.** The request reuses the stored attempt: the photo with its metadata already removed, the position, the target, the flags and the model's answers. The player sends only the `attemptId`, never the photo again, and no note.
- **Kept for a day.** The photo and position of a `rejected` or `unsure` check are kept for 24 hours (`kip_founders.check_photos`), then deleted by the daily retention run. A request keeps its own copy (`kip_founders.review_requests`) until 90 days after the decision. An approved photo lives on as the park's cover.
- **Limits.** 3 requests per account per Victoria day (America/Vancouver), and one pending request per account and park.
- **Approval** makes the player the founder, with that photo as the cover and the 10 point founder bonus, through the same founding transaction as an instant approval (`worker/founding.ts`), with **no visit and no flag**: flags still need a real visit that day. An OpenStreetMap target is published at approval time; one that has become a Parkdex park meanwhile is founded as that park.
- **Competition.** Other players can still found the park instantly while a request is pending. The first founding wins. Any founding, by either path, closes every pending request for that park as `superseded` in the same transaction.
- **Rejection** carries a short reason the player sees: a preset (people, too dark or blurry, not the park, inappropriate) or the operator's own words.
- **Feedback.** `GET /api/game/me` lists pending requests and each decision until the app marks it seen.

### `POST /api/parks/found` (addition)

`rejected` and `unsure` answers add `reviewableUntil`, the time until which `POST /api/parks/found/review` can use this attempt (24 hours after the check). It is `null` when the photo is no longer kept. A retry with the same `attemptId` answers the same.

```json
{ "outcome": "unsure", "flags": [], "message": "We couldn't tell. Try another angle.", "reviewableUntil": "2026-10-11T17:00:00.000Z" }
```

### `POST /api/parks/found/review`

Signed in (Bearer, or cookie with `X-CSRF-Token`), handle required. Exact keys.

```json
{ "attemptId": "6f1c2f0e-3a4b-4c5d-8e9f-0a1b2c3d4e5f" }
```

200:

```json
{ "status": "pending", "requestId": "0b7e9a52-4c1d-4f7e-9a51-2d8c6b3f1e07" }
```

Sending the same `attemptId` again answers 200 with the same `requestId` and the request's current `status` (`pending`, `approved`, `rejected` or `superseded`), so a lost response can be retried safely.

| Status and code | When |
| --- | --- |
| 400 `invalid_request` | malformed body or attempt ID |
| 401 `authentication_required` | not signed in |
| 404 `attempt_not_found` | no photo check with this attempt ID for this account |
| 404 `park_not_found` | the park was hidden or removed since the check |
| 409 `handle_required` | no handle yet |
| 409 `not_reviewable` | the check approved the photo, or never answered (`photo_check_unavailable`) |
| 409 `already_founded` | the park has a founder; the message names `@handle` |
| 409 `review_pending` | this account already has a pending request for this park |
| 410 `photo_expired` | the photo is no longer kept (more than 24 hours after the check) |
| 429 `rate_limited_review` | 3 requests today already |
| 503 `service_unavailable` | retry later |

### `POST /api/parks/found/review/seen`

Signed in (Bearer, or cookie with `X-CSRF-Token`). Marks decisions as shown, so `GET /api/game/me` stops listing them. 1 to 50 IDs. Pending, unknown, already seen and other accounts' IDs are ignored.

```json
{ "requestIds": ["0b7e9a52-4c1d-4f7e-9a51-2d8c6b3f1e07"] }
```

200, the IDs this call marked:

```json
{ "seen": ["0b7e9a52-4c1d-4f7e-9a51-2d8c6b3f1e07"] }
```

Errors: 400 `invalid_request`, 401 `authentication_required`.

### `GET /api/game/me` (addition)

`foundingReviews` is always present; both lists are empty without a handle. `pending` is oldest first. `decided` holds decisions not yet marked seen, oldest decision first, at most 20.

```json
{
  "foundingReviews": {
    "pending": [
      { "requestId": "0b7e9a52-…", "parkId": "osm-way-23938892", "osm": { "type": "way", "id": 23938892 }, "parkName": "Paterson Park", "createdAt": "2026-10-10T18:02:11.000Z" }
    ],
    "decided": [
      { "requestId": "5d0c…", "status": "approved", "parkId": "osm-way-23938892", "parkName": "Paterson Park", "reason": null,
        "coverUrl": "https://web.parkdex.app/api/parks/osm-way-23938892/cover/<sha256>.jpg", "founderHandle": "tester_one", "decidedAt": "2026-10-10T20:15:00.000Z" },
      { "requestId": "9a41…", "status": "rejected", "parkId": "municipal-beacon-hill-park", "parkName": "Beacon Hill Park", "reason": "There are people in the photo.",
        "coverUrl": null, "founderHandle": null, "decidedAt": "2026-10-10T20:16:00.000Z" },
      { "requestId": "c3e2…", "status": "superseded", "parkId": "community-qa-green", "parkName": "QA Green", "reason": null,
        "coverUrl": null, "founderHandle": "someone_else", "decidedAt": "2026-10-10T19:40:00.000Z" }
    ]
  }
}
```

- `pending[].parkId` is the catalogue park, or the ID an OpenStreetMap park gets when published (`osm-<type>-<id>`); `osm` is the outline for an OpenStreetMap target and `null` otherwise. Use either to show the pending badge on that park's sheet.
- `decided[].status` is `approved` ("You founded X"), `rejected` ("Not approved: reason") or `superseded` (someone else founded it first; `founderHandle` names them).
- `parkId` of an approved request is the park it founded, which can differ from the pending `parkId` when the outline turned out to be a Parkdex park. `coverUrl` is the current cover, or `null` once the cover is gone. `founderHandle` is the park's current founder, or `null`.

### Operator dashboard

Parks → Review (`/parks/review`) lists requests oldest first, with a pending count in the sidebar. Each request shows the full photo, the check's flags and probabilities, the player's handle, when the photo was taken, and the target outline or park on a map with the player's position and accuracy. Approve asks first and runs the founding transaction; Reject takes a preset or typed reason. Both write a `founding_review_decided` analytics event in the same transaction; an approval also writes `park_founded` (`via`: review). Routes are under `/api/parks/review` in `operator/server/parks/reviews.ts`, with the SQL in `worker/founding-reviews.ts`. A database without `founders_002` shows the tab as not deployed yet.

## Analytics

`founder_photo_checked` (`outcome`: approve, reject, unsure or unavailable; `flags`: comma-separated; `source`: osm_new or existing) for every check, and `park_founded` (`source`) for every founding, plus the usual visit outcome event. Routes group park IDs as `/api/parks/:park/...`.

`founding_review_requested` (`outcome`: reject or unsure; `source`: osm_new or existing) when a player asks for a review, and `founding_review_decided` (`decision`: approved or rejected; `reason_code`; `waited_minutes`) when the operator decides, with route `POST /operator/parks/review/:id/approve` or `/reject` and the player's account.

## Testing

- `worker/jpeg.test.ts`, `worker/park-location.test.ts`, `worker/founder-photo.test.ts`, `worker/founders.test.ts`.
- `scripts/qa-founders-sql.mjs` (`npm run test:sql`, own throwaway database): the full migration inventory replayed twice, then the real routes and stores for a new and a catalogue park, concurrent founders, the bonus, one visit per day, hidden parks, covers, summaries, analytics rows and account deletion.
- Locally: `npm run local:api -- --content` installs the content tables so parks can be founded; load OpenStreetMap outlines with `scripts/osm_park_index.py` (`docs/osm-park-index.md`).
