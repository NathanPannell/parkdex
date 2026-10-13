import { describe, expect, it } from "vitest";
import type { ParkFlag } from "./client";
import { flagPinSvg, flagSpec } from "./flag";
import { buildPins, EMPTY_PIN, pinIconId } from "./mapPins";

const DAY = 86_400_000;
const now = Date.parse("2026-10-07T12:00:00Z");
const flag = (parkId: string, flagSeed: string, daysAgo: number): ParkFlag => ({
  parkId, handle: flagSeed, flagSeed, since: new Date(now - daysAgo * DAY).toISOString(),
});

describe("map pins", () => {
  const parks = [
    { id: "a", lng: -123.3, lat: 48.4 },
    { id: "b", lng: -123.4, lat: 48.5 },
    { id: "c", lng: -123.5, lat: 48.6 },
    { id: "d", lng: -123.6, lat: 48.7 },
  ];

  it("pins every park, with empty poles where nobody holds one", () => {
    const flags = new Map([["a", flag("a", "robin", 2)], ["c", flag("c", "sam", 25)]]);
    const { collection, images } = buildPins(parks, flags, now);
    expect(collection.features.map((feature) => [feature.properties.id, feature.properties.icon, feature.properties.held])).toEqual([
      ["a", pinIconId("robin", 0, "2d"), 1],
      ["b", EMPTY_PIN, 0],
      ["c", pinIconId("sam", 2, "25d"), 1],
      ["d", EMPTY_PIN, 0],
    ]);
    expect(collection.features[0].geometry.coordinates).toEqual([-123.3, 48.4]);
    expect(collection.features[0].properties.dot).toBe(flagSpec("robin").field);
    expect([...images.keys()].sort()).toEqual([EMPTY_PIN, pinIconId("robin", 0, "2d"), pinIconId("sam", 2, "25d")].sort());
  });

  it("tags a young flag with minutes or hours", () => {
    const flags = new Map([["a", flag("a", "robin", 35 / 1440)], ["b", flag("b", "sam", 3.5 / 24)]]);
    const { collection } = buildPins(parks, flags, now);
    expect(collection.features.slice(0, 2).map((feature) => feature.properties.icon)).toEqual([pinIconId("robin", 0, "35m"), pinIconId("sam", 0, "3h")]);
  });

  it("shares one image between parks with the same flag and age", () => {
    const flags = new Map([["a", flag("a", "robin", 3)], ["b", flag("b", "robin", 3)]]);
    const { images } = buildPins(parks, flags, now);
    expect(images.size).toBe(2);
  });

  it("shows every park as empty when flags are unknown", () => {
    const { collection, images } = buildPins(parks, null, now);
    expect(collection.features.every((feature) => feature.properties.icon === EMPTY_PIN)).toBe(true);
    expect(images.size).toBe(1);
  });

  it("draws an empty pole without a flag and escapes the age label", () => {
    expect(flagPinSvg(null)).toContain("stroke-dasharray");
    expect(flagPinSvg("robin", { label: "<b>" })).toContain("&#60;b&#62;");
    expect(flagPinSvg("robin", { label: "12d" })).toContain(">12d</text>");
  });
});
