import { describe, expect, it } from "vitest";
import { flagSpec } from "./flag";
import { countStepMs, dirtClods, flagConfetti, plantPlan, standingRival, startsPlanted } from "./plantScene";

const flag = { parkId: "p", handle: "sam", flagSeed: "s", since: "2026-10-01T00:00:00Z" };

describe("plant scene", () => {
  it("yanks the rival out before a take and counts the points", () => {
    expect(plantPlan({ outcome: "took", pointsEarned: 12 })).toEqual({ yank: true, slam: "big", settle: false, raise: false, payoff: "big", count: 12 });
    expect(plantPlan({ outcome: "planted", pointsEarned: 6 })).toEqual({ yank: false, slam: "big", settle: false, raise: false, payoff: "big", count: 6 });
    // A visit replayed from before #169 may have earned nothing.
    expect(plantPlan({ outcome: "planted", pointsEarned: 0 })).toMatchObject({ count: null });
  });

  it("gives revisits a smaller version and leaves a second visit today unplanted", () => {
    expect(plantPlan({ outcome: "held", pointsEarned: 1 })).toMatchObject({ slam: "small", payoff: "small", count: 1 });
    expect(plantPlan({ outcome: "already_today", pointsEarned: 0 })).toEqual({
      yank: false,
      slam: null,
      settle: true,
      raise: false,
      payoff: "tiny",
      count: null,
    });
  });

  it("raises a pennant for a crew join and settles back for a logged visit", () => {
    expect(plantPlan({ outcome: "joined", pointsEarned: 2 })).toEqual({ yank: false, slam: null, settle: false, raise: true, payoff: "big", count: 2 });
    // A logged visit leaves the protected flag standing and counts its point.
    expect(plantPlan({ outcome: "logged", pointsEarned: 1 })).toEqual({ yank: false, slam: null, settle: true, raise: false, payoff: "tiny", count: 1 });
  });

  it("starts from the mound only for the player's own park", () => {
    expect(startsPlanted({ kind: "mine", flag })).toBe(true);
    expect(startsPlanted({ kind: "other", flag })).toBe(false);
    expect(startsPlanted({ kind: "empty" })).toBe(false);
    expect(standingRival({ kind: "other", flag })).toBe(flag);
    expect(standingRival({ kind: "mine", flag })).toBeNull();
  });

  it("throws confetti in the player's own flag colours", () => {
    const spec = flagSpec("player-1");
    const colours = flagConfetti("player-1");
    expect(colours).toContain(spec.field);
    expect(colours).toContain(spec.accent);
    expect(colours).toContain("#FFC93C");
    expect(new Set(colours).size).toBe(colours.length);
    expect(flagConfetti(null).length).toBeGreaterThan(0);
  });

  it("counts small bounties slowly and big ones fast", () => {
    expect(countStepMs(0)).toBe(0);
    expect(countStepMs(3)).toBe(140);
    expect(countStepMs(20)).toBe(55);
    expect(countStepMs(400)).toBe(28);
  });

  it("throws dirt up and out on both sides, landing and hopping, the same way for the same seed", () => {
    const clods = dirtClods(28, 3);
    expect(clods).toHaveLength(28);
    expect(dirtClods(28, 3)).toEqual(clods);
    expect(dirtClods(28, 4)).not.toEqual(clods);
    expect(clods.some((clod) => clod.x < 0)).toBe(true);
    expect(clods.some((clod) => clod.x > 0)).toBe(true);
    expect(clods.every((clod) => clod.peak < 0 && clod.land > 0 && clod.hop < clod.land)).toBe(true);
    const small = dirtClods(28, 3, 0.4);
    expect(Math.max(...small.map((clod) => Math.abs(clod.x)))).toBeLessThan(Math.max(...clods.map((clod) => Math.abs(clod.x))));
  });
});
