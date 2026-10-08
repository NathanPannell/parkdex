import { describe, expect, it } from "vitest";
import { dirtClods, plantBeats, standingRival, startsPlanted } from "./plantScene";

const flag = { parkId: "p", handle: "sam", flagSeed: "s", since: "2026-10-01T00:00:00Z" };

describe("plant scene", () => {
  it("knocks the old flag over before a take and only counts points when something was won", () => {
    expect(plantBeats("took")).toEqual(["topple", "slam", "dirt", "unfurl", "points"]);
    expect(plantBeats("planted")).toEqual(["slam", "dirt", "unfurl", "points"]);
    expect(plantBeats("held")).toEqual(["slam", "dirt", "unfurl"]);
    expect(plantBeats("already_today")).toEqual(["settle"]);
  });

  it("starts from the mound only for the player's own park", () => {
    expect(startsPlanted({ kind: "mine", flag })).toBe(true);
    expect(startsPlanted({ kind: "other", flag })).toBe(false);
    expect(startsPlanted({ kind: "empty" })).toBe(false);
    expect(standingRival({ kind: "other", flag })).toBe(flag);
    expect(standingRival({ kind: "mine", flag })).toBeNull();
  });

  it("throws dirt up and out on both sides, the same way for the same seed", () => {
    const clods = dirtClods(14, 3);
    expect(clods).toHaveLength(14);
    expect(dirtClods(14, 3)).toEqual(clods);
    expect(dirtClods(14, 4)).not.toEqual(clods);
    expect(clods.some((clod) => clod.x < 0)).toBe(true);
    expect(clods.some((clod) => clod.x > 0)).toBe(true);
    expect(clods.every((clod) => clod.peak < 0 && clod.y > 0)).toBe(true);
  });
});
