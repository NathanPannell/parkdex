import { describe, expect, it } from "vitest";
import { directionsUrl } from "../../screens/map/ParkSheet";
import { validateParkRecord } from "./manifest";

const base = {
  id: "regional-thetis-lake", name: "Thetis Lake", short: "Thetis", category: "regional", region: "West Shore",
  lat: 48.46, lng: -123.47, biome: "lake", shape: "circle", rarity: "common", scene: null, seed: 4, blurb: "A lake.",
};

describe("park access fields", () => {
  it("keeps a Google Maps link and a complete trailhead", () => {
    const park = validateParkRecord({ ...base, googleMapsUrl: "https://maps.app.goo.gl/abc", trailheadLat: 48.47, trailheadLng: -123.46 });
    expect(park.googleMapsUrl).toBe("https://maps.app.goo.gl/abc");
    expect([park.trailheadLat, park.trailheadLng]).toEqual([48.47, -123.46]);
    expect(directionsUrl(park)).toBe("https://maps.app.goo.gl/abc");
  });

  it("falls back to the park pin without a usable link", () => {
    for (const extra of [{}, { googleMapsUrl: null }, { googleMapsUrl: "https://example.com/maps" }]) {
      const park = validateParkRecord({ ...base, ...extra });
      expect(park.googleMapsUrl).toBeUndefined();
      expect(directionsUrl(park)).toBe("https://www.google.com/maps/dir/?api=1&destination=48.46,-123.47");
    }
  });

  it("drops half a trailhead", () => {
    const park = validateParkRecord({ ...base, trailheadLat: 48.47, trailheadLng: null });
    expect(park.trailheadLat).toBeUndefined();
    expect(park.trailheadLng).toBeUndefined();
  });
});
