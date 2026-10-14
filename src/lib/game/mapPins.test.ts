import { describe, expect, it } from "vitest";
import type { ParkFlag } from "./client";
import { flagPinSvg, flagSpec } from "./flag";
import { buildPins, EMPTY_PIN, FLAG_PIN_ZOOM, patchedPinIconId, patchMinZoom, pinIconId, pinScale, PIN_SCALE_STOPS } from "./mapPins";
import { MIN_PATCH_CLOTH_PX, PIN_CLOTH_RECT, placePatches } from "./patches";

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

  const patchedFlags = () => new Map([
    ["a", { ...flag("a", "robin", 2), patches: ["nope", "hold-7", "parks-1"] }],
    ["b", { ...flag("b", "sam", 2), patches: ["hold-7"] }],
    ["c", flag("c", "kim", 2)],
  ]);

  it("gives a holder's pin a second image with their patches, named by what it draws (#175)", () => {
    const flags = patchedFlags();
    const { collection, images } = buildPins(parks, flags, now, { badges: true });
    const [a, b, c, d] = collection.features.map((feature) => feature.properties);
    expect(a.patched).toBe(patchedPinIconId(a.icon, ["hold-7", "parks-1"]));
    expect(a.patched).toBe(`${a.icon}:patches:hold-7,parks-1`);
    expect(images.get(a.patched)).toMatchObject({ seed: "robin", patches: ["hold-7", "parks-1"] });
    expect(images.get(a.icon)?.patches).toBeUndefined();
    expect(b.patched).toBe(`${b.icon}:patches:hold-7`);
    // Without patches, or without a flag, both images are the same plain pin.
    expect(c.patched).toBe(c.icon);
    expect(d).toMatchObject({ icon: EMPTY_PIN, patched: EMPTY_PIN });
  });

  it("draws no patches and keeps them out of every image key with the badges flag off", () => {
    const flags = patchedFlags();
    for (const options of [{}, { badges: false }, { badges: false, crews: true }]) {
      const { collection, images } = buildPins(parks, flags, now, options);
      for (const pin of collection.features.map((feature) => feature.properties)) {
        expect(pin.patched).toBe(pin.icon);
        expect(pin.patched).not.toContain("patches");
      }
      for (const [key, image] of images) {
        expect(key).not.toContain("patches");
        expect(image.patches ?? []).toEqual([]);
      }
    }
  });

  it("shows patches only where a pin's cloth is drawn big enough, like every other flag", () => {
    const selected = patchMinZoom(true);
    const plain = patchMinZoom(false);
    // The selected pin shows its patches wherever the map shows flags (MapView relies on this);
    // other pins from zoom 14.4, where they are drawn as big.
    expect(selected).toBe(FLAG_PIN_ZOOM);
    expect(plain).toBe(14.4);
    expect(PIN_CLOTH_RECT.width * pinScale(plain, false)).toBeGreaterThanOrEqual(MIN_PATCH_CLOTH_PX);
    expect(PIN_CLOTH_RECT.width * pinScale(plain - 0.1, false)).toBeLessThan(MIN_PATCH_CLOTH_PX);
    expect(PIN_CLOTH_RECT.width * pinScale(FLAG_PIN_ZOOM, true)).toBeGreaterThanOrEqual(MIN_PATCH_CLOTH_PX);
    expect(pinScale(PIN_SCALE_STOPS[0][0] - 2, false)).toBe(PIN_SCALE_STOPS[0][1]);
    expect(pinScale(20, true)).toBe(PIN_SCALE_STOPS[PIN_SCALE_STOPS.length - 1][2]);
  });

  it("keeps patches on the pin's cloth, clear of the crew shield, pennants and age tag", () => {
    const shield = { left: 38, right: 47, top: 1.2, bottom: 12.5 };
    for (const count of [1, 2, 3]) {
      for (const { x, y, r } of placePatches(count, PIN_CLOTH_RECT)) {
        expect(x - r).toBeGreaterThanOrEqual(PIN_CLOTH_RECT.x);
        expect(x + r).toBeLessThanOrEqual(PIN_CLOTH_RECT.x + PIN_CLOTH_RECT.width);
        expect(y - r).toBeGreaterThanOrEqual(PIN_CLOTH_RECT.y);
        // Pennants hang from y 31 and the age tag starts at 33.
        expect(y + r).toBeLessThan(31);
        expect(y - r > shield.bottom || x + r < shield.left).toBe(true);
      }
    }
  });
});
