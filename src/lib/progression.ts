import type { Park, Rarity } from "./parks";

export type ProgressionRarity = "common" | "uncommon" | "rare" | "legendary";
export type RarityCounts = { common: number; uncommon: number; rare: number };
export type RarityRequirement = Partial<RarityCounts>;

export const RARITY_TIERS: readonly ProgressionRarity[] = ["common", "uncommon", "rare", "legendary"];

export const RARITY_REQUIREMENTS: Readonly<Record<ProgressionRarity, Readonly<RarityRequirement>>> = Object.freeze({
  common: Object.freeze({}),
  uncommon: Object.freeze({ common: 4 }),
  rare: Object.freeze({ common: 10, uncommon: 3 }),
  legendary: Object.freeze({ common: 20, uncommon: 6, rare: 2 }),
});

export type RarityClaim = {
  parkSnapshot: Pick<Park, "id" | "rarity"> | null;
};

export type RarityCatalogue =
  | ReadonlyMap<string, Pick<Park, "id" | "rarity">>
  | readonly Pick<Park, "id" | "rarity">[];

export type RarityTierProgress = {
  rarity: ProgressionRarity;
  unlocked: boolean;
  requirements: RarityRequirement;
  current: RarityRequirement;
  remaining: RarityRequirement;
};

export type RarityProgress = {
  /** False until the current content catalogue is available. */
  available: boolean;
  counts: RarityCounts;
  highestUnlocked: ProgressionRarity;
  tiers: Record<ProgressionRarity, RarityTierProgress>;
};

export const COLLECTION_RANKS = Object.freeze({
  common: "Scout",
  uncommon: "Explorer",
  rare: "Adventurer",
  legendary: "Legend",
} as const satisfies Record<ProgressionRarity, string>);

export type CollectionRank = (typeof COLLECTION_RANKS)[ProgressionRarity];

export type CollectionRankProgress = {
  available: boolean;
  rank: CollectionRank | null;
  openTiers: ProgressionRarity[];
  next: {
    rank: CollectionRank;
    rarity: ProgressionRarity;
    requirements: RarityRequirement;
    current: RarityRequirement;
    remaining: RarityRequirement;
  } | null;
};

export type ParkRarityEligibility = {
  eligible: boolean;
  reason: "already-earned" | "unlocked" | "locked" | "unsupported-rarity" | "unavailable";
  requirements: RarityRequirement;
  current: RarityRequirement;
  remaining: RarityRequirement;
};

export class ParkClaimEligibilityError extends Error {
  constructor(readonly eligibility: ParkRarityEligibility) {
    super(eligibility.reason === "unavailable"
      ? "The current park catalogue is not ready yet."
      : eligibility.reason === "unsupported-rarity"
        ? "This park rarity is not available for new claims yet."
        : "Unlock this park's rarity tier before claiming it.");
    this.name = "ParkClaimEligibilityError";
  }
}

export class ParkAlreadyClaimedError extends Error {
  constructor(readonly parkId: string) {
    super("This park is already in your Dex.");
    this.name = "ParkAlreadyClaimedError";
  }
}

const ZERO_COUNTS: RarityCounts = { common: 0, uncommon: 0, rare: 0 };

function catalogueMap(catalogue: RarityCatalogue): ReadonlyMap<string, Pick<Park, "id" | "rarity">> {
  return Array.isArray(catalogue)
    ? new Map(catalogue.map((park) => [park.id, park]))
    : catalogue as ReadonlyMap<string, Pick<Park, "id" | "rarity">>;
}

function countForRarity(counts: RarityCounts, rarity: Rarity | undefined): void {
  if (rarity === "common" || rarity === "uncommon" || rarity === "rare") counts[rarity] += 1;
}

function requirementState(requirements: RarityRequirement, counts: RarityCounts) {
  const current: RarityRequirement = {};
  const remaining: RarityRequirement = {};
  let unlocked = true;
  for (const rarity of ["common", "uncommon", "rare"] as const) {
    const required = requirements[rarity];
    if (required === undefined) continue;
    current[rarity] = counts[rarity];
    remaining[rarity] = Math.max(0, required - counts[rarity]);
    if (counts[rarity] < required) unlocked = false;
  }
  return { unlocked, current, remaining };
}

