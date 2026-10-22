# Park founders

A signed-in player with a handle, standing in a park, takes a photo. When the photo check approves it straight away, the player becomes the park's founder, the photo becomes the park's public cover, today's visit is recorded (planting or taking the flag) and the player earns a one-time 10 point founder bonus. Everything is online. Design: issue #126.

`database/migrations/founders_001_init.sql` adds `kip_founders.parks` (one founder and cover per park), `kip_founders.photo_checks` (one row per check, no image, no position), the bonus in `kip_game.player_scores` (`kip_founders.bonus_points()` is the only place it lives; `game_002_points.sql` redefines it as 24, from 10, for hourly points, #169) and the two analytics event types. `founders_002_reviews.sql` adds manual review ([below](#manual-review)): `kip_founders.check_photos` (the photo and position of a rejected or unsure check, kept for 24 hours) and `kip_founders.review_requests`. `founders_003_park_removed.sql` adds the `park_removed` analytics event for [Remove from map](#remove-from-map). `founders_004_boundary_boxes.sql` adds `public.park_boundary_box(feature)` and a GiST index on it over `public.boundaries`, so catalogue parks are found by where their boundary reaches, not only by their pin. Code: `worker/founders.ts` (routes), `worker/founders-store.ts`, `worker/founding.ts` (the founding transaction, shared with review approvals), `worker/founding-reviews.ts` (the operator's review store and retention), `worker/founderPhoto.ts` (questions and decision), `worker/jpeg.ts` (metadata stripping), `worker/parkLocation.ts` (be-there check).

## Rules

- **Be there.** The position must be inside the outline, allowing `min(max(accuracyM, 10), 35)` metres outside its edge. Accuracy worse than 100 m is refused.
- **Outline.** A catalogue park uses its boundary. An OpenStreetMap park uses `kip_osm.parks`, then Nominatim and Overpass. An outline that is already a Parkdex park (`catalogueMatch` in `worker/catalogueMatch.ts`) is founded as that park, never published again. It is that park when it has the park's published `osm-<type>-<id>`, when its interior point is inside the park's boundary, or when the park's interior point is inside it and the park covers at least a quarter of it. A name never overrides the shapes: a park with a boundary also matches only with the same name and at least a quarter of the smaller shape's ground in common, and a park without a boundary (a pin only) with the same name and its pin within 1.5 km. The same name ignores generic words (park, regional, community, …) and word order, so Watershed Park is Watershed Regional Park, but a name inside a longer one is not the same name: Steveston Town Square Park and Steveston Community Park, next door, are two parks. The search and the founding both compare the outline with the catalogue parks around the player: those whose pin is within 5 km, and those whose boundary's bounding box comes within 5 km (`nearbyParks` in `worker/proposalReview.ts`, the `boundaries_box_idx` index from `founders_004_boundary_boxes.sql`). The second set catches the far parts of big parks, such as Kejimkujik Seaside, about 72 km from Kejimkujik's pin (#182). An outline in a hole of a catalogue park, or next to one of its parts, is still a new park. Unnamed OpenStreetMap outlines cannot be founded. Hidden parks are refused.
- **Photo.** The app sends the player's 3:4 crop of the photo (#173), at most 1,280 px on the long edge, so the check and the cover see the same picture the player chose. On Android the phone's own camera app takes it. The server accepts any shape: JPEG only, at most 1.5 MiB decoded and 2,048 px a side. APP1 to APP15 and COM segments (EXIF with GPS, XMP, ICC, comments) and anything after the end of the image are removed before the photo is checked, stored or served.
- **Check.** One Decisions API call with six yes/no flags and no overall verdict. A photo is approved when no flag's "yes" probability is above that flag's threshold. Otherwise it is rejected, naming those flags, most likely first. The check never answers `unsure`. The thresholds (`DEFAULT_FLAG_THRESHOLDS` in `worker/founderPhoto.ts`) were chosen by the operator in `tools/photo-lab` against 100 labelled photos (#160):

  | Flag | Counts when yes is above |
  | --- | --- |
  | `people` | 0.8 |
  | `lighting` | 0.8 |
  | `not_park` | 0.95 |
  | `inappropriate` | 0.9 |
  | `not_photo` | 0.95 |
  | `personal_info` | 0.9 |

  No answer within 8 s, an answer missing any flag, or no `OPENROUTER_API_KEY` is a retryable 503 (`photo_check_unavailable`). Before #160 the call also asked an overall `verdict` (approve, reject, unsure); a photo needed `approve` at 0.8 or more and no flag above 0.5, and anything else was `unsure`. Checks stored then keep their `verdict` answer and `threshold` in `moderation`; newer ones store `flagThresholds` instead.
- **Founding.** One transaction under an advisory lock on the park (`worker/founding.ts`): the founder guard, for an OpenStreetMap park the proposal audit row (with `founder_account_id`), the draft and the operator dashboard's publish statements, then the founder row with the photo, then closing pending review requests for the park as `superseded`, then `kip_game.record_visit`. The park's marker is a point inside the part of the outline the founder is in, never their position. A second founder gets 409.
- **Limits.** 20 photo checks an hour and 5 foundings a day per account.
- **Account deletion** removes the founder row, the photo and the bonus. The park stays and can be founded again.
- **Remove from map** (operator dashboard) takes a park off the map and unfounds it, but keeps its OpenStreetMap outline, so it can be founded again the same day ([below](#remove-from-map)).

## Where players start

- The park sheet's "Become the founder" card, shown only while the player stands inside a park with no founder.
- "Become a founder" in the map menu, for any park the player stands in.
- The visit result: in a park with no founder (and no photo waiting for review), it offers "Park photo · +24". It closes the result and starts founding for that park.

This is the only photo anyone takes in Parkdex ([PRODUCT.md](../PRODUCT.md)). The approved photo is the park's official photo everywhere: the park page and My Dex, for every player. It is no longer copied into the founder's own Dex as a private photo (that copy, from #222, was retired with personal photos on 2026-10-22).

## Player copy

Player-facing text never uses the verb "found" (found a park, founded, founding): it also reads as "discovered". It uses the noun instead: "Become the founder" on the park sheet, "Become a founder" in the map menu, "You're the founder of Beacon Hill Park" on success, "Founder: @robin" for someone else's park, and "@robin became the founder first" when a review loses the race. Identifiers such as `/api/parks/found`, `already_founded` and `park_founded` keep their names. `src/lib/founders.test.ts` and `src/lib/foundingReviews.test.ts` check the app's own messages for the verb.

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
  "photo": { "mime": "image/jpeg", "base64": "<JPEG bytes>", "width": 960, "height": 1280 }
}
```

200, founded (`visit` has the `POST /api/game/visits` shape; its `outcome` is `planted`, `took`, `held` or `already_today`):

```json
{
  "outcome": "founded",
  "park": { "id": "osm-way-23938892", "name": "Paterson Park" },
  "coverUrl": "https://web.parkdex.app/api/parks/osm-way-23938892/cover/<sha256>.jpg",
  "visit": { "visitId": "…", "parkId": "osm-way-23938892", "outcome": "planted", "pointsEarned": 6, "pointsBreakdown": { "base": 6, "days": 0 }, "previousHolder": null, "flagSince": "2026-10-09T04:46:43.368Z" },
  "founderPoints": 24
}
```

200, not approved (`message` is the first flag's message):

```json
{ "outcome": "rejected", "flags": [{ "code": "people", "message": "We spotted people. Take one without anyone in it." }], "message": "We spotted people. Take one without anyone in it." }
```

`unsure` stays a valid outcome in the contract, and installed apps handle it, but the server no longer sends it for new checks. Only a retry of an attempt checked as unsure before #160 still answers:

```json
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
- `POST /api/parks/found` adds `reviewableUntil` to `rejected` answers, and to the `unsure` answers of older checks (see [Manual review](#manual-review)).
- `POST /api/park-proposals` answers 410 `proposals_retired` with "Update Parkdex to add parks. Now you can become a park's founder while you're standing in it." Installed builds show messages up to 200 characters as the error and never retry, so 410 is safe; reviewing stored proposals stays in the operator dashboard.

## Manual review

When the photo check rejects a founding photo (`rejected`, or `unsure` for a check made before the overall verdict was dropped), the player can ask the operator to look at it (#153). Design decided with the operator on 2026-10-10.

### Rules

- **Photo outcomes only.** `rejected` and older `unsure` checks can be appealed. Not being in the park, hidden and unnamed parks, "already founded" and `photo_check_unavailable` stay hard failures.
- **Photo only.** The request reuses the stored attempt: the photo with its metadata already removed, the position, the target, the flags and the model's answers. The player sends only the `attemptId`, never the photo again, and no note.
- **Kept for a day.** The photo and position of a `rejected` or `unsure` check are kept for 24 hours (`kip_founders.check_photos`), then deleted by the daily retention run. A request keeps its own copy (`kip_founders.review_requests`) until 90 days after the decision. An approved photo lives on as the park's cover.
- **Limits.** 3 requests per account per Victoria day (America/Vancouver), and one pending request per account and park.
- **Approval** makes the player the founder, with that photo as the cover and the 10 point founder bonus, through the same founding transaction as an instant approval (`worker/founding.ts`), with **no visit and no flag**: flags still need a real visit that day. An OpenStreetMap target is published at approval time; one that has become a Parkdex park meanwhile is founded as that park.
- **Competition.** Other players can still found the park instantly while a request is pending. The first founding wins. Any founding, by either path, closes every pending request for that park as `superseded` in the same transaction.
- **Rejection** carries a short reason the player sees: a preset (people, too dark or blurry, not the park, inappropriate) or the operator's own words.
- **Feedback.** `GET /api/game/me` lists pending requests and each decision until the app marks it seen.

### `POST /api/parks/found` (addition)

`rejected` answers (and older `unsure` ones) add `reviewableUntil`, the time until which `POST /api/parks/found/review` can use this attempt (24 hours after the check). It is `null` when the photo is no longer kept. A retry with the same `attemptId` answers the same.

```json
{ "outcome": "rejected", "flags": [{ "code": "lighting", "message": "It's too dark or blurry. Take one in good light and hold the phone steady." }], "message": "It's too dark or blurry. Take one in good light and hold the phone steady.", "reviewableUntil": "2026-10-11T17:00:00.000Z" }
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
- `decided[].status` is `approved` ("You're the founder of X"), `rejected` ("Not approved: reason") or `superseded` (someone else became the founder first; `founderHandle` names them).
- `parkId` of an approved request is the park it founded, which can differ from the pending `parkId` when the outline turned out to be a Parkdex park. `coverUrl` is the current cover, or `null` once the cover is gone. `founderHandle` is the park's current founder, or `null`.

### Operator dashboard

Parks → Review (`/parks/review`) lists requests oldest first, with a pending count in the sidebar. Each request shows the full photo, the check's flags and probabilities, the player's handle, when the photo was taken, and the target outline or park on a map with the player's position and accuracy. Approve asks first and runs the founding transaction; Reject takes a preset or typed reason. Both write a `founding_review_decided` analytics event in the same transaction; an approval also writes `park_founded` (`via`: review). Routes are under `/api/parks/review` in `operator/server/parks/reviews.ts`, with the SQL in `worker/founding-reviews.ts`. A database without `founders_002` shows the tab as not deployed yet.

## Remove from map

The operator can take a park off the map and unfound it while keeping its OpenStreetMap outline, so the same area can be founded again straight away, for example to test founding with the same tester on the same day. Parks → a park → Visibility → **Remove from map** (`GET` and `POST /api/parks/:id/remove-from-map` in the dashboard, `operator/server/parks/removal.ts`). `GET` returns the plan the confirmation lists; `POST` takes no body.

What a new founding of the outline checks, and what the removal does about each:

| A founding checks | Remove from map |
| --- | --- |
| No founder row for the park (`already_founded`) | Deletes the `kip_founders.parks` row: the founder, the cover photo and, because `kip_game.player_scores` derives the bonus from that row (`kip_founders.founder_points`), the 24 points. A new founding pays the bonus once. |
| The outline's `osm-<type>-<id>` is not in `public.parks`, and `catalogueMatch` pairs it with no catalogue park nearby | Deletes the park with the same statements as Delete (draft, park, and by cascade its boundary, drive data, reader floor and hidden row), in one content revision whose park, boundary and drive tombstones phones apply on their next sync. |
| The outline is in `kip_osm.parks` and named | Keeps the outline. The in-app search marks it `inCatalogue: null` again. |
| No published draft holds the id (`founding_blocked`) | Deletes the draft. |
| 5 foundings in 24 hours per account | Counts founder rows, so the removed one no longer counts. 20 photo checks an hour still counts every check. |
| Today's visit (`kip_game.record_visit`) | Nothing to clear: a founding accepts `already_today`, so someone who visited the park today founds it again with that visit and no second flag or points. |
| Pending review requests for the park | Closes them, see below. |

- **One transaction** under the founding transaction's advisory lock on the park (`lockStatement` in `worker/founding.ts`), then the park row lock and the Delete guards, so a removal and a founding of the same park never interleave: either the founding lands first and the removal clears it, or the founding finds no park.
- **Pending reviews** for the park, or for its outline, are closed as `rejected` with `reason_code` `other` and the reason "The park was removed from the map before anyone reviewed it." The app shows "Your photo for X wasn't approved: the park was removed from the map before anyone reviewed it. You can try again next time you're there." `superseded` would tell the player someone else founded it.
- **Visits and flags** keep their park id as history, exactly as Delete leaves them. Nothing is deleted from other accounts, and no score changes except the founder's bonus. An open flag stays with its holder and falls on the usual 30-day rule; when the outline is founded again under the same id, that founding's visit plays against the flag like any visit.
- **Curated, legacy and proposed parks** can be removed when an outline in `kip_osm.parks` pairs with the park by `catalogueMatch` and with no other catalogue park. The best is the named one with the park's own name, then the largest. Founding it then publishes a new `osm-<type>-<id>` park; the curated id, its visits and its badge art stay behind as history.
- **Refused** (the dashboard disables the button and says why; `POST` answers 409): no outline in the table (`no_outline`), only an unnamed outline (`unnamed_outline`), an outline another Parkdex park also claims (`outline_is_other_park`), or a park in the art enrichment queue (`park_in_enrichment`). Delete still removes such a park for good.
- **Kept**: the outline, the founding's `kip_proposals.parks` audit row, photo checks, visits and tenures.
- **Analytics**: `park_removed` (`account_id` is the founder's, or null; `source`, `had_founder`, `founder_source`, `reviews_closed`, `outline`) and one `founding_review_decided` per closed request (`decision` rejected, `reason_code` park_removed), all with route `POST /operator/parks/:id/remove-from-map`, in the same transaction. `founders_003_park_removed.sql` adds the event type; a database without it still allows the removal and records only the review decisions.
- Works on the staging and production toggle and in demo mode (`MemoryParkRemovalStore` in `operator/server/parks/memory.ts`).

## Analytics

`founder_photo_checked` (`outcome`: approve, reject or unavailable, and unsure before #160; `flags`: comma-separated; `source`: osm_new or existing) for every check, and `park_founded` (`source`) for every founding, plus the usual visit outcome event. Routes group park IDs as `/api/parks/:park/...`.

`founding_review_requested` (`outcome`: reject or unsure; `source`: osm_new or existing) when a player asks for a review, and `founding_review_decided` (`decision`: approved or rejected; `reason_code`; `waited_minutes`) when the operator decides, with route `POST /operator/parks/review/:id/approve` or `/reject` and the player's account.

## Testing

- `worker/jpeg.test.ts`, `worker/park-location.test.ts`, `worker/founder-photo.test.ts`, `worker/founders.test.ts`, `worker/catalogue-match.test.ts` (far parts, holes and neighbours) and `worker/proposal-review.test.ts` (the boundary box query and its fallback).
- `worker/founding.test.ts` (the shared transaction), `operator/server/parks/reviews.test.ts` (the dashboard's review routes).
- `scripts/qa-founders-review-sql.mjs` (`npm run test:sql`, own throwaway database): keeping a rejected photo, asking for a review, approval through the dashboard routes (publish, founder, cover, bonus, no visit or flag), rejection, the supersede race, the daily limit, decisions in `/api/game/me`, retention and account deletion.
- `operator/server/parks/removal.test.ts` (Remove from map routes and the memory store) and `scripts/qa-park-removal-sql.mjs` (`npm run test:sql`, own throwaway database): found an OpenStreetMap park, remove it, the search offers it again, the same tester founds it again the same day with the bonus counted once, a curated park founded again from its outline, pending reviews closed with the reason, refusals, a database without `founders_003`, and a removal racing a founding.
- `scripts/qa-founders-sql.mjs` (`npm run test:sql`, own throwaway database): the full migration inventory replayed twice, then the real routes and stores for a new and a catalogue park, concurrent founders, the bonus, one visit per day, hidden parks, covers, summaries, analytics rows and account deletion, and a two-part park whose second part is 70 km from its pin: an outline there is marked and founded as the catalogue park, while outlines in its hole and next to the part are new parks (#182).
- Locally: `npm run local:api -- --content` installs the content tables so parks can be founded; load OpenStreetMap outlines with `scripts/osm_park_index.py` (`docs/osm-park-index.md`).
