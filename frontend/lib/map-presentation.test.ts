import { describe, expect, it } from "vitest";

import type { BoundaryCollection, BoundaryIndex } from "./boundaries";
import { mapPresentation, PARK_NAME_LABEL_EXPANSION_LIMIT, PARK_NAME_LABEL_MIN_ZOOM, placeMarkerData, placeNameData, type MapViewport } from "./map-presentation";
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

const closeViewport: MapViewport = { west: -125, south: 48, east: -123, north: 50, zoom: PARK_NAME_LABEL_MIN_ZOOM };

describe("application map presentation", () => {
  it("keeps coincident places as individual pin features without counts", () => {
    const places = [place("provincial-denetiah-park", -124), place("provincial-entiako-park", -124)];
    const data = placeMarkerData(places, new Set(), new Set());

    expect(data.features).toHaveLength(2);
    expect(data.features.map((feature) => feature.geometry.coordinates)).toEqual([[-124, 49], [-124, 49]]);
    expect(data.features.every((feature) => !("point_count" in (feature.properties ?? {})))).toBe(true);
  });

  it("shows the largest park label when the viewport is broad", () => {
    const parks = [
      place("national-glacier-national-park", -124),
      place("provincial-denetiah-park", -124.2),
      place("regional-horne-lake-regional-park", -124.4),
      place("island-bowen-island", -124.6, 49, "island"),
    ];
    const index: BoundaryIndex = {
      version: 1,
      boundsById: Object.fromEntries(parks.map((item) => [item.id, bounds(item.longitude - 0.01, 48.9, item.longitude + 0.01, 49.1)])),
    };
    const labels = placeNameData(parks, { ...closeViewport, zoom: PARK_NAME_LABEL_MIN_ZOOM - 1 }, index);

    expect(labels.features.map((feature) => feature.properties.id)).toEqual(["national-glacier-national-park"]);
  });

  it("does not place a label for a visible boundary when its pin anchor is outside the viewport", () => {
    const park = place("national-glacier-national-park", -126);
    const index: BoundaryIndex = {
      version: 1,
      boundsById: { [park.id]: bounds(-124.1, 48.9, -123.9, 49.1) },
    };

    expect(placeNameData([park], closeViewport, index).features).toEqual([]);
  });

  it("expands to collision-aware candidate labels for five or fewer visible parks at close zoom", () => {
    const parks = [
      place("national-glacier-national-park", -124),
      place("provincial-denetiah-park", -124.2),
      place("regional-horne-lake-regional-park", -124.4),
    ];
    const index: BoundaryIndex = {
      version: 1,
      boundsById: Object.fromEntries(parks.map((item) => [item.id, bounds(item.longitude - 0.01, 48.9, item.longitude + 0.01, 49.1)])),
    };
    const labels = placeNameData(parks, closeViewport, index);

    expect(labels.features.map((feature) => feature.properties.id)).toEqual([
      "national-glacier-national-park",
      "provincial-denetiah-park",
      "regional-horne-lake-regional-park",
    ]);
  });

  it("keeps one largest label once more than five parks are visible", () => {
    const parks = [
      place("national-glacier-national-park", -124),
      place("provincial-denetiah-park", -124.2),
      place("regional-horne-lake-regional-park", -124.4),
      ...Array.from({ length: PARK_NAME_LABEL_EXPANSION_LIMIT + 1 }, (_, index) => place(`small-${index}`, -124.5 + index * 0.05)),
    ];
    const index: BoundaryIndex = {
      version: 1,
      boundsById: Object.fromEntries(parks.map((item) => [item.id, bounds(item.longitude - 0.01, 48.9, item.longitude + 0.01, 49.1)])),
    };

    expect(placeNameData(parks, closeViewport, index).features.map((feature) => feature.properties.id)).toEqual(["national-glacier-national-park"]);
  });

  it("prepares only viewport and selected boundary features for the renderer", () => {
    const places = [
      place("visible", -124),
      place("outside", -120),
      place("selected-outside", -118),
    ];
    const index: BoundaryIndex = {
      version: 1,
      boundsById: {
        visible: bounds(-124.1, 48.9, -123.9, 49.1),
        outside: bounds(-120.1, 48.9, -119.9, 49.1),
        "selected-outside": bounds(-118.1, 48.9, -117.9, 49.1),
      },
    };
    const boundaryAsset: BoundaryCollection = { type: "FeatureCollection", features: places.map((item) => boundary(item.id)) };
    const result = mapPresentation({
      places,
      visited: new Set(["visible"]),
      mode: "explored",
      selectedId: "selected-outside",
      selectedIds: new Set(),
      viewport: closeViewport,
      boundaryIndex: index,
      boundaryAsset,
    });

    expect(result.boundaryData.features.map((feature) => feature.properties.id).sort()).toEqual(["selected-outside", "visible"]);
    expect(result.placeData.features).toHaveLength(3);
    expect(result.placeData.features[0].properties.visited).toBe(1);
  });
});
