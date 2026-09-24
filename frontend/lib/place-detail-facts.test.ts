import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  calculateSphericalGeodesicAreaKm2,
  formatPlaceArea,
  shortOriginForPlace,
} from "./place-detail-facts";
import areas from "./place-areas.catalogue.json";
import type { Place } from "./places";

const places: Place[] = JSON.parse(readFileSync(new URL("../../data/places.json", import.meta.url), "utf8"));
const boundaries = JSON.parse(readFileSync(new URL("../../data/boundaries.geojson", import.meta.url), "utf8")) as {
  features: Array<{
    geometry: Parameters<typeof calculateSphericalGeodesicAreaKm2>[0];
    properties: { id: string };
  }>;
};
const placesById = new Map(places.map((place) => [place.id, place]));

describe("park detail facts", () => {
  it("calculates spherical geodesic area and subtracts holes", () => {
    const outer = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]] as const;
    const hole = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75], [0.25, 0.25]] as const;
    const outerArea = calculateSphericalGeodesicAreaKm2({ type: "Polygon", coordinates: [outer] });
    const holeArea = calculateSphericalGeodesicAreaKm2({ type: "Polygon", coordinates: [hole] });
    const withHole = calculateSphericalGeodesicAreaKm2({ type: "Polygon", coordinates: [outer, hole] });

    expect(outerArea).toBeCloseTo(12_363.7, 0);
    expect(withHole).toBeCloseTo(outerArea! - holeArea!, 6);
  });

  it("keeps the static area catalogue aligned with every canonical boundary", () => {
    expect(boundaries.features).toHaveLength(places.length);
    expect(Object.keys(areas).sort()).toEqual(boundaries.features.map((feature) => feature.properties.id).sort());

    for (const feature of boundaries.features) {
      const area = calculateSphericalGeodesicAreaKm2(feature.geometry);
      expect(area, feature.properties.id).not.toBeNull();
      expect(area, feature.properties.id).toBeCloseTo(areas[feature.properties.id as keyof typeof areas], 5);
    }
  });

  it("formats area compactly and omits unknown or inherited IDs", () => {
    expect(formatPlaceArea("regional-mount-work-regional-park")).toBe("Approx. 7.54 km²");
    expect(formatPlaceArea("national-glacier-national-park")).toBe("Approx. 1,349 km²");
    expect(formatPlaceArea("regional-greenspaces-sunshine-coast-anavets-7018")).toBe("Approx. <0.01 km²");
    expect(formatPlaceArea("unknown-place")).toBeNull();
    expect(formatPlaceArea("toString")).toBeNull();
  });

  it("uses compact origins for each authority and a geographic fallback", () => {
    const expected = new Map([
      ["national-gulf-islands-national-park-reserve", "Parks Canada"],
      ["provincial-goldstream-park", "BC Parks"],
      ["island-saltspring-island", "BC Geographical Names"],
      ["regional-mount-work-regional-park", "Capital Region"],
      ["regional-mount-arrowsmith-massif-regional-park", "Nanaimo"],
      ["regional-mount-arrowsmith-regional-park-acrd", "Alberni-Clayoquot"],
      ["regional-osborne-bay-regional-park", "Cowichan Valley"],
      ["regional-bere-point-regional-park", "Mount Waddington"],
    ]);

    for (const [id, label] of expected) {
      const place = placesById.get(id);
      expect(place, id).toBeDefined();
      expect(shortOriginForPlace(place!), id).toBe(label);
    }

    expect(shortOriginForPlace({ id: "future-regional-place", category: "regional", region: "North Island", sourceName: "Unknown publisher" })).toBe("North Island");
    expect(shortOriginForPlace({ id: "future-regional-place", category: "regional", region: "  ", sourceName: "Unknown publisher" })).toBeNull();
  });
});
