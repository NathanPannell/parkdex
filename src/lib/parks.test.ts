import { describe, expect, it } from "vitest";
import { badgeTotal } from "./parks";

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
