import { afterEach, describe, expect, it } from "vitest";
import { backCanLeavePlant, canLeavePlant, leavePlant, reportPlantPhase } from "./plantExit";

describe("leaving the plant screen", () => {
  afterEach(() => reportPlantPhase(null));

  it("is allowed before the hold completes, after a failure and once the result is shown", () => {
    expect(canLeavePlant("charge")).toBe(true);
    expect(canLeavePlant("failed")).toBe(true);
    expect(canLeavePlant("done")).toBe(true);
  });

  it("waits while the visit is in flight or its result is playing", () => {
    expect(canLeavePlant("sending")).toBe(false);
    expect(canLeavePlant("playing")).toBe(false);
  });

  it("ends the trip and settles the map on the park without opening its page", () => {
    expect(leavePlant("municipal-city-of-victoria-1442")).toEqual([
      { type: "trip", id: null },
      { type: "focus", id: "municipal-city-of-victoria-1442", open: false },
      { type: "go", screen: "map" },
    ]);
  });

  it("goes straight to Your parks without focusing a park", () => {
    expect(leavePlant("municipal-city-of-victoria-1442", "parks")).toEqual([
      { type: "trip", id: null },
      { type: "go", screen: "parks" },
    ]);
  });

  it("still returns to the map when the park is unknown", () => {
    expect(leavePlant(null)).toEqual([
      { type: "trip", id: null },
      { type: "go", screen: "map" },
    ]);
  });

  it("lets Android back follow the open screen's phase", () => {
    expect(backCanLeavePlant()).toBe(true);
    reportPlantPhase("charge");
    expect(backCanLeavePlant()).toBe(true);
    reportPlantPhase("sending");
    expect(backCanLeavePlant()).toBe(false);
    reportPlantPhase("done");
    expect(backCanLeavePlant()).toBe(true);
  });
});
