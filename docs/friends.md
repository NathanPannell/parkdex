# Friends

Signed-in players add friends by QR code, link or a typed friend code, and see a weekly board of the distinct parks each of them visited (#64). Everything is behind the `friends` feature flag (default off, [app-config.md](app-config.md)). Solo play never needs an account.

## Rules

- **Friend codes.** Every player with a handle has one permanent 8-character code from the shared alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0, 1, I, L or O). It is created on first use. "Get a new code" replaces it; the old code, QR and links stop working and friends stay. Crew codes (#170) use the same alphabet (`kip_social.random_code(length)`, `src/lib/social/codes.ts`).
- **Friendships** are mutual: adding a code makes both players friends at once. A player can have up to 200 friends. Removing a friend ends it for both.
- **Crewmates** (#170) can also add each other by handle, without a code: players who were in the same crew, as its leader or a member who joined, during the protected hour or after it. A crew join's result offers "Add @sara as a friend" (or "Add 3 crewmates as friends") for crewmates who aren't friends yet; one tap adds them all. It needs a connection, like the join it follows, so it has no outbox.
- **Weekly board.** The player and their friends, ranked by distinct parks with a counted visit (`kip_game.visits`, `source = 'visit'`) this game week. The week runs Monday to Sunday by the Victoria calendar day that visits already use (`kip_game.local_day`), and resets at Monday midnight in Victoria. Ties share a rank. Imported claims do not count.
- **Offline.** A code scanned, typed or opened from a link while offline waits in a per-account outbox on the device and is sent after the next account sync or when the device reconnects. A code the server refuses for good (unknown, your own, over the limit) is dropped with a message; anything else stays for the next try. The last board is kept on the device, so your own QR still shows offline.

## Links

Friend links are `https://<web host>/friend/CODE`, on the same host as account links. Android opens them through the App Link filter in `AndroidManifest.xml` (`pathPrefix="/friend/"`); the web serves the app there (`vercel.json`, no-store and noindex) and replaces the address with `/`. The link opens the leaderboard's Friends tab with an "Add this friend?" card. `src/lib/social/links.ts` routes several prefixes, so crew links add their own.

## API

All routes need a signed-in account with a handle (`409 handle_required` otherwise). Writes need the CSRF token on cookie sessions.

| Route | Answer |
| --- | --- |
| `GET /api/friends` | `{ code, week: { start, end, resetsAt }, players: [{ rank, handle, flagSeed, uniqueParks, isMe }], serverTime }`. Creates the code on first use. |
| `POST /api/friends` `{ code }` | `{ status: "added" \| "already_friends", friend: { handle, flagSeed } }`. Replays answer `already_friends`. Errors: 400 `invalid_friend_code`, 404 `friend_code_not_found`, 409 `own_friend_code`, 409 `too_many_friends`, 410 `account_deleting`. |
| `POST /api/friends/crewmate` `{ handle }` | The same answer as adding a code, for a player who was in a crew with you. The handle may start with `@`. Errors: 400 `invalid_request`, 404 `crewmate_not_found` (no such player, or never in a crew together), 409 `own_handle`, 409 `too_many_friends`, 410 `account_deleting`. |
| `DELETE /api/friends/:handle` | `{ removed: true }`, or 404 `friend_not_found`. |
| `POST /api/friends/code` | `{ code }`, a new code. |

Tables and functions are in `database/migrations/social_001_friends.sql` (`kip_social`); adding crewmates (`kip_social.add_crewmate`) is in `social_002_crewmates.sql`. Account deletion cascades through them.
