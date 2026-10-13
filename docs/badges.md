# Badges

Achievement badges made from park art (#175, part of #168). They are decorative: they never add points. Players sew up to 3 onto their flag, and everyone who sees the flag sees them.

## Badges and rules

The server decides what is unlocked. Each badge is a metric with a goal in `kip_game.badge_rules()` (`database/migrations/game_004_badges.sql`); the app's list in `src/lib/game/badges.ts` gives each one its name, hint, frame and art, and `src/lib/game/badges.test.ts` keeps the two lists in step.

| ID | Name | Rule | Rarity |
| --- | --- | --- | --- |
| `parks-1`, `-10`, `-25`, `-50`, `-100` | Over the Bridge, Swimming Upstream, Trestle Walker, Edge of the Map, Old Growth | Distinct parks visited | common, uncommon, uncommon, rare, legendary |
| `regular-3`, `-10`, `-25` | Creature of Habit, Part of the Scenery, Arbutus Roots | Distinct Victoria days at one park | common, uncommon, rare |
| `planter-5` | Seed Planter | Visits that planted a flag in an empty park | uncommon |
| `taker-5`, `-25` | Sea Lion's Share, Eight Arms | Visits that took a flag | uncommon, rare |
| `hold-7`, `-30` | King of the Hill, Lighthouse Keeper | Whole days one holding lasted | uncommon, legendary |
| `crew-1`, `-10` | Shore Party, Beach Crew | Flags held in a crew of 2 or more, as leader or member | common, rare |
| `biomes-5` | Falls Chaser | Distinct catalogue biomes of the parks visited | uncommon |
| `regions-3` | Plateau Pathfinder | Distinct catalogue regions of the parks visited | uncommon |
| `founder` | Spelunker | Parks founded | rare |
| `coast-to-coast` | Coast to Coast | A park visited in British Columbia and one in Nova Scotia | legendary |

- **Visited parks** come from visits of any outcome (including `logged` and `joined`) and from claims, like My Dex, so a claim backed up since the last deploy counts at once.
- **Holding** runs from planting, taking or joining to the earliest of the tenure's end, its fall and now. A flag is down at its fall, so one nobody revisits flies just under 30 days: `hold-30` needs a return visit.
- **Provinces** come from the region label through `kip_game.region_province`, which mirrors `src/lib/dex/regions.ts`. Add a new region label to both.
- A badge unlocks once and stays unlocked, even if a park is later hidden or a rule changes.

### When badges unlock

- In the same transaction as each visit (`kip_game.record_visit_with_badges`), crew join (`kip_game.join_crew_with_badges`, which also checks the rest of the crew) and instant founding (`kip_game.award_badges` after the founding visit). The response lists them, and a replay of the request lists the same ones (`player_badges.visit_id`).
- On every `GET /api/game/me`, for badges that unlock with time (`hold-7`, `hold-30`) or through someone else's action: a friend joining your crew, or an operator approving your founding review.
- Concurrent visits can each miss a goal the other reaches; the next `/api/game/me` catches it.

## Art

`public/art/achievements/<badge-id>.webp` is bundled with the app, so badges work in every environment and ship with an over-the-air update. Each image is a published staging CDN scene (catalogue revision 160), SHA-256 checked, resized to 384 by 384. `sources.json` beside them records each scene slug, source SHA-256, park ID and the bundled file's SHA-256. `coast-to-coast` uses the generic `coast-a` scene. Never use unpublished art from `.codex/park-enrichment/`.

The frame is the park badge's: the shapes and rarity rims from `src/components/Badge.tsx` (`AchievementBadge`).

## Flag patches

- `kip_game.players.flag_patches text[]`: at most 3 (a table check), and `kip_game.set_flag_patches` only accepts unlocked badges, in the order sewn on.
- Patches are drawn on top of the generated flag (`src/lib/game/patches.ts`). `src/lib/game/flag.ts` is never changed, so every seed still draws the same flag. Patches sit along the bottom of the cloth from the fly; flags under 40 px wide show 2, under 28 px 1.
- They show on the identity card, the badge shelf, the park sheet holder row and the leaderboard. Map pins show the holder's first patch from zoom 13.5, as a separate pin-sized image over the pin.

## API

All additions are additive: older builds ignore them, and the app reads every field as optional.

- `POST /api/game/visits`, `POST /api/game/crews/join` and `POST /api/parks/found` add `newBadges: [{ id, unlockedAt }]`.
- `GET /api/game/me` adds `badges: [{ id, progress, goal, unlockedAt }]` (every rule, in shelf order), `flagPatches: string[]` and `newBadges`.
- `PUT /api/game/me/patches` with `{ "patches": ["hold-7", "parks-1"] }` (CSRF or bearer) answers `{ patches }`. Errors: `400 invalid_patches` (more than 3, repeats or malformed IDs), `409 badge_locked`, `409 handle_required`, `410 account_deleting`.
- `GET /api/game/flags` and `GET /api/game/leaderboard` rows, and crew `leader` and `members` (`GET /api/game/parks/:park/crew`, crew joins), add `patches: string[]`.

Analytics: `badge_unlocked` (with `badge_id`, and `park_id` for a visit) and `flag_patches_set` (with `patches`, the number worn). `game_004_badges.sql` adds them to the event checks the way `game_003_crews.sql` adds the crew types.

## App

- **Badge shelf** at the top of My Dex: earned badges in colour, locked ones as silhouettes with their hint and progress. A badge earned since the device last opened it is marked New. Tap a badge to sew it on or take it off. The shelf shows for players with a handle on a server that sends `badges`.
- **Unlock moment** on the visit result and the founding celebration, and Kip's Tip `badge-first` the first time a badge is earned.
- Collector ranks and the `rankProgression` flag are gone from the app. The server still lists the flag for installed builds.
