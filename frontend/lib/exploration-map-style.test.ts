import { validateStyleMin, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import {
  CURRENT_LOCATION_SOURCE_ID,
  currentLocationLayerSpecifications,
  EXPLORATION_SOURCE_ID,
  explorationLayerSpecifications,
} from "./exploration-map-style";

describe("exploration map style", () => {
  it("validates the exploration and heading-aware location layers", () => {
    const style: StyleSpecification = {
      version: 8,
      glyphs: "https://example.com/{fontstack}/{range}.pbf",
      sources: {
        [EXPLORATION_SOURCE_ID]: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        [CURRENT_LOCATION_SOURCE_ID]: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: [...explorationLayerSpecifications(), ...currentLocationLayerSpecifications()],
    };
    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });

  it("keeps the pointer above its high-contrast location dot", () => {
    const ids = currentLocationLayerSpecifications().map((layer) => layer.id);
    expect(ids).toEqual(["current-location-halo", "current-location-dot", "current-location-heading"]);
    expect(currentLocationLayerSpecifications()[2]).toMatchObject({ filter: ["has", "heading"] });
  });
});
