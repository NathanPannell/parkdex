import { describe, expect, it } from "vitest";
import type { GameMe, ParkFlag, VisitOutcome } from "./client";
import {
  formatPoints,
  formatScore,
  hasVisitedToday,
  latestTakeoverAt,
  nextVisitStep,
  parkHolder,
  plantCheer,
  sortHeldParks,
  takeLabel,
  takePoints,
  visitHeadline,
  visitLabel,
  visitShortLabel,
} from "./visit";

const flag = (parkId: string, handle: string): ParkFlag => ({ parkId, handle, flagSeed: `${handle}-seed`, since: "2026-10-01T00:00:00Z" });
const flags = new Map([
  ["blueberry", flag("blueberry", "sam")],
  ["beacon", flag("beacon", "robin")],
]);
const me = (player: GameMe["player"]): GameMe => ({ player, score: 0, parks: [], takeovers: [], flagSeed: player?.flagSeed ?? null });

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

describe("visited today", () => {
  // The server's end of December 1, 2026 in Victoria, which stays on UTC-7 from November 2026.
  const visited: GameMe = { ...me({ handle: "robin", flagSeed: "r" }), visitedToday: ["blueberry"], visitedTodayUntil: "2026-12-02T07:00:00.000Z" };

  it("knows a park visited earlier today, until the day the server named ends", () => {
    expect(hasVisitedToday(visited, "blueberry", Date.parse("2026-12-02T06:59:59Z"))).toBe(true);
    expect(hasVisitedToday(visited, "beacon", Date.parse("2026-12-02T06:00:00Z"))).toBe(false);
    expect(hasVisitedToday(visited, "blueberry", Date.parse("2026-12-02T07:00:00Z"))).toBe(false);
    expect(hasVisitedToday(me(null), "blueberry", Date.parse("2026-12-01T20:00:00Z"))).toBe(false);
    expect(hasVisitedToday(null, "blueberry", Date.parse("2026-12-01T20:00:00Z"))).toBe(false);
  });

  it("does not trust a list without an end", () => {
    expect(hasVisitedToday({ ...visited, visitedTodayUntil: null }, "blueberry", Date.parse("2026-12-01T20:00:00Z"))).toBe(false);
    expect(hasVisitedToday({ ...visited, visitedTodayUntil: undefined }, "blueberry", Date.parse("2026-12-01T20:00:00Z"))).toBe(false);
  });

  it("offers no take or plant once today's visit counted", () => {
    const other = parkHolder("blueberry", flags, "robin");
    expect(visitLabel(true, other, true)).toBe("Visited today, back tomorrow");
    expect(visitLabel(true, { kind: "empty" }, true)).toBe("Visited today, back tomorrow");
    expect(visitShortLabel(other, true)).toBe("Tomorrow");
    expect(visitLabel(false, other, true)).toBe("Sign in to plant your flag");
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
  const base = {
    visitId: "v",
    parkId: "blueberry",
    pointsEarned: 0,
    pointsBreakdown: { base: 0, days: 0 },
    previousHolder: null,
    flagSince: null,
    protected: null,
  };

  it("names what happened", () => {
    const planted = visitHeadline({ ...base, outcome: "planted" }, "Blueberry");
    expect(planted.title).toBe("Flag planted");
    expect(planted.detail).toBe("Your flag is flying over Blueberry. One point for every hour your flag flies.");
    const took = visitHeadline({ ...base, outcome: "took", pointsEarned: 12, previousHolder: { handle: "b", flagSeed: "x" } }, "Blueberry");
    expect(took.title).toBe("You took Blueberry from @b");
    expect(took.detail).toBe("One point for every hour your flag flies.");
    expect(visitHeadline({ ...base, outcome: "took", pointsEarned: 1, previousHolder: null }, "Blueberry").title).toBe("You took Blueberry");
    expect(visitHeadline({ ...base, outcome: "held" }, "Blueberry").title).toBe("Your flag is still flying");
    expect(visitHeadline({ ...base, outcome: "already_today" }, "Blueberry").title).toBe("Already visited today");
  });

  it("explains a logged visit during someone else's protected hour, whatever the crews flag says", () => {
    // 3:42 pm on this device's clock, so the test reads the same in every time zone.
    const until = new Date(2026, 9, 13, 15, 42).toISOString();
    const logged = visitHeadline(
      {
        ...base,
        outcome: "logged",
        pointsEarned: 1,
        pointsBreakdown: { base: 1, days: 0 },
        protected: { until, leader: { handle: "tom", flagSeed: "t" }, crewSize: 2 },
      },
      "Blueberry",
    );
    expect(logged).toEqual({ title: "Visit logged", detail: "This flag was just planted. Come back after 3:42 pm to take it." });
    expect(visitHeadline({ ...base, outcome: "logged", pointsEarned: 1 }, "Blueberry").detail).toBe("Your visit counts. The flag stays where it is.");
    expect(visitHeadline({ ...base, outcome: "joined", pointsEarned: 2 }, "Blueberry")).toEqual({
      title: "You joined the crew",
      detail: "You hold Blueberry together now. One point for every hour your flag flies.",
    });
  });
});

describe("crews", () => {
  const until = new Date(2026, 9, 13, 15, 42).toISOString();

  it("treats a park held as a crew member as the player's own", () => {
    const held = [{ parkId: "blueberry" }];
    expect(parkHolder("blueberry", flags, "robin", held)).toMatchObject({ kind: "mine", member: true, flag: { handle: "sam" } });
    expect(parkHolder("beacon", flags, "robin", held)).toEqual({ kind: "mine", flag: flags.get("beacon") });
    expect(parkHolder("blueberry", flags, null, held)).toMatchObject({ kind: "other" });
    expect(visitLabel(true, parkHolder("blueberry", flags, "robin", held))).toBe("Visit your crew's flag");
  });

  it("labels outsiders during the protected hour, and a scanned code", () => {
    const outsider = { kind: "outsider" as const, until, leader: "sam", logged: false };
    const other = parkHolder("blueberry", flags, "robin");
    expect(visitLabel(true, other, false, outsider)).toBe("Log your visit · +1");
    expect(visitLabel(true, other, false, { ...outsider, logged: true })).toBe("Logged, take it after 3:42 pm");
    expect(visitShortLabel(other, false, outsider)).toBe("Log");
    expect(visitShortLabel(other, false, { ...outsider, logged: true })).toBe("Later");
    expect(visitShortLabel(other, false, outsider, true)).toBe("Join");
    expect(visitShortLabel(other, true, { kind: "none" }, true)).toBe("Join");
    // With the crews flag off the phase is always none, and labels stay as they were.
    expect(visitLabel(true, other, false, { kind: "none" })).toBe("Take it from @sam");
    expect(visitShortLabel(other, false, { kind: "none" })).toBe("Take!");
  });
});

describe("points", () => {
  it("formats four and five digit scores", () => {
    expect(formatScore(0)).toBe("0");
    expect(formatScore(1234)).toBe("1,234");
    expect(formatScore(54321)).toBe("54,321");
    expect(formatPoints(1)).toBe("1 point");
    expect(formatPoints(12345)).toBe("12,345 points");
  });

  it("prices a take at 4 plus the days the flag has flown", () => {
    expect(takePoints(0)).toBe(4);
    expect(takePoints(1)).toBe(5);
    expect(takePoints(10)).toBe(14);
    expect(takePoints(-2)).toBe(4);
    expect(takeLabel(0)).toBe("Take it for +4 points");
    expect(takeLabel(10)).toBe("Take it for +14 points");
  });

  it("breaks the points of a visit down", () => {
    const visit = (outcome: VisitOutcome, base: number, days = 0) => ({ outcome, pointsBreakdown: { base, days } });
    expect(plantCheer(visit("took", 4, 3))).toBe("KLEEP! +4 for the take, +3 for those 3 days!");
    expect(plantCheer(visit("took", 4, 1))).toBe("KLEEP! +4 for the take, +1 for that day!");
    expect(plantCheer(visit("took", 4))).toBe("KLEEP! +4 for the take!");
    expect(plantCheer(visit("planted", 6))).toBe("KLEEP! Flag's up! +6");
    expect(plantCheer(visit("held", 1))).toBe("Still flying! +1");
    expect(plantCheer(visit("already_today", 0))).toBe("See you tomorrow!");
    expect(plantCheer(visit("joined", 2))).toBe("KLEEP! You're in the crew! +2");
    expect(plantCheer(visit("logged", 1))).toBe("Visit logged! +1");
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
