import { describe, expect, it } from "vitest";
import type { GameMe, ParkFlag } from "./client";
import { latestTakeoverAt, nextVisitStep, parkHolder, sortHeldParks, visitHeadline, visitLabel, visitShortLabel } from "./visit";

const flag = (parkId: string, handle: string): ParkFlag => ({ parkId, handle, flagSeed: `${handle}-seed`, since: "2026-10-01T00:00:00Z" });
const flags = new Map([["blueberry", flag("blueberry", "sam")], ["beacon", flag("beacon", "robin")]]);
const me = (player: GameMe["player"]): GameMe => ({ player, score: 0, parks: [], takeovers: [] });

describe("park holder", () => {
  it("tells empty, mine and someone else's parks apart", () => {
    expect(parkHolder("blueberry", flags, "robin")).toMatchObject({ kind: "other", flag: { handle: "sam" } });
    expect(parkHolder("beacon", flags, "robin")).toMatchObject({ kind: "mine" });
    expect(parkHolder("thetis", flags, "robin")).toEqual({ kind: "empty" });
    expect(parkHolder("beacon", flags, null)).toMatchObject({ kind: "other" });
    expect(parkHolder("beacon", null, "robin")).toEqual({ kind: "unknown" });
  });

  it("labels the visit button for each case", () => {
    expect(visitLabel(false, { kind: "empty" })).toBe("Sign in to plant your flag");
    expect(visitLabel(true, { kind: "empty" })).toBe("Plant your flag");
    expect(visitLabel(true, { kind: "unknown" })).toBe("Plant your flag");
    expect(visitLabel(true, parkHolder("blueberry", flags, "robin"))).toBe("Take it from @sam");
    expect(visitLabel(true, parkHolder("beacon", flags, "robin"))).toBe("Visit your flag");
    expect(visitShortLabel(parkHolder("blueberry", flags, "robin"))).toBe("Take!");
    expect(visitShortLabel({ kind: "empty" })).toBe("Plant!");
  });
});

describe("visit steps", () => {
  it("sends guests to sign in and new players to pick a handle", () => {
    expect(nextVisitStep(false, null)).toBe("sign-in");
    expect(nextVisitStep(true, me(null))).toBe("pick-handle");
    expect(nextVisitStep(true, me({ handle: "robin", flagSeed: "s" }))).toBe("plant");
    // Player state not loaded yet: the server answers handle_required if needed.
    expect(nextVisitStep(true, null)).toBe("plant");
  });
});

describe("visit results", () => {
  const base = { visitId: "v", parkId: "blueberry", pointsEarned: 0, previousHolder: null, flagSince: null };

  it("names what happened", () => {
    expect(visitHeadline({ ...base, outcome: "planted" }, "Blueberry").title).toBe("Flag planted");
    const took = visitHeadline({ ...base, outcome: "took", pointsEarned: 12, previousHolder: { handle: "b", flagSeed: "x" } }, "Blueberry");
    expect(took.title).toBe("You took Blueberry from @b");
    expect(took.detail).toMatch(/each whole day/);
    expect(visitHeadline({ ...base, outcome: "took", pointsEarned: 1, previousHolder: null }, "Blueberry").title).toBe("You took Blueberry");
    expect(visitHeadline({ ...base, outcome: "held" }, "Blueberry").title).toBe("Your flag is still flying");
    expect(visitHeadline({ ...base, outcome: "already_today" }, "Blueberry").title).toBe("Already visited today");
  });
});

describe("lists", () => {
  it("finds the newest takeover", () => {
    expect(latestTakeoverAt([])).toBeNull();
    expect(latestTakeoverAt([{ at: "2026-10-05T00:00:00Z" }, { at: "2026-10-06T00:00:00Z" }, { at: "bad" }])).toBe("2026-10-06T00:00:00Z");
  });

  it("sorts held parks by age", () => {
    const parks = [
      { parkId: "a", days: 2, since: "2026-10-05T00:00:00Z" },
      { parkId: "b", days: 9, since: "2026-09-28T00:00:00Z" },
      { parkId: "c", days: 2, since: "2026-10-04T12:00:00Z" },
    ];
    expect(sortHeldParks(parks).map((park) => park.parkId)).toEqual(["b", "c", "a"]);
  });
});
