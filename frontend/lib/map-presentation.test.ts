import { describe, expect, it } from "vitest";

import type { BoundaryCollection, BoundaryIndex } from "./boundaries";
import { mapPresentation, normalizeMapViewport, placeMarkerData, placeNameData, type MapViewport } from "./map-presentation";
import type { Place } from "./places";

function place(id: string, longitude: number, latitude = 49, category: Place["category"] = "provincial"): Place {
  return {
    id,
    name: id,
    category,
    latitude,
    longitude,
    region: "Coast",
    description: "Park",
    sourceUrl: "https://example.test",
    sourceName: "Example",
  };
}

function bounds(west: number, south: number, east: number, north: number): BoundaryIndex["boundsById"][string] {
  return [[west, south], [east, north]];
}

function boundary(id: string): BoundaryCollection["features"][number] {
  return {
    type: "Feature",
    id,
    properties: { id, name: id, category: "provincial", sourceName: "Example", sourceUrl: "https://example.test", sourceId: null },
    geometry: { type: "Polygon", coordinates: [[[-124, 49], [-123.9, 49], [-123.9, 49.1], [-124, 49.1], [-124, 49]]] },
  };
}

const closeViewport: MapViewport = { west: -125, south: 48, east: -123, north: 50, zoom: 10 };

describe("map viewport normalization", () => {
  it("wraps unbounded longitudes without losing antimeridian or full-world coverage", () => {
    expect(normalizeMapViewport({ west: 170, south: -95, east: 190, north: 95, zoom: 4 })).toEqual({
      west: 170,
      south: -90,
      east: -170,
      north: 90,
      zoom: 4,
    });
    expect(normalizeMapViewport({ west: 530, south: 45, east: 550, north: 55, zoom: 5 })).toEqual({
      west: 170,
      south: 45,
      east: -170,
      north: 55,
      zoom: 5,
    });
    expect(normalizeMapViewport({ west: -200, south: 45, east: 200, north: 55, zoom: 1 })).toEqual({
      west: -180,
      south: 45,
      east: 180,
      north: 55,
      zoom: 1,
    });
  });
});

describe("application map presentation", () => {
  it("keeps coincident places as individual pin features without counts", () => {
    const places = [place("provincial-denetiah-park", -124), place("provincial-entiako-park", -124)];
    const data = placeMarkerData(places, new Set(), new Set());

    expect(data.features).toHaveLength(2);
    expect(data.features.map((feature) => feature.id)).toEqual(places.map((item) => item.id));
    expect(data.features.map((feature) => feature.geometry.coordinates)).toEqual([[-124, 49], [-124, 49]]);
    expect(data.features.every((feature) => !("point_count" in (feature.properties ?? {})))).toBe(true);
  });

  it("offers every sampled name to collision placement, including islands", () => {
    const parks = [
      place("national-glacier-national-park", -124, 49, "national"),
      place("provincial-denetiah-park", -124.2),
      place("regional-horne-lake-regional-park", -124.4),
      place("island-bowen-island", -124.6, 49, "island"),
      place("outside", -130),
    ];
    const labels = placeNameData(parks, closeViewport);

    expect(labels.features.map((feature) => feature.properties.id)).toEqual([
      "national-glacier-national-park",
      "island-bowen-island",
      "provincial-denetiah-park",
      "regional-horne-lake-regional-park",
    ]);
    expect(labels.features.find((feature) => feature.properties.id === "island-bowen-island")?.properties.category).toBe("island");
  });

  it("does not offer a name when its pin anchor is outside the viewport", () => {
    const park = place("national-glacier-national-park", -126);

    expect(placeNameData([park], closeViewport).features).toEqual([]);
  });

  it("offers names for sparse samples and lets MapLibre resolve collisions", () => {
    const parks = [
      place("national-glacier-national-park", -124, 49, "national"),
      place("provincial-denetiah-park", -124.2),
      place("regional-horne-lake-regional-park", -124.4),
      place("island-bowen-island", -124.6, 49, "island"),
    ];
    const labels = placeNameData(parks, closeViewport);

    expect(labels.features.map((feature) => feature.properties.id)).toEqual([
      "national-glacier-national-park",
      "island-bowen-island",
      "provincial-denetiah-park",
      "regional-horne-lake-regional-park",
    ]);
  });

  it("keeps all candidates in dense samples so dots can represent names that collide", () => {
    const parks = [
      ...Array.from({ length: 12 }, (_, index) => place(`sample-${index}`, -124.5 + index * 0.05)),
    ];

    expect(placeNameData(parks, closeViewport).features).toHaveLength(12);
  });

  it("keeps markers and boundaries inside the gateway-supplied sample", () => {
    const places = [place("visible", -124)];
    const index: BoundaryIndex = {
      version: 1,
      boundsById: {
        visible: bounds(-124.1, 48.9, -123.9, 49.1),
        "not-sampled": bounds(-118.1, 48.9, -117.9, 49.1),
      },
    };
    const boundaryAsset: BoundaryCollection = { type: "FeatureCollection", features: [boundary("visible"), boundary("not-sampled")] };
    const result = mapPresentation({
      places,
      visited: new Set(["visible"]),
      mode: "explored",
      selectedId: "not-sampled",
      selectedIds: new Set(),
      viewport: closeViewport,
      boundaryIndex: index,
      boundaryAsset,
      selectedBoundary: boundary("not-sampled"),
    });

    expect(result.boundaryData.features.map((feature) => feature.properties.id)).toEqual(["visible"]);
    expect([...result.boundaryIds]).toEqual(["visible"]);
    expect(result.placeData.features.map((feature) => feature.properties.id)).toEqual(["visible"]);
    expect(result.placeData.features[0].properties.visited).toBe(1);
  });
});
