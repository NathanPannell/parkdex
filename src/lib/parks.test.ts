import { describe, expect, it } from "vitest";
import { badgeTotal, mapParks } from "./parks";

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

  it("hides parks that have no badge art yet", () => {
    expect(mapParks(parks, {}).map((park) => park.id)).toEqual(["with-art"]);
  });

  it("keeps a park already in the Dex even when its art is withdrawn", () => {
    expect(mapParks(parks, { "no-art-earned": {} }).map((park) => park.id)).toEqual(["with-art", "no-art-earned"]);
  });
});
