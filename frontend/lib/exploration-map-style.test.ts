import { validateStyleMin, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import {
  CURRENT_LOCATION_SOURCE_ID,
  currentLocationLayerSpecifications,
  EXPLORATION_TERRITORY_SOURCE_ID,
  explorationLayerSpecifications,
  explorationVisitedFilter,
} from "./exploration-map-style";

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
    ]);
    expect(layers[0]).toMatchObject({ filter: ["==", ["get", "kind"], "exploration-scope"] });
    expect(layers[1]).toMatchObject({ paint: { "fill-color": "#8fd54f", "fill-opacity": 0.62 } });
  });

  it("keeps the pointer above its high-contrast location dot", () => {
    const ids = currentLocationLayerSpecifications().map((layer) => layer.id);
    expect(ids).toEqual(["current-location-halo", "current-location-dot", "current-location-heading"]);
    expect(currentLocationLayerSpecifications()[2]).toMatchObject({ filter: ["has", "heading"] });
  });
});
