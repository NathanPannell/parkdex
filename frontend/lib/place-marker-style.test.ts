import { validateStyleMin, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { CLUSTER_COLOR, PLACE_CATEGORY_COLORS, placeMarkerLayerSpecifications } from "./place-marker-style";

describe("place marker map style", () => {
  const layers = placeMarkerLayerSpecifications();

  it("uses one yellow for every cluster and an instant count label", () => {
    expect(layers.find((layer) => layer.id === "clusters")).toMatchObject({
      paint: { "circle-color": CLUSTER_COLOR },
    });
    expect(layers.find((layer) => layer.id === "cluster-count")).toMatchObject({
      paint: { "text-opacity-transition": { duration: 0, delay: 0 } },
    });
  });

  it("keeps visible category markers smaller than their touch targets", () => {
    expect(layers.find((layer) => layer.id === "place-hit-targets")).toMatchObject({
      paint: { "circle-radius": 30, "circle-color": "rgba(0,0,0,0)" },
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

  it("passes MapLibre style validation", () => {
    const style: StyleSpecification = {
      version: 8,
      sources: { places: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      layers,
    };
    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });
});
