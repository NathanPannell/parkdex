# Crew flags

Friends who arrive at a park together hold it as a **crew** instead of taking the flag from each other (#170 server, #171 app, part of #168). The rules were decided with the operator on 2026-10-12.

## Rules

- **Protected hour.** Planting or taking a flag starts a 60-minute protected hour from the tenure's `started_at`. During it nobody outside the crew can take the flag. A member's later visit does not restart it.
- **Outsiders during the hour.** A visit from someone not in the crew is `logged` (+1). It counts for collections, badges and "same park" counts, leaves the flag alone, and does not use up the visitor's flag action for the day: after the hour they can visit again the same day and take the flag. At most one logged visit per account, park and day.
- **Crew code.** One code per protected hour: 6 characters from the friend code alphabet (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`), unique among open hours, valid until the hour ends. Only members see it. The app shares it as `https://<web host>/crew/CODE`, on the same App Link host as friend links.
- **Joining** needs a valid code inside the hour, a handle, no flag action (planted, took, held or joined) at that park today, and room in the crew: at most 8 people including the leader. A logged visit earlier the same day is fine. Joining is a visit with outcome `joined` (+2).
- **Holding together.** Every member holds the park from their own `joined_at`: holding points, parks held, Your Parks and the leaderboard. The leader is the planter or taker.
- **After the hour** the flag works as before. Any member's visit is `held` (+1) and restarts the 30-day fall for everyone. A take ends the flag for every member, and the taker's new flag starts its own protected hour.
- **Location** is checked by the app against the park outline, as for visits. The server does not check it.

The rules run on the server for every build. The `crews` feature flag (off by default, [app-config.md](app-config.md)) only hides the crew UI.

## Data

`database/migrations/game_003_crews.sql`:

- `kip_game.crew_members (tenure_id, account_id, joined_at, visit_id)`. The planter or taker is the first row. Tenures from before the migration have no rows; their holder still leads.
- `kip_game.crew_codes (tenure_id, code, expires_at, released)`, with a unique index on open codes. A code is released, and its value can be drawn again, only once it has expired.
- `visits.outcome` gains `joined` and `logged`. Daily uniqueness is one flag action (`visits_one_per_park_per_day_idx`, which now excludes `logged`) plus one logged visit (`visits_one_logged_per_park_per_day_idx`).
- `kip_game.record_visit` and `kip_game.join_crew` take the same per-park advisory lock.
- `kip_game.holdings` adds members, so `player_scores`, the leaderboard and `/api/game/me` include them. `kip_game.flag_crews(now)` feeds map pins. `flags_up` keeps its columns.

## API

All routes are under `/api/game`. Badges (#175) add `patches` to the crew's `leader` and `members`, and `newBadges` to a join ([badges.md](badges.md)). Errors use the usual `{ error: { code, message }, code, message }` body.

### `POST /api/game/visits`

Unchanged request. The response's `visit` gains:

- `outcome: "logged"`, with `pointsEarned: 1`, `pointsBreakdown: { base: 1, days: 0 }` and `flagSince: null`.
- `protected`: `null`, or for a logged visit (and an `already_today` during someone else's hour):

```json
{ "until": "2026-10-13T18:00:00.000Z", "leader": { "handle": "bee", "flagSeed": "fedcba9876543210" }, "crewSize": 3 }
```

A crew member's visit returns `held` as before.

### `POST /api/game/crews/join`

Signed in, with CSRF for cookie sessions. Body `{ "visitId": "<uuid>", "code": "K7QX2M" }`. The code is case-insensitive and may contain spaces or dashes. The `visitId` is a new client UUID; resending it returns the same answer.

`200`:

```json
{
  "status": "joined",
  "visit": { "visitId": "…", "parkId": "…", "outcome": "joined", "pointsEarned": 2, "pointsBreakdown": { "base": 2, "days": 0 },
             "previousHolder": null, "flagSince": "…", "protected": null },
  "crew": { "…": "see Crew below" }
}
```

`status` is `already_member` (with `visit: null`) when the account is already in this crew.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_code` | Bad body, or a code that is not 6 characters of the alphabet |
| 404 | `code_not_found` | No crew has ever had this code |
| 410 | `code_expired` | The hour is over, or the flag was taken |
| 409 | `crew_full` | 8 people already |
| 409 | `already_today` | A flag action at this park today already |
| 409 | `handle_required` | No handle yet |
| 404 | `park_not_found` | The park was hidden |
| 410 | `account_deleting` | The account is being deleted |
| 409 | `visit_id_reused` | The visit ID was used for something else |

### `GET /api/game/parks/:parkId/crew`

Signed in. `{ "parkId": "…", "crew": Crew | null, "serverTime": "…" }`, null when no flag is up. Reading a crew with its code records `crew_code_shown`, so the app should call this when it shows the code, not on every map refresh.

**Crew**:

```json
{
  "parkId": "municipal-beacon-hill-park",
  "leader": { "handle": "bee", "flagSeed": "fedcba9876543210" },
  "members": [
    { "handle": "bee", "flagSeed": "fedcba9876543210", "joinedAt": "2026-10-13T17:00:00.000Z", "leader": true },
    { "handle": "sam", "flagSeed": "0123456789abcdef", "joinedAt": "2026-10-13T17:12:00.000Z", "leader": false }
  ],
  "size": 2,
  "cap": 8,
  "flagSince": "2026-10-13T17:00:00.000Z",
  "protectedUntil": "2026-10-13T18:00:00.000Z",
  "member": true,
  "code": "K7QX2M",
  "codeExpiresAt": "2026-10-13T18:00:00.000Z"
}
```

`protectedUntil` is null after the hour. `code` and `codeExpiresAt` are null unless the reader is a member and the hour is still on.

### `GET /api/game/flags`

Each flag gains `crew: { size, memberSeeds, protectedUntil }`. The leader is the flag's own `handle` and `flagSeed`; `memberSeeds` holds up to 3 more, earliest first.

### `GET /api/game/me`

- Each of `parks` gains `crew: { size, leader, protectedUntil }`. A member's parks are listed like the leader's; `since` is the flag's age and `hours` counts from the member's own join.
- `visitedToday` lists parks with a flag action today. New `loggedToday` lists parks with only a logged visit, which can still be taken after the hour.
- `takeovers` also lists flags the player held as a crew member.

## App (#171)

Every build reads `logged` and `joined`, and the `protected` details, whatever the `crews` flag says (`src/lib/game/client.ts`). With the flag off, a logged visit shows "Visit logged" and "This flag was just planted. Come back after 3:42 pm to take it." The flag only shows the crew UI:

- **Park page** (`ParkSheet.tsx`, `CrewPanel.tsx`), from `crewPhase()` in `src/lib/game/crew.ts`:
  - leader during the hour: "Your flag is protected · 58 min", **Show crew code** and the crew list
  - member: "You're in @tom's crew · protected 42 min", the same button and list
  - outsider: "@tom's crew flag is protected · 42 min", "Ask the crew for their code to join", and inside the park **Scan crew code** with **Log visit**. After logging: "Visit logged · +1. Come back after 3:42 pm to take this park."
  - after the hour: the usual states, with the crew list and "Crew window closed" under the holder row
- The park page reads `GET /api/game/parks/:parkId/crew` once when it opens, for leaders, members and closed crews only, and the code sheet reads it once when it opens. Map refreshes never call it.
- **Bottom bar:** "Log" for outsiders during the hour, "Later" once logged, and "Join" while a scanned code waits for the park you stand in.
- **Crew code sheet** (`CrewSheets.tsx`): the QR of `https://<web host>/crew/CODE?park=<parkId>`, the code in large letters, the countdown and "Anyone in the crew can show this code". It keeps the screen on through the Screen Wake Lock API where the browser or WebView has it.
- **Joining:** the in-app scanner (`QrScanner.tsx`, with "Type code instead"), or the `/crew/` App Link (`AndroidManifest.xml`) and web path (`vercel.json`, no-store and noindex), open the join card: "Join @tom's crew at Beacon Hill · +2", the crew, Join and Cancel. The link's `park` names the park; a code typed on a park page is for that park; otherwise it is the park you stand in. Join goes through sign-in, the handle sheet and the in-park check ("Get inside Beacon Hill Park to join").
- **Result:** the plant scene hoists the player's pennant up the leader's pole, counts +2 and lists the crew. With the `friends` flag on, it offers "Add @sara as a friend?" for members who aren't friends yet; the friends API adds by code only, so the button opens the player's own friend code to scan.
- **Map pins** (`mapPins.ts`): the leader's flag with up to 3 pennants in members' colours below it, a "+N" tag for bigger crews, and a gold shield during the hour. The image ID adds `crew:<size>:<p|o>:<member seeds>` to the flag's own ID. `flag.ts` is unchanged.
- **Kip's Tips:** `crew-leader`, `crew-outsider` and `crew-joined`.

## Analytics

`crew_joined`, `crew_code_shown` and `visit_logged_protected`, each with `crew_size`. A logged visit emits `visit_logged_protected` instead of a `flag_*` event.
