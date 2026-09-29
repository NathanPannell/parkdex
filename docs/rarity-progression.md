# Park rarity progression

The active 100-park assignment is recorded in `database/catalogue/victoria-rarities-20260928.json`. It contains 59 Common, 30 Uncommon, 10 Rare and one Legendary park. The sole Legendary is Sooke Potholes Regional Park (`regional-sooke-potholes-regional-park`). The historical rollout seed is unchanged.

## Ranks and unlock rules

Every unique park in the Dex counts toward the next rank, whatever its rarity. Each rank opens one rarity tier.

| Collector rank | Unique parks visited | Opens |
| --- | --- | --- |
| Fledgling | 0 | Common |
| Trailblazer | 2 | Uncommon |
| Wayfinder | 5 | Rare |
| Island Legend | 10 | Legendary |

The rules live in `src/lib/progression.ts` (`RANKS`). Ranks have no separate persistence, purchase rules or claim entitlements. Restored claims immediately produce the same rank as the Dex.

A visit is a completed local park claim. Repeat visits to one park count once. Archived claims count by their saved park ID even when the park has left the catalogue. An already earned park remains accessible even if its current tier is locked, including after a reclassification.

## Where players see it

- **My Dex** has one rank card: the current rank, a progress bar and the parks left to the next rank. Tapping it opens the rank trail, which lists all four ranks, what each opens and how far away it is.
- **The map counter** shows the rank and the parks left to rank up.
- **A park sheet** for a locked park names the rank that opens it and shows the parks visited against the threshold.
- **The rank-up screen** appears after the claim that reaches a new rank. It names the rank, the rarity it opens and links to the map.
- **Onboarding** step 4 shows the four ranks and their thresholds.

The account screen does not show rank; it covers the profile, backup and sign-in only.

## Map visibility

The map shows only parks with published badge art, plus any park already in the Dex. Parks without art have no marker, boundary, nearby card or arrival prompt, so they cannot be claimed until their art ships. The Dex total counts the same set.

Because only parks with art are claimable, a new player needs at least two Common parks with art to reach Trailblazer. Publish Common art ahead of higher tiers.

## Offline and account behavior

Progress is derived from the active owner's saved claims and catalogue. It is available offline and follows account backup, restore and guest attachment. It is not a new independent counter or a new server schema. The rank display stays in a loading state until the owner's claims and the catalogue are ready.

The client uses the same eligibility rules for park details, trip/arrival and camera entry, and the final claim save. Eligibility is enforced only on the client.

The old Epic value remains supported in stored historical data. The active 100-park catalogue has no Epic assignments. Existing earned Epic parks remain accessible and count as visits; new Epic claims are unavailable.

## Publication

The coordinated content task publishes rarity-only park updates through Neon and the Changes API. Badge generation preserves the assigned rarity. App changes follow the normal isolated preview, staging and Android release lifecycle.
