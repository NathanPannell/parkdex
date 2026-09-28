# Park rarity progression

The active 100-park assignment is recorded in `database/catalogue/victoria-rarities-20260928.json`. It contains 59 Common, 30 Uncommon, 10 Rare and one Legendary park. The sole Legendary is Sooke Potholes Regional Park (`regional-sooke-potholes-regional-park`). The historical rollout seed is unchanged.

## Unlock rules

| Parks available | Required unique park visits |
| --- | --- |
| Common | Available immediately |
| Uncommon | 4 Common |
| Rare | 10 Common and 3 Uncommon |
| Legendary | 20 Common, 6 Uncommon and 2 Rare |

## Collector ranks

Ranks are a display of the highest rarity tier currently unlocked. They use the same unique-claim counts and current catalogue classifications as rarity access.

| Highest tier unlocked | Collector rank | Next rank requirements |
| --- | --- | --- |
| Common | Scout | 4 Common |
| Uncommon | Explorer | 10 Common and 3 Uncommon |
| Rare | Adventurer | 20 Common, 6 Uncommon and 2 Rare |
| Legendary | Legend | All four ranks unlocked |

The next-rank line shows the remaining unique visits needed for that threshold. Ranks do not have separate persistence, purchase rules or claim entitlements. Restored claims immediately produce the same rank as the Dex, and a catalogue reclassification can change the derived rank while an already earned park stays accessible.

A visit is a completed local park claim. Repeat visits to one park count once. Known park IDs count at their current catalogue rarity. If an earned park is removed from the active catalogue, its saved snapshot rarity remains a fallback. An unknown legacy park with no snapshot has no inferred rarity. An already earned park remains accessible even if its current tier is locked.

Artwork availability is separate from eligibility. An unlocked skeleton park can be visited and claimed before its badge illustration is published. Its placeholder visit counts toward progression. Known parks display their current catalogue rarity and adopt current artwork once the new asset is saved locally. Until then, their previous artwork or placeholder remains visible. Removed parks use their saved snapshot. These display updates never rewrite the original claim snapshot, photo or content release provenance.

## Offline and account behavior

Progress is derived from the active owner's saved claims and catalogue. It is available offline and follows account backup, restore and guest attachment. It is not a new independent counter or a new server schema. Both the local snapshot contract and the account backup API already accept a null scene. Historical and offline claims remain valid backup records. The rank display uses this same owner-safe progress and stays in a loading state until the owner's claims and the catalogue are ready.

The client uses the same eligibility rules for park details, trip/arrival and camera entry, and the final claim save. Higher-tier parks remain visible with their requirements. Onboarding explains the four tiers. A short explanation is shown on the first view of each higher tier, with owner-scoped local presentation preferences and a way to revisit the requirements.

The old Epic value remains supported in stored historical data. The active 100-park catalogue has no Epic assignments. Existing earned Epic parks remain accessible; no new Epic unlock threshold is invented.

## Publication

The coordinated content task publishes rarity-only park updates through Neon and the Changes API. Badge generation preserves the assigned rarity. App changes follow the normal isolated preview, staging and Android release lifecycle. The first release may contain many placeholders while artwork is authored over time; progression does not wait for that artwork.
