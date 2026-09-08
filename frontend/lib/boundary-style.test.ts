import { validateStyleMin, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { BOUNDARY_DISPLAY_SOURCE_ID, BOUNDARY_SOURCE_ID, boundaryLayerSpecifications } from "./boundary-style";

describe("boundary map style", () => {
  it("passes MapLibre style validation with zoom and visited-state expressions", () => {
    const style: StyleSpecification = {
      version: 8,
      sources: {
        [BOUNDARY_SOURCE_ID]: {
          type: "geojson",
          promoteId: "id",
          data: {
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              properties: { id: "park", category: "provincial" },
              geometry: { type: "Polygon", coordinates: [[[-125, 49], [-124, 49], [-124, 50], [-125, 49]]] },
            }],
          },
        },
        [BOUNDARY_DISPLAY_SOURCE_ID]: {
          type: "geojson",
          promoteId: "id",
          data: { type: "FeatureCollection", features: [] },
        },
      },
      layers: boundaryLayerSpecifications(BOUNDARY_DISPLAY_SOURCE_ID),
    };

    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });

  it("uses display-only outer strokes with rounded joins without changing source geometry", () => {
    const layers = boundaryLayerSpecifications(BOUNDARY_DISPLAY_SOURCE_ID);
    const parkBuffer = layers.find((layer) => layer.id === "boundary-park-buffer");
    const islandBuffer = layers.find((layer) => layer.id === "boundary-island-buffer");
    const parkLine = layers.find((layer) => layer.id === "boundary-park-line");

    expect(parkBuffer).toMatchObject({ type: "line", layout: { "line-cap": "round", "line-join": "round" } });
    expect(islandBuffer).toMatchObject({ type: "line", layout: { "line-cap": "round", "line-join": "round" } });
    expect(parkLine).toMatchObject({ layout: { "line-cap": "round", "line-join": "round" } });
    expect(layers.findIndex((layer) => layer.id === "boundary-park-buffer"))
      .toBeLessThan(layers.findIndex((layer) => layer.id === "boundary-park-fill"));
    expect(parkBuffer).toMatchObject({ source: BOUNDARY_DISPLAY_SOURCE_ID });
    expect(layers.find((layer) => layer.id === "boundary-hit")).toMatchObject({ source: BOUNDARY_SOURCE_ID });
  });
});
