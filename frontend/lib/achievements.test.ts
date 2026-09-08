import { describe, expect, it } from "vitest";
import { achievements } from "./achievements";
import type { Place } from "./places";

const park = (id: string, category: Place["category"]): Place => ({ id, name: id, category, latitude: 0, longitude: 0, region: "Gulf Islands", description: "", sourceName: "x", sourceUrl: "https://example.com" });

describe("achievements", () => {
  const places = [park("national-gulf-islands-national-park-reserve", "national"), park("national-pacific-rim-national-park-reserve", "national"), park("p", "provincial"), park("r", "regional"), park("i", "island")];

  it("ships at least twenty native species achievements", () => {
    expect(achievements({ places, visited: new Set(), completedTrails: new Set() }).length).toBeGreaterThanOrEqual(20);
  });

  it("earns Banana Slug Medal only for both explicit trails", () => {
    const one = achievements({ places, visited: new Set(), completedTrails: new Set(["west_coast_trail"]) }).find((badge) => badge.name === "Banana Slug Medal");
    const both = achievements({ places, visited: new Set(), completedTrails: new Set(["west_coast_trail", "juan_de_fuca_trail"]) }).find((badge) => badge.name === "Banana Slug Medal");
    expect(one?.earned).toBe(false);
    expect(both?.earned).toBe(true);
  });

  it("recognizes both national parks and all four place categories", () => {
    const badges = achievements({ places, visited: new Set(places.map((item) => item.id)), completedTrails: new Set() });
    expect(badges.find((badge) => badge.id === "black-bear-pair")?.earned).toBe(true);
    expect(badges.find((badge) => badge.id === "orca-four-realms")?.earned).toBe(true);
  });
});
