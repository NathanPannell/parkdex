import { describe, expect, it } from "vitest";
import { achievements, JUAN_DE_FUCA_PARK_ID, newlyEarnedAchievementIds } from "./achievements";
import type { Place } from "./places";

const park = (id: string, category: Place["category"]): Place => ({ id, name: id, category, latitude: 0, longitude: 0, region: "Gulf Islands", description: "", sourceName: "x", sourceUrl: "https://example.com" });

describe("achievements", () => {
  const places = [park("national-gulf-islands-national-park-reserve", "national"), park("national-pacific-rim-national-park-reserve", "national"), park("p", "provincial"), park("r", "regional"), park("i", "island")];

  it("ships at least twenty native species achievements", () => {
    expect(achievements({ places, visited: new Set() }).length).toBeGreaterThanOrEqual(20);
  });

  it("earns Banana Slug Medal solely for visiting Juan de Fuca Park", () => {
    const withoutPark = achievements({ places, visited: new Set() }).find((badge) => badge.name === "Banana Slug Medal");
    const withPark = achievements({ places, visited: new Set([JUAN_DE_FUCA_PARK_ID]), visitTimestamps: { [JUAN_DE_FUCA_PARK_ID]: "2026-09-08T10:00:00Z" } }).find((badge) => badge.name === "Banana Slug Medal");
    expect(withoutPark?.earned).toBe(false);
    expect(withPark).toMatchObject({ earned: true, earnedAt: "2026-09-08T10:00:00Z" });
  });

  it("recognizes both national parks and all four place categories", () => {
    const badges = achievements({ places, visited: new Set(places.map((item) => item.id)) });
    expect(badges.find((badge) => badge.id === "black-bear-pair")?.earned).toBe(true);
    expect(badges.find((badge) => badge.id === "orca-four-realms")?.earned).toBe(true);
  });

  it("reports only achievements newly earned after the prior state", () => {
    const before = achievements({ places, visited: new Set() });
    const after = achievements({ places, visited: new Set(["p"]) });
    expect(newlyEarnedAchievementIds(before, after)).toEqual(["river-otter-rookie"]);
  });
});
