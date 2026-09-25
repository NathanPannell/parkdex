import { validateStyleMin, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { PLACE_CATEGORY_COLORS, placeMarkerLayerSpecifications, placeNameLayerSpecifications } from "./place-marker-style";

describe("place marker map style", () => {
  const layers = [...placeMarkerLayerSpecifications(), ...placeNameLayerSpecifications()];

  it("renders individual pins and has no cluster or count layers", () => {
    expect(layers.map((layer) => layer.id)).toEqual([
      "place-hit-targets",
      "place-points",
      "place-checks",
      "place-name-labels",
    ]);
    expect(layers.some((layer) => layer.id.includes("cluster"))).toBe(false);
  });

  it("keeps small category dots while preserving large touch targets", () => {
    expect(layers.find((layer) => layer.id === "place-hit-targets")).toMatchObject({
      paint: { "circle-radius": 30, "circle-color": "rgba(0,0,0,0)" },
    });
    expect(layers.find((layer) => layer.id === "place-points")).toMatchObject({
      paint: {
        "circle-radius": ["case", ["==", ["get", "groupSelected"], 1], 8, ["==", ["get", "visited"], 1], 6, 5],
        "circle-opacity": ["case", ["boolean", ["feature-state", "nameVisible"], false], 0, 1],
        "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "nameVisible"], false], 0, 1],
      },
    });
    expect(layers.find((layer) => layer.id === "place-points")).toMatchObject({
      paint: { "circle-color": [
        "match", ["get", "category"],
        "island", PLACE_CATEGORY_COLORS.island,
        "regional", PLACE_CATEGORY_COLORS.regional,
        "provincial", PLACE_CATEGORY_COLORS.provincial,
        "national", PLACE_CATEGORY_COLORS.national,
        "#F6F0DC",
      ] },
    });
  });

  it("lets MapLibre place names where they fit and prioritizes national parks and islands", () => {
    expect(layers.find((layer) => layer.id === "place-name-labels")).toMatchObject({
      layout: {
        "text-anchor": "center",
        "text-offset": [0, 0],
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "symbol-sort-key": ["get", "labelPriority"],
      },
    });
    expect(layers.find((layer) => layer.id === "place-checks")).toMatchObject({
      paint: { "text-opacity": ["case", ["boolean", ["feature-state", "nameVisible"], false], 0, 1] },
    });
  });

  it("passes MapLibre style validation", () => {
    const style: StyleSpecification = {
      version: 8,
      sources: {
        places: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        "place-names": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers,
    };
    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });
});
