import { describe, expect, it } from "vitest";
import type { Park } from "./parks";
import { resolveEarnedParkDisplay } from "./earnedParkDisplay";

function park(overrides: Partial<Park> = {}): Park {
  return {
    id: "thetis",
    name: "Thetis Park",
    short: "Thetis",
    category: "provincial",
    region: "Nanaimo",
    lat: 49,
    lng: -123,
    biome: "coast",
    shape: "arch",
    rarity: "common",
    seed: 7,
    blurb: "",
    scene: null,
    ...overrides,
  };
}

function claim(snapshot: Park | null, contentReleaseId: string | null = "release-before") {
  return {
    claimId: "claim-1",
    at: "2026-09-28T12:00:00.000Z",
    photo: "data:image/jpeg;base64,photo",
    parkSnapshot: snapshot,
    contentReleaseId,
  };
}

describe("resolveEarnedParkDisplay", () => {
  it("adopts locally available current art for a formerly scene-null claim without changing its snapshot", () => {
    const snapshot = park({ scene: null, rarity: "common" });
    const storedClaim = claim(snapshot, null);
    const before = JSON.stringify(storedClaim);
    const current = park({ name: "Thetis Park Reserve", short: "Thetis Reserve", rarity: "rare", scene: "thetis-revised" });

    const result = resolveEarnedParkDisplay(snapshot, storedClaim, current, true);

    expect(result).toEqual({ park: current, usesCurrentArt: true });
    expect(JSON.stringify(storedClaim)).toBe(before);
    expect(storedClaim.photo).toBe("data:image/jpeg;base64,photo");
    expect(storedClaim.contentReleaseId).toBeNull();
  });

  it("prefers locally available current art for a scene-bearing claim after an artwork revision", () => {
    const snapshot = park({ rarity: "uncommon", scene: "thetis-original" });
    const storedClaim = claim(snapshot);
    const current = park({ rarity: "legendary", scene: "thetis-revised" });

    const result = resolveEarnedParkDisplay(snapshot, storedClaim, current, true);

    expect(result.usesCurrentArt).toBe(true);
    expect(result.park.scene).toBe("thetis-revised");
    expect(result.park.rarity).toBe("legendary");
    expect(snapshot.scene).toBe("thetis-original");
    expect(snapshot.rarity).toBe("uncommon");
  });

  it("keeps archived art or the original placeholder until current art has a local URL", () => {
    const snapshot = park({ rarity: "common", scene: "thetis-original" });
    const storedClaim = claim(snapshot);
    const current = park({ name: "Thetis Updated", short: "Thetis 2", rarity: "rare", scene: "thetis-revised" });

    const result = resolveEarnedParkDisplay(snapshot, storedClaim, current, false);

    expect(result.usesCurrentArt).toBe(false);
    expect(result.park.scene).toBe("thetis-original");
    expect(result.park.rarity).toBe("rare");
    expect(result.park.short).toBe("Thetis 2");
    expect(snapshot.scene).toBe("thetis-original");
  });

  it("leaves a scene-null claim as a placeholder while newly published art is unavailable", () => {
    const snapshot = park({ scene: null });
    const current = park({ rarity: "rare", scene: "thetis-revised" });

    const result = resolveEarnedParkDisplay(snapshot, claim(snapshot, null), current, false);

    expect(result.usesCurrentArt).toBe(false);
    expect(result.park.scene).toBeNull();
    expect(result.park.rarity).toBe("rare");
  });

  it("falls back to the frozen snapshot for a removed park", () => {
    const snapshot = park({ name: "Thetis Park Historic", rarity: "uncommon", scene: "thetis-archived" });
    const result = resolveEarnedParkDisplay(snapshot, claim(snapshot), undefined, false);

    expect(result.park).toBe(snapshot);
    expect(result.usesCurrentArt).toBe(false);
  });
});
