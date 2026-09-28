import { RARITY, type Rarity } from "./parks";
import type { ParkRarityEligibility, RarityRequirement } from "./progression";

const REQUIREMENT_ORDER = ["common", "uncommon", "rare"] as const;

export function formatRarityRequirements(requirements: RarityRequirement) {
  return REQUIREMENT_ORDER
    .filter((rarity) => (requirements[rarity] ?? 0) > 0)
    .map((rarity) => `${requirements[rarity]} ${RARITY[rarity].label} ${requirements[rarity] === 1 ? "badge" : "badges"}`)
    .join(" + ");
}

export function formatRarityRemaining(eligibility: ParkRarityEligibility) {
  return REQUIREMENT_ORDER
    .filter((rarity) => (eligibility.remaining[rarity] ?? 0) > 0)
    .map((rarity) => `${eligibility.remaining[rarity]} ${RARITY[rarity].label}`)
    .join(" + ");
}

export function rarityLockMessage(eligibility: ParkRarityEligibility) {
  if (eligibility.reason === "unsupported-rarity") return "New Epic claims are unavailable";
  if (eligibility.reason === "unavailable") return "Checking saved progress";
  if (eligibility.reason === "locked") {
    const remaining = formatRarityRemaining(eligibility);
    return remaining ? `Needs ${remaining}` : "Rarity locked";
  }
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
