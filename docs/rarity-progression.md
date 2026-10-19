# Park rarity progression

The active 100-park assignment is recorded in `database/catalogue/victoria-rarities-20260928.json`. It contains 89 Common, 10 Uncommon, one Rare and no Legendary parks. The sole Rare is Sooke Potholes Regional Park (`regional-sooke-potholes-regional-park`). `database/catalogue/victoria-rarity-downshift-20260928.json` records the 41 reviewed changes from the previous 59/30/10/1 assignment. The historical rollout seed is unchanged.

## Ranks (retired)

Collector ranks, which opened one rarity tier at 2, 5 and 10 unique parks, and the `rankProgression` flag that switched them on, were removed from the app in #175. Every rarity is open. Achievement badges replace them as the long-term goals: [badges.md](badges.md).

## Map visibility

The map shows only parks with published badge art, plus any park already in the Dex. Parks without art have no marker, boundary, nearby card or arrival prompt, so they cannot be claimed until their art ships. The Dex total counts the same set.

Because only parks with art are claimable, publish Common art ahead of higher tiers.

## Historical data

The old Epic value remains supported in stored historical data. The active 100-park catalogue has no Epic assignments. Existing earned Epic parks remain accessible and count as visits; new Epic claims are unavailable.

## Publication

`scripts/downshift_park_rarities.py` plans and publishes the 41 rarity-only changes as one guarded Neon transaction. The content triggers emit one Changes API revision with full Park objects. Existing sync-capable installs apply the new rarity on their next connected content check at startup, foreground resume, or connectivity recovery; offline installs retain their cached rarity until they reconnect. The update does not alter badge art or saved claim snapshots. Badge generation preserves the assigned rarity. App changes follow the normal PR checks, staging and Android release lifecycle.
