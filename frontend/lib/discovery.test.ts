import { describe, expect, it } from "vitest";
import { distanceKm, formatDistance, modeForSelection, nearestUnseenParks } from "./discovery";
import type { Place } from "./places";

const place = (id: string, latitude: number, longitude: number, category: Place["category"] = "regional"): Place => ({
  id, name: id, latitude, longitude, category, region: "Test", description: "", sourceName: "Test", sourceUrl: "https://example.com",
});

describe("discovery", () => {
  it("calculates straight-line distance and sorts unseen parks", () => {
    expect(distanceKm({ latitude: 48.4284, longitude: -123.3656 }, { latitude: 49.2827, longitude: -123.1207 })).toBeCloseTo(96.9, 0);
    const results = nearestUnseenParks([place("far", 49, -124), place("near", 48.5, -123.4), place("island", 48.4, -123.3, "island")], new Set(["far"]), { latitude: 48.45, longitude: -123.4 });
    expect(results.map(({ place: item }) => item.id)).toEqual(["near"]);
  });

  it("formats useful kilometre precision", () => {
    expect(formatDistance(4.26)).toBe("4.3 km");
    expect(formatDistance(14.6)).toBe("15 km");
  });

  it("reveals an unseen selection on the discovery map", () => {
    expect(modeForSelection("explored", new Set(), "unseen")).toBe("discover");
    expect(modeForSelection("explored", new Set(["visited"]), "visited")).toBe("explored");
  });
});
