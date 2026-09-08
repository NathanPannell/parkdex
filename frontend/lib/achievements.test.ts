import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { achievements, JUAN_DE_FUCA_PARK_ID, newlyEarnedAchievementIds } from "./achievements";
import type { Place } from "./places";

const park = (id: string, category: Place["category"]): Place => ({ id, name: id, category, latitude: 0, longitude: 0, region: "Gulf Islands", description: "", sourceName: "x", sourceUrl: "https://example.com" });

describe("achievements", () => {
  const places = [park("national-gulf-islands-national-park-reserve", "national"), park("national-pacific-rim-national-park-reserve", "national"), park("p", "provincial"), park("r", "regional"), park("i", "island")];

  it("ships at least twenty native species achievements", () => {
    expect(achievements({ places, visited: new Set() }).length).toBeGreaterThanOrEqual(20);
  });

  it("earns Banana Slug Rainwalk only after its three rain-forest parks", () => {
    const rainParks = [park(JUAN_DE_FUCA_PARK_ID, "provincial"), park("provincial-carmanah-walbran-park", "provincial"), park("provincial-macmillan-park", "provincial")];
    const badge = achievements({ places: rainParks, visited: new Set(rainParks.map((item) => item.id)), visitTimestamps: Object.fromEntries(rainParks.map((item, index) => [item.id, `2026-09-0${index + 1}T10:00:00Z`])) }).find((item) => item.id === "banana-slug-medal");
    expect(badge).toMatchObject({ earned: true, current: 3, target: 3, earnedAt: "2026-09-03T10:00:00Z" });
  });

  it("keeps every exact-place challenge satisfiable by the active catalogue", () => {
    const activePlaces = JSON.parse(readFileSync(resolve(process.cwd(), "../data/places.json"), "utf8")) as Place[];
    const badges = achievements({ places: activePlaces, visited: new Set(activePlaces.map((item) => item.id)) });
    expect(badges.every((badge) => badge.earned)).toBe(true);
  });

  it("does not let retired visit ids advance total or place-set achievements", () => {
    const badges = achievements({ places: [park("active", "regional")], visited: new Set(["active", "retired", "provincial-cape-scott-park", "provincial-strathcona-park"]) });
    expect(badges.find((badge) => badge.id === "harbour-seal-five")?.current).toBe(1);
    expect(badges.find((badge) => badge.id === "black-bear-coast")?.current).toBe(0);
  });

  it("reports only achievements newly earned after the prior state", () => {
    const before = achievements({ places, visited: new Set() });
    const after = achievements({ places, visited: new Set(["p"]) });
    expect(newlyEarnedAchievementIds(before, after)).toEqual(["river-otter-rookie"]);
  });
});
