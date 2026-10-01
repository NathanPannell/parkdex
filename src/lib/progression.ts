import type { Park } from "./parks";

export type ProgressionRarity = "common" | "uncommon" | "rare" | "legendary";

export const RARITY_TIERS: readonly ProgressionRarity[] = ["common", "uncommon", "rare", "legendary"];

// Each rank opens one rarity tier. Any park counts toward the next rank, once.
export const RANKS = Object.freeze([
  Object.freeze({ rarity: "common", name: "Fledgling", parks: 0 }),
  Object.freeze({ rarity: "uncommon", name: "Trailblazer", parks: 2 }),
  Object.freeze({ rarity: "rare", name: "Wayfinder", parks: 5 }),
  Object.freeze({ rarity: "legendary", name: "Island Legend", parks: 10 }),
] as const);

// Remote feature flag `rankProgression`. When off, every rarity is open and rank UI is hidden.
let rankProgressionEnabled = true;

export function setRankProgressionEnabled(enabled: boolean): void {
  rankProgressionEnabled = enabled;
}

export function isRankProgressionEnabled(): boolean {
  return rankProgressionEnabled;
}

export type Rank = (typeof RANKS)[number];
export type CollectionRank = Rank["name"];

export const RARITY_UNLOCK_PARKS: Readonly<Record<ProgressionRarity, number>> = Object.freeze(
  Object.fromEntries(RANKS.map((rank) => [rank.rarity, rank.parks])) as Record<ProgressionRarity, number>,
);

export function rankFor(rarity: ProgressionRarity): Rank {
  return RANKS.find((rank) => rank.rarity === rarity)!;
}

export type RarityClaim = {
  parkSnapshot: Pick<Park, "id" | "rarity"> | null;
};

export type RarityCatalogue =
  | ReadonlyMap<string, Pick<Park, "id" | "rarity">>
  | readonly Pick<Park, "id" | "rarity">[];

export type RarityTierProgress = {
  rarity: ProgressionRarity;
  unlocked: boolean;
  /** Unique parks needed to open this tier. */
  required: number;
  remaining: number;
};

export type RarityProgress = {
  /** False until the current content catalogue is available. */
  available: boolean;
  /** Unique parks in the Dex. */
  visited: number;
  highestUnlocked: ProgressionRarity;
  tiers: Record<ProgressionRarity, RarityTierProgress>;
};

export type CollectionRankProgress = {
  available: boolean;
  rank: Rank | null;
  visited: number;
  openTiers: ProgressionRarity[];
  next: (Rank & { remaining: number }) | null;
};

export type ParkRarityEligibility = {
  eligible: boolean;
  reason: "already-earned" | "unlocked" | "locked" | "unsupported-rarity" | "unavailable";
  /** Unique parks needed to open this park's tier; 0 when not applicable. */
  required: number;
  visited: number;
  remaining: number;
};

export class ParkClaimEligibilityError extends Error {
  constructor(readonly eligibility: ParkRarityEligibility) {
    super(eligibility.reason === "unavailable"
      ? "The current park catalogue is not ready yet."
      : eligibility.reason === "unsupported-rarity"
        ? "This park rarity is not available for new claims yet."
        : "Visit more parks to unlock this park's rarity before claiming it.");
    this.name = "ParkClaimEligibilityError";
  }
}

export class ParkAlreadyClaimedError extends Error {
  constructor(readonly parkId: string) {
    super("This park is already in your Dex.");
    this.name = "ParkAlreadyClaimedError";
  }
}

const NO_REQUIREMENT = { required: 0, visited: 0, remaining: 0 };

/** Eligibility while saved claims or the catalogue are still loading. */
export const UNAVAILABLE_ELIGIBILITY: ParkRarityEligibility = Object.freeze({ eligible: false, reason: "unavailable", ...NO_REQUIREMENT });

export function getRarityProgress(
  claims: Readonly<Record<string, RarityClaim>>,
  catalogue?: RarityCatalogue,
): RarityProgress {
  const available = catalogue !== undefined;
  const parks = new Set<string>();
  if (available) {
    // Snapshot identity is stable for archived claims. The map key covers old
    // rows whose snapshot is absent and matches the store's park-ID projection.
    for (const [claimKey, claim] of Object.entries(claims)) parks.add(claim.parkSnapshot?.id ?? claimKey);
  }
  const visited = parks.size;

  const tiers = {} as Record<ProgressionRarity, RarityTierProgress>;
  for (const rank of RANKS) {
    tiers[rank.rarity] = {
      rarity: rank.rarity,
      unlocked: !rankProgressionEnabled || visited >= rank.parks,
      required: rank.parks,
      remaining: rankProgressionEnabled ? Math.max(0, rank.parks - visited) : 0,
    };
  }

  const highestUnlocked = [...RARITY_TIERS].reverse().find((rarity) => tiers[rarity].unlocked) ?? "common";
  return { available, visited, highestUnlocked, tiers };
}

export function getCollectionRankProgress(progress: RarityProgress): CollectionRankProgress {
  if (!progress.available) return { available: false, rank: null, visited: 0, openTiers: [], next: null };

  const index = RARITY_TIERS.indexOf(progress.highestUnlocked);
  const next = RANKS[index + 1];
  return {
    available: true,
    rank: RANKS[index],
    visited: progress.visited,
    openTiers: RARITY_TIERS.slice(0, index + 1),
    next: next ? { ...next, remaining: progress.tiers[next.rarity].remaining } : null,
  };
}

/** The rank reached by adding one claim, or null when the claim does not rank up. */
export function rankUpAfter(before: RarityProgress, after: RarityProgress): Rank | null {
  if (!before.available || !after.available) return null;
  const from = RARITY_TIERS.indexOf(before.highestUnlocked);
  const to = RARITY_TIERS.indexOf(after.highestUnlocked);
  return to > from ? RANKS[to] : null;
}

export function getParkRarityEligibility(
  park: Pick<Park, "id" | "rarity">,
  progress: RarityProgress,
  alreadyClaimed = false,
): ParkRarityEligibility {
  const tier = progress.available && park.rarity !== "epic" ? progress.tiers[park.rarity] : null;
  const requirement = tier ? { required: tier.required, visited: progress.visited, remaining: tier.remaining } : NO_REQUIREMENT;
  if (alreadyClaimed) return { eligible: true, reason: "already-earned", ...requirement };
  if (!progress.available) return { eligible: false, reason: "unavailable", ...NO_REQUIREMENT };
  if (!tier) return { eligible: false, reason: "unsupported-rarity", ...NO_REQUIREMENT };
  return { eligible: tier.unlocked, reason: tier.unlocked ? "unlocked" : "locked", ...requirement };
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
