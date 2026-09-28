import { describe, expect, it } from "vitest";
import {
  assertParkClaimEligible,
  getCollectionRankProgress,
  getParkRarityEligibility,
  getRarityProgress,
  ParkAlreadyClaimedError,
  ParkClaimEligibilityError,
  RARITY_REQUIREMENTS,
  type RarityClaim,
  type RarityCatalogue,
} from "./progression";
import type { Park, Rarity } from "./parks";

function claimsWith(counts: Partial<Record<Rarity, number>>): Record<string, RarityClaim> {
  const claims: Record<string, RarityClaim> = {};
  for (const [rarity, count] of Object.entries(counts) as [Rarity, number][]) {
    for (let index = 0; index < count; index += 1) {
      const id = `${rarity}-${index}`;
      claims[id] = { parkSnapshot: { id, rarity } };
    }
  }
  return claims;
}

function catalogueFor(claims: Record<string, RarityClaim>, overrides: Record<string, Rarity> = {}): Pick<Park, "id" | "rarity">[] {
  return Object.entries(claims).map(([id, claim]) => ({
    id,
    rarity: overrides[id] ?? claim.parkSnapshot?.rarity ?? "common",
  }));
}

describe("rarity progression", () => {
  it("exposes the tier thresholds as shared domain data", () => {
    expect(RARITY_REQUIREMENTS).toEqual({
      common: {},
      uncommon: { common: 4 },
      rare: { common: 10, uncommon: 3 },
      legendary: { common: 20, uncommon: 6, rare: 2 },
    });
  });

  it.each([
    { name: "starts at Scout with four Common needed", counts: {}, rank: "Scout", nextRank: "Explorer", remaining: { common: 4 } },
    { name: "stays Scout one Common short of Explorer", counts: { common: 3 }, rank: "Scout", nextRank: "Explorer", remaining: { common: 1 } },
    { name: "reaches Explorer at four Common", counts: { common: 4 }, rank: "Explorer", nextRank: "Adventurer", remaining: { common: 6, uncommon: 3 } },
    { name: "stays Explorer one Uncommon short of Adventurer", counts: { common: 10, uncommon: 2 }, rank: "Explorer", nextRank: "Adventurer", remaining: { common: 0, uncommon: 1 } },
    { name: "reaches Adventurer at ten Common and three Uncommon", counts: { common: 10, uncommon: 3 }, rank: "Adventurer", nextRank: "Legend", remaining: { common: 10, uncommon: 3, rare: 2 } },
    { name: "stays Adventurer one Rare short of Legend", counts: { common: 20, uncommon: 6, rare: 1 }, rank: "Adventurer", nextRank: "Legend", remaining: { common: 0, uncommon: 0, rare: 1 } },
    { name: "reaches Legend at the Legendary threshold", counts: { common: 20, uncommon: 6, rare: 2 }, rank: "Legend", nextRank: null, remaining: null },
  ] as const)("$name", ({ counts, rank, nextRank, remaining }) => {
    const claims = claimsWith(counts);
    const rankProgress = getCollectionRankProgress(getRarityProgress(claims, catalogueFor(claims)));

    expect(rankProgress.available).toBe(true);
    expect(rankProgress.rank).toBe(rank);
    if (nextRank) {
      expect(rankProgress.next).toMatchObject({ rank: nextRank, remaining });
    } else {
      expect(rankProgress.next).toBeNull();
    }
  });

  it("does not show Scout while the current owner catalogue is unavailable", () => {
    const claims = claimsWith({ common: 20, uncommon: 6, rare: 2 });

    expect(getCollectionRankProgress(getRarityProgress(claims))).toEqual({
      available: false,
      rank: null,
      openTiers: [],
      next: null,
    });
  });

  it("does not let duplicate claim rows advance the rank", () => {
    const claims = claimsWith({ common: 3 });
    claims.duplicate = { parkSnapshot: { id: "common-0", rarity: "common" } };
    const rankProgress = getCollectionRankProgress(getRarityProgress(claims, catalogueFor(claims)));

    expect(rankProgress).toMatchObject({ rank: "Scout", next: { rank: "Explorer", remaining: { common: 1 } } });
  });

  it("recomputes rank from current catalogue rarity after reclassification", () => {
    const claims = claimsWith({ common: 10, uncommon: 3 });
    const currentCatalogue = catalogueFor(claims, { "common-0": "uncommon" });
    const progress = getRarityProgress(claims, currentCatalogue);

    expect(progress.counts).toEqual({ common: 9, uncommon: 4, rare: 0 });
    expect(getCollectionRankProgress(progress)).toMatchObject({
      rank: "Explorer",
      next: { rank: "Adventurer", remaining: { common: 1, uncommon: 0 } },
    });
  });

  it("unlocks each tier only when every threshold is met", () => {
    const uncommonClaims = claimsWith({ common: 3 });
    const uncommonBefore = getRarityProgress(uncommonClaims, catalogueFor(uncommonClaims));
    expect(uncommonBefore.tiers.uncommon).toMatchObject({
      unlocked: false,
      current: { common: 3 },
      remaining: { common: 1 },
    });

    const rareClaims = claimsWith({ common: 10, uncommon: 2 });
    const rareBefore = getRarityProgress(rareClaims, catalogueFor(rareClaims));
    expect(rareBefore.tiers.rare).toMatchObject({
      unlocked: false,
      current: { common: 10, uncommon: 2 },
      remaining: { common: 0, uncommon: 1 },
    });

    const legendaryClaims = claimsWith({ common: 20, uncommon: 6, rare: 1 });
    const legendaryBefore = getRarityProgress(legendaryClaims, catalogueFor(legendaryClaims));
    expect(legendaryBefore.tiers.legendary).toMatchObject({
      unlocked: false,
      current: { common: 20, uncommon: 6, rare: 1 },
      remaining: { common: 0, uncommon: 0, rare: 1 },
    });

    const completeClaims = claimsWith({ common: 20, uncommon: 6, rare: 2 });
    const complete = getRarityProgress(completeClaims, catalogueFor(completeClaims));
    expect(complete.counts).toEqual({ common: 20, uncommon: 6, rare: 2 });
    expect(complete.highestUnlocked).toBe("legendary");
    expect(complete.tiers.legendary.unlocked).toBe(true);
  });

  it.each([
    { name: "rare stays locked at 9 Common and 3 Uncommon", counts: { common: 9, uncommon: 3 }, rarity: "rare", reason: "locked" },
    { name: "rare opens at 10 Common and 3 Uncommon", counts: { common: 10, uncommon: 3 }, rarity: "rare", reason: "unlocked" },
    { name: "Legendary stays locked at 19 Common, 6 Uncommon, and 2 Rare", counts: { common: 19, uncommon: 6, rare: 2 }, rarity: "legendary", reason: "locked" },
    { name: "Legendary stays locked at 20 Common, 5 Uncommon, and 2 Rare", counts: { common: 20, uncommon: 5, rare: 2 }, rarity: "legendary", reason: "locked" },
    { name: "Legendary opens at 20 Common, 6 Uncommon, and 2 Rare", counts: { common: 20, uncommon: 6, rare: 2 }, rarity: "legendary", reason: "unlocked" },
  ] as const)("$name", ({ counts, rarity, reason }) => {
    const claims = claimsWith(counts);
    const progress = getRarityProgress(claims, catalogueFor(claims));
    expect(getParkRarityEligibility({ id: "next-tier-park", rarity }, progress)).toMatchObject({
      eligible: reason === "unlocked",
      reason,
    });
  });

  it("counts each park ID once even when duplicate claim rows share a snapshot ID", () => {
    const claims = {
      first: { parkSnapshot: { id: "same-park", rarity: "common" as const } },
      duplicate: { parkSnapshot: { id: "same-park", rarity: "common" as const } },
    };
    const progress = getRarityProgress(claims, [{ id: "same-park", rarity: "common" }]);
    expect(progress.counts.common).toBe(1);
  });

  it("uses current catalogue rarity for known parks and snapshot rarity for removed parks", () => {
    const claims: Record<string, RarityClaim> = {
      reclassified: { parkSnapshot: { id: "reclassified", rarity: "rare" } },
      archived: { parkSnapshot: { id: "archived", rarity: "uncommon" } },
      missingSnapshot: { parkSnapshot: null },
    };
    const catalogue: RarityCatalogue = [
      { id: "reclassified", rarity: "common" },
      { id: "missingSnapshot", rarity: "rare" },
    ];

    expect(getRarityProgress(claims, catalogue).counts).toEqual({ common: 1, uncommon: 1, rare: 1 });
  });

  it("does not count archived claims without a rarity snapshot but preserves their earned access", () => {
    const claims = { archived: { parkSnapshot: null } };
    const progress = getRarityProgress(claims, []);

    expect(progress.counts).toEqual({ common: 0, uncommon: 0, rare: 0 });
    expect(getParkRarityEligibility({ id: "archived", rarity: "epic" }, progress, true))
      .toMatchObject({ eligible: true, reason: "already-earned" });
  });

  it("fails closed for new claims until a catalogue is available, but keeps earned parks accessible", () => {
    const claims = claimsWith({ common: 4 });
    const common = { id: "new-common", rarity: "common" as const };
    const unavailable = getRarityProgress(claims);

    expect(unavailable.available).toBe(false);
    expect(getParkRarityEligibility(common, unavailable)).toMatchObject({ eligible: false, reason: "unavailable" });
    expect(getParkRarityEligibility({ id: "common-0", rarity: "epic" }, unavailable, true))
      .toMatchObject({ eligible: true, reason: "already-earned" });
  });

  it("keeps earned parks accessible after rarity changes and rejects new epic claims", () => {
    const claims: Record<string, RarityClaim> = {
      earned: { parkSnapshot: { id: "earned", rarity: "common" } },
      ...claimsWith({ common: 3 }),
    };
    const catalogue = catalogueFor(claims, { earned: "legendary" });
    const progress = getRarityProgress(claims, catalogue);

    expect(getParkRarityEligibility({ id: "earned", rarity: "legendary" }, progress, true))
      .toMatchObject({
        eligible: true,
        reason: "already-earned",
        requirements: { common: 20, uncommon: 6, rare: 2 },
        remaining: { common: 17, uncommon: 6, rare: 2 },
      });
    expect(getParkRarityEligibility({ id: "new-epic", rarity: "epic" }, progress))
      .toMatchObject({ eligible: false, reason: "unsupported-rarity" });
  });

  it("blocks creation when backup hydrates the same park after claiming began, while earned viewing stays open", () => {
    const park = { id: "hydrated-during-check-in", rarity: "common" as const };
    const claimsBeforeHydration = claimsWith({ common: 4 });
    const catalogue = [...catalogueFor(claimsBeforeHydration), park];
    const beforeProgress = getRarityProgress(claimsBeforeHydration, catalogue);
    expect(getParkRarityEligibility(park, beforeProgress)).toMatchObject({ eligible: true, reason: "unlocked" });

    const claimsAfterHydration = {
      ...claimsBeforeHydration,
      [park.id]: { parkSnapshot: park },
    };
    const afterProgress = getRarityProgress(claimsAfterHydration, catalogue);
    expect(getParkRarityEligibility(park, afterProgress, true)).toMatchObject({ eligible: true, reason: "already-earned" });
    expect(() => assertParkClaimEligible(park, claimsAfterHydration, catalogue)).toThrowError(ParkAlreadyClaimedError);
  });

  it("allows scene-null skeleton parks once their tier is unlocked", () => {
    const claims = claimsWith({ common: 4 });
    const progress = getRarityProgress(claims, catalogueFor(claims));
    const skeletonPark = { id: "new-uncommon", rarity: "uncommon" as const, scene: null };

    expect(getParkRarityEligibility(skeletonPark, progress)).toMatchObject({ eligible: true, reason: "unlocked" });
  });

  it("asserts the final claim guard with actionable reason data", () => {
    const claims = claimsWith({ common: 3 });
    const catalogue = catalogueFor(claims);
    expect(() => assertParkClaimEligible({ id: "locked", rarity: "uncommon" }, claims, catalogue))
      .toThrowError(ParkClaimEligibilityError);
    try {
      assertParkClaimEligible({ id: "locked", rarity: "uncommon" }, claims, catalogue);
    } catch (error) {
      expect((error as ParkClaimEligibilityError).eligibility).toMatchObject({
        reason: "locked",
        remaining: { common: 1 },
      });
    }
    expect(() => assertParkClaimEligible({ id: "new-common", rarity: "common" }, claims))
      .toThrowError(expect.objectContaining({ eligibility: expect.objectContaining({ reason: "unavailable" }) }));
  });
});
