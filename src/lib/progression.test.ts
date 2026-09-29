import { describe, expect, it } from "vitest";
import {
  assertParkClaimEligible,
  getCollectionRankProgress,
  getParkRarityEligibility,
  getRarityProgress,
  ParkAlreadyClaimedError,
  ParkClaimEligibilityError,
  RANKS,
  rankUpAfter,
  RARITY_UNLOCK_PARKS,
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

function progressFor(counts: Partial<Record<Rarity, number>>) {
  const claims = claimsWith(counts);
  return getRarityProgress(claims, catalogueFor(claims));
}

describe("rarity progression", () => {
  it("opens each tier after 0, 2, 5 and 10 unique parks", () => {
    expect(RARITY_UNLOCK_PARKS).toEqual({ common: 0, uncommon: 2, rare: 5, legendary: 10 });
    expect(RANKS.map((rank) => rank.name)).toEqual(["Fledgling", "Trailblazer", "Wayfinder", "Island Legend"]);
  });

  it.each([
    { visited: 0, rank: "Fledgling", next: "Trailblazer", remaining: 2 },
    { visited: 1, rank: "Fledgling", next: "Trailblazer", remaining: 1 },
    { visited: 2, rank: "Trailblazer", next: "Wayfinder", remaining: 3 },
    { visited: 4, rank: "Trailblazer", next: "Wayfinder", remaining: 1 },
    { visited: 5, rank: "Wayfinder", next: "Island Legend", remaining: 5 },
    { visited: 9, rank: "Wayfinder", next: "Island Legend", remaining: 1 },
    { visited: 10, rank: "Island Legend", next: null, remaining: 0 },
    { visited: 14, rank: "Island Legend", next: null, remaining: 0 },
  ])("is $rank after $visited parks", ({ visited, rank, next, remaining }) => {
    const rankProgress = getCollectionRankProgress(progressFor({ common: visited }));

    expect(rankProgress).toMatchObject({ available: true, visited, rank: { name: rank } });
    if (next) expect(rankProgress.next).toMatchObject({ name: next, remaining });
    else expect(rankProgress.next).toBeNull();
  });

  it("counts parks of any rarity toward the next rank", () => {
    const progress = progressFor({ common: 1, uncommon: 2, rare: 1, legendary: 1 });

    expect(progress.visited).toBe(5);
    expect(progress.highestUnlocked).toBe("rare");
  });

  it("does not show a rank while the current owner catalogue is unavailable", () => {
    const claims = claimsWith({ common: 12 });

    expect(getCollectionRankProgress(getRarityProgress(claims))).toEqual({
      available: false,
      rank: null,
      visited: 0,
      openTiers: [],
      next: null,
    });
  });

  it("counts each park ID once even when duplicate claim rows share a snapshot ID", () => {
    const claims = {
      first: { parkSnapshot: { id: "same-park", rarity: "common" as const } },
      duplicate: { parkSnapshot: { id: "same-park", rarity: "common" as const } },
    };

    expect(getRarityProgress(claims, [{ id: "same-park", rarity: "common" }]).visited).toBe(1);
  });

  it("counts archived claims without a snapshot by their saved park ID", () => {
    const claims = { archived: { parkSnapshot: null }, removed: { parkSnapshot: { id: "removed", rarity: "epic" as const } } };
    const progress = getRarityProgress(claims, []);

    expect(progress.visited).toBe(2);
    expect(progress.highestUnlocked).toBe("uncommon");
  });

  it.each([
    { name: "Uncommon stays locked at 1 park", visited: 1, rarity: "uncommon", reason: "locked", remaining: 1 },
    { name: "Uncommon opens at 2 parks", visited: 2, rarity: "uncommon", reason: "unlocked", remaining: 0 },
    { name: "Rare stays locked at 4 parks", visited: 4, rarity: "rare", reason: "locked", remaining: 1 },
    { name: "Rare opens at 5 parks", visited: 5, rarity: "rare", reason: "unlocked", remaining: 0 },
    { name: "Legendary stays locked at 9 parks", visited: 9, rarity: "legendary", reason: "locked", remaining: 1 },
    { name: "Legendary opens at 10 parks", visited: 10, rarity: "legendary", reason: "unlocked", remaining: 0 },
  ] as const)("$name", ({ visited, rarity, reason, remaining }) => {
    expect(getParkRarityEligibility({ id: "next-tier-park", rarity }, progressFor({ common: visited }))).toMatchObject({
      eligible: reason === "unlocked",
      reason,
      visited,
      remaining,
    });
  });

  it("keeps Common open from the first visit", () => {
    expect(getParkRarityEligibility({ id: "first", rarity: "common" }, progressFor({}))).toMatchObject({ eligible: true, reason: "unlocked", required: 0 });
  });

  it("fails closed for new claims until a catalogue is available, but keeps earned parks accessible", () => {
    const claims = claimsWith({ common: 4 });
    const unavailable = getRarityProgress(claims);

    expect(unavailable.available).toBe(false);
    expect(getParkRarityEligibility({ id: "new-common", rarity: "common" }, unavailable)).toMatchObject({ eligible: false, reason: "unavailable" });
    expect(getParkRarityEligibility({ id: "common-0", rarity: "epic" }, unavailable, true))
      .toMatchObject({ eligible: true, reason: "already-earned" });
  });

  it("keeps earned parks accessible after reclassification and rejects new epic claims", () => {
    const claims: Record<string, RarityClaim> = {
      earned: { parkSnapshot: { id: "earned", rarity: "common" } },
      ...claimsWith({ common: 2 }),
    };
    const progress = getRarityProgress(claims, catalogueFor(claims, { earned: "legendary" }));

    expect(getParkRarityEligibility({ id: "earned", rarity: "legendary" }, progress, true))
      .toMatchObject({ eligible: true, reason: "already-earned", required: 10, remaining: 7 });
    expect(getParkRarityEligibility({ id: "new-epic", rarity: "epic" }, progress))
      .toMatchObject({ eligible: false, reason: "unsupported-rarity" });
  });

  it("blocks creation when backup hydrates the same park after claiming began", () => {
    const park = { id: "hydrated-during-check-in", rarity: "common" as const };
    const before = claimsWith({ common: 2 });
    const catalogue = [...catalogueFor(before), park];
    expect(getParkRarityEligibility(park, getRarityProgress(before, catalogue))).toMatchObject({ eligible: true, reason: "unlocked" });

    const after = { ...before, [park.id]: { parkSnapshot: park } };
    expect(getParkRarityEligibility(park, getRarityProgress(after, catalogue), true)).toMatchObject({ eligible: true, reason: "already-earned" });
    expect(() => assertParkClaimEligible(park, after, catalogue)).toThrowError(ParkAlreadyClaimedError);
  });

  it("asserts the final claim guard with the parks still needed", () => {
    const claims = claimsWith({ common: 1 });
    const catalogue = catalogueFor(claims);
    expect(() => assertParkClaimEligible({ id: "locked", rarity: "uncommon" }, claims, catalogue))
      .toThrowError(ParkClaimEligibilityError);
    try {
      assertParkClaimEligible({ id: "locked", rarity: "uncommon" }, claims, catalogue);
    } catch (error) {
      expect((error as ParkClaimEligibilityError).eligibility).toMatchObject({ reason: "locked", remaining: 1 });
    }
    expect(() => assertParkClaimEligible({ id: "new-common", rarity: "common" }, claims))
      .toThrowError(expect.objectContaining({ eligibility: expect.objectContaining({ reason: "unavailable" }) }));
  });
});

describe("rankUpAfter", () => {
  const catalogue: RarityCatalogue = [];

  it("reports the new rank when a claim crosses a threshold", () => {
    const before = getRarityProgress(claimsWith({ common: 1 }), catalogue);
    const after = getRarityProgress(claimsWith({ common: 2 }), catalogue);

    expect(rankUpAfter(before, after)).toMatchObject({ name: "Trailblazer", rarity: "uncommon" });
  });

  it("stays quiet for claims between thresholds", () => {
    const before = getRarityProgress(claimsWith({ common: 2 }), catalogue);
    const after = getRarityProgress(claimsWith({ common: 3 }), catalogue);

    expect(rankUpAfter(before, after)).toBeNull();
  });

  it("stays quiet while progress is still loading", () => {
    expect(rankUpAfter(getRarityProgress(claimsWith({ common: 1 })), getRarityProgress(claimsWith({ common: 2 }), catalogue))).toBeNull();
  });
});