export function getRarityProgress(
  claims: Readonly<Record<string, RarityClaim>>,
  catalogue?: RarityCatalogue,
): RarityProgress {
  const available = catalogue !== undefined;
  const counts = { ...ZERO_COUNTS };

  if (catalogue !== undefined) {
    const parks = catalogueMap(catalogue);
    const counted = new Set<string>();
    for (const [claimKey, claim] of Object.entries(claims)) {
      // Snapshot identity is stable for archived claims. The map key covers old
      // rows whose snapshot is absent and matches the store's park-ID projection.
      const parkId = claim.parkSnapshot?.id ?? claimKey;
      if (counted.has(parkId)) continue;
      counted.add(parkId);
      const rarity = parks.get(parkId)?.rarity ?? claim.parkSnapshot?.rarity;
      countForRarity(counts, rarity);
    }
  }

  const tiers = {} as Record<ProgressionRarity, RarityTierProgress>;
  for (const rarity of RARITY_TIERS) {
    const requirements = RARITY_REQUIREMENTS[rarity];
    const state = requirementState(requirements, counts);
    tiers[rarity] = { rarity, requirements: { ...requirements }, ...state };
  }

  const highestUnlocked = [...RARITY_TIERS].reverse().find((rarity) => tiers[rarity].unlocked) ?? "common";
  return { available, counts, highestUnlocked, tiers };
}

export function getCollectionRankProgress(progress: RarityProgress): CollectionRankProgress {
  if (!progress.available) return { available: false, rank: null, openTiers: [], next: null };

  const currentTierIndex = RARITY_TIERS.indexOf(progress.highestUnlocked);
  const nextRarity = RARITY_TIERS[currentTierIndex + 1];
  const nextTier = nextRarity ? progress.tiers[nextRarity] : null;

  return {
    available: true,
    rank: COLLECTION_RANKS[progress.highestUnlocked],
    openTiers: RARITY_TIERS.slice(0, currentTierIndex + 1),
    next: nextRarity && nextTier
      ? {
        rank: COLLECTION_RANKS[nextRarity],
        rarity: nextRarity,
        requirements: { ...nextTier.requirements },
        current: { ...nextTier.current },
        remaining: { ...nextTier.remaining },
      }
      : null,
  };
}

export function getParkRarityEligibility(
  park: Pick<Park, "id" | "rarity">,
  progress: RarityProgress,
  alreadyClaimed = false,
): ParkRarityEligibility {
  if (alreadyClaimed) {
    if (progress.available && park.rarity !== "epic") {
      const tier = progress.tiers[park.rarity];
      return {
        eligible: true,
        reason: "already-earned",
        requirements: { ...tier.requirements },
        current: { ...tier.current },
        remaining: { ...tier.remaining },
      };
    }
    return { eligible: true, reason: "already-earned", requirements: {}, current: {}, remaining: {} };
  }
  if (!progress.available) {
    return { eligible: false, reason: "unavailable", requirements: {}, current: {}, remaining: {} };
  }
  if (park.rarity === "epic") {
    return { eligible: false, reason: "unsupported-rarity", requirements: {}, current: {}, remaining: {} };
  }

  const tier = progress.tiers[park.rarity];
  return {
    eligible: tier.unlocked,
    reason: tier.unlocked ? "unlocked" : "locked",
    requirements: { ...tier.requirements },
    current: { ...tier.current },
    remaining: { ...tier.remaining },
  };
}

export function assertParkClaimEligible(
  park: Pick<Park, "id" | "rarity">,
  claims: Readonly<Record<string, RarityClaim>>,
  catalogue?: RarityCatalogue,
): ParkRarityEligibility {
  if (claims[park.id]) throw new ParkAlreadyClaimedError(park.id);
  const eligibility = getParkRarityEligibility(park, getRarityProgress(claims, catalogue));
  if (!eligibility.eligible) throw new ParkClaimEligibilityError(eligibility);
  return eligibility;
}
