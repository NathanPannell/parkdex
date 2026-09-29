import { RARITY, type Rarity } from "./parks";
import { rankFor, type ParkRarityEligibility, type ProgressionRarity } from "./progression";

export const parksLabel = (count: number) => `${count} ${count === 1 ? "park" : "parks"}`;

/** "Opens at Wayfinder · 5 parks" for a locked tier. */
export function tierUnlockLabel(rarity: ProgressionRarity) {
  const rank = rankFor(rarity);
  return rank.parks === 0 ? "Open from the start" : `Opens at ${rank.name} · ${parksLabel(rank.parks)}`;
}

export function rarityLockMessage(eligibility: ParkRarityEligibility) {
  if (eligibility.reason === "unsupported-rarity") return "New Epic claims are unavailable";
  if (eligibility.reason === "unavailable") return "Checking saved progress";
  if (eligibility.reason === "locked") return `Visit ${eligibility.remaining} more ${eligibility.remaining === 1 ? "park" : "parks"} to unlock`;
  return "Available to claim";
}

export function rarityAccessibleStatus(park: Pick<{ rarity: Rarity }, "rarity">, eligibility: ParkRarityEligibility, artComingSoon: boolean) {
  const tier = RARITY[park.rarity].label;
  const access = eligibility.reason === "locked" || eligibility.reason === "unsupported-rarity"
    ? `Locked. ${rarityLockMessage(eligibility)}.`
    : eligibility.reason === "unavailable"
      ? "Rarity progress is loading."
      : eligibility.reason === "already-earned"
        ? "Already earned."
        : "Unlocked for claiming.";
  return `${tier} park. ${access}${artComingSoon ? " Badge art coming soon." : ""}`;
}
