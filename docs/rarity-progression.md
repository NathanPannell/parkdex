# Park rarity progression

The active 100-park assignment is recorded in `database/catalogue/victoria-rarities-20260928.json`. It contains 59 Common, 30 Uncommon, 10 Rare and one Legendary park. The sole Legendary is Sooke Potholes Regional Park (`regional-sooke-potholes-regional-park`). The historical rollout seed is unchanged.

## Unlock rules

| Parks available | Required unique park visits |
| --- | --- |
| Common | Available immediately |
| Uncommon | 4 Common |
| Rare | 10 Common and 3 Uncommon |
| Legendary | 20 Common, 6 Uncommon and 2 Rare |

A visit is a completed local park claim. Repeat visits to one park count once. Known park IDs count at their current catalogue rarity. If an earned park is removed from the active catalogue, its saved snapshot rarity remains a fallback. An unknown legacy park with no snapshot has no inferred rarity. An already earned park remains accessible even if its current tier is locked.

Artwork availability is separate from eligibility. An unlocked skeleton park can be visited and claimed before its badge illustration is published. Its placeholder visit counts toward progression. When artwork arrives, the collection can display it without rewriting the original claim snapshot, photo or content release provenance. Claims with existing artwork retain their recorded artwork version.

## Offline and account behavior

Progress is derived from the active owner's saved claims and catalogue. It is available offline and follows account backup, restore and guest attachment. It is not a new independent counter or a new server schema. Both the local snapshot contract and the account backup API already accept a null scene. Historical and offline claims remain valid backup records.

The client uses the same eligibility rules for park details, trip/arrival and camera entry, and the final claim save. Higher-tier parks remain visible with their requirements. Onboarding explains the four tiers. A short explanation is shown on the first view of each higher tier, with owner-scoped local presentation preferences and a way to revisit the requirements.

The old Epic value remains supported in stored historical data. The active 100-park catalogue has no Epic assignments. Existing earned Epic parks remain accessible; no new Epic unlock threshold is invented.

## Publication

The coordinated content task publishes rarity-only park updates through Neon and the Changes API. Badge generation preserves the assigned rarity. App changes follow the normal isolated preview, staging and Android release lifecycle. The first release may contain many placeholders while artwork is authored over time; progression does not wait for that artwork.
