import { featureFilter, validateStyleMin, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import {
  CURRENT_LOCATION_SOURCE_ID,
  currentLocationLayerSpecifications,
  explorationBoundaryFilter,
  EXPLORATION_TERRITORY_SOURCE_ID,
  explorationLayerSpecifications,
  explorationVisitedFilter,
} from "./exploration-map-style";

function boundaryFilterMatches(visitedIds: string[], ownerA: string, ownerB: string | null) {
  const compiled = featureFilter(explorationBoundaryFilter(visitedIds), "layers.test.filter").filter;
  return compiled({ zoom: 5 }, { properties: { kind: "territory-edge", ownerA, ownerB } } as never);
}

describe("exploration map style", () => {
  it("validates the land-outline, territory, and heading-aware location layers", () => {
    const style: StyleSpecification = {
      version: 8,
      glyphs: "https://example.com/{fontstack}/{range}.pbf",
      sources: {
        [EXPLORATION_TERRITORY_SOURCE_ID]: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        [CURRENT_LOCATION_SOURCE_ID]: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: [...explorationLayerSpecifications(), ...currentLocationLayerSpecifications()],
    };
    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });

  it("shows no territory for zero visits and every requested territory for all visits", () => {
    expect(explorationVisitedFilter([])).toEqual([
      "all",
      ["==", ["get", "kind"], "estimated-territory"],
      ["in", ["get", "id"], ["literal", []]],
    ]);
    expect(explorationVisitedFilter(["remote", "national", "remote"])).toEqual([
      "all",
      ["==", ["get", "kind"], "estimated-territory"],
      ["in", ["get", "id"], ["literal", ["national", "remote"]]],
    ]);
  });

  it("uses one continuous fill so adjacent visited cells cannot look like gaps", () => {
    const layers = explorationLayerSpecifications(["visited"]);
    expect(layers.map((layer) => layer.id)).toEqual([
      "exploration-scope-outline",
      "exploration-fill",
      "exploration-edge-glow",
      "exploration-edge",
    ]);
    expect(layers[0]).toMatchObject({ filter: ["==", ["get", "kind"], "exploration-scope"] });
    expect(layers[1]).toMatchObject({ paint: { "fill-color": "#8fd54f", "fill-opacity": 0.62 } });
    expect(layers[2]).toMatchObject({ layout: { "line-cap": "round", "line-join": "round" } });
    expect(layers[3]).toMatchObject({ paint: { "line-color": "#173d32", "line-opacity": 0.94 } });
  });

  it("draws an edge only where visited state changes between neighboring territories", () => {
    expect(explorationBoundaryFilter(["beta", "alpha", "beta"])).toEqual([
      "all",
      ["==", ["get", "kind"], "territory-edge"],
      ["!=",
        ["in", ["get", "ownerA"], ["literal", ["alpha", "beta"]]],
        ["in", ["get", "ownerB"], ["literal", ["alpha", "beta"]]],
      ],
    ]);
    expect(explorationBoundaryFilter([])).toContainEqual([
      "!=",
      ["in", ["get", "ownerA"], ["literal", []]],
      ["in", ["get", "ownerB"], ["literal", []]],
    ]);
    expect(boundaryFilterMatches(["visited"], "visited", "unvisited")).toBe(true);
    expect(boundaryFilterMatches(["visited-a", "visited-b"], "visited-a", "visited-b")).toBe(false);
    expect(boundaryFilterMatches(["visited"], "visited", null)).toBe(true);
    expect(boundaryFilterMatches([], "unvisited", null)).toBe(false);
  });

  it("keeps the pointer above its high-contrast location dot", () => {
    const ids = currentLocationLayerSpecifications().map((layer) => layer.id);
    expect(ids).toEqual(["current-location-halo", "current-location-dot", "current-location-heading"]);
    expect(currentLocationLayerSpecifications()[2]).toMatchObject({ filter: ["has", "heading"] });
  });
});
