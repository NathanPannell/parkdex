import { describe, expect, it } from "vitest";
import { badgeTotal, isLive, mapParks, SHOW_BADGE_ART } from "./parks";

describe("badgeTotal", () => {
  it("keeps earned retired badges in the collection total", () => {
    const liveParks = [{ id: "current-a" }, { id: "current-b" }];
    expect(badgeTotal(liveParks, ["current-a", "retired-earned"])).toBe(3);
  });

  it("does not count an earned current badge twice", () => {
    const liveParks = [{ id: "current-a" }, { id: "current-b" }];
    expect(badgeTotal(liveParks, ["current-a", "current-b"])).toBe(2);
  });
});

describe("mapParks", () => {
  const parks = [
    { id: "with-art", scene: "forest-a" },
    { id: "no-art", scene: null },
    { id: "no-art-earned", scene: null },
  ];

  it("pins every park, with or without badge art, now that per-park art is retired", () => {
    expect(SHOW_BADGE_ART).toBe(false);
    expect(mapParks(parks, {}).map((park) => park.id)).toEqual(["with-art", "no-art", "no-art-earned"]);
    expect(parks.every((park) => isLive(park))).toBe(true);
  });
});
