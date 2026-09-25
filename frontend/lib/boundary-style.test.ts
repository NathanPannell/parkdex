import { validateStyleMin, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { BOUNDARY_DISPLAY_SOURCE_ID, BOUNDARY_SOURCE_ID, boundaryLayerSpecifications } from "./boundary-style";
import { PLACE_CATEGORY_COLORS } from "./place-marker-style";

const expectedCategoryColor = [
  "match", ["get", "category"],
  "island", PLACE_CATEGORY_COLORS.island,
  "regional", PLACE_CATEGORY_COLORS.regional,
  "provincial", PLACE_CATEGORY_COLORS.provincial,
  "national", PLACE_CATEGORY_COLORS.national,
  "#8B7F6B",
];

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

  it("colors each boundary by place category and strengthens selected fills", () => {
    const layers = boundaryLayerSpecifications(BOUNDARY_DISPLAY_SOURCE_ID);
    const parkFill = layers.find((layer) => layer.id === "boundary-park-fill");
    const parkLine = layers.find((layer) => layer.id === "boundary-park-line");
    const islandFill = layers.find((layer) => layer.id === "boundary-island-fill");
    const islandLine = layers.find((layer) => layer.id === "boundary-island-line");
    const selectedFill = layers.find((layer) => layer.id === "boundary-selected-fill");
    const selectedHalo = layers.find((layer) => layer.id === "boundary-selected-halo");
    const selectedLine = layers.find((layer) => layer.id === "boundary-selected-line");
    const parkFillPaint = parkFill?.paint as Record<string, unknown> | undefined;
    const parkLinePaint = parkLine?.paint as Record<string, unknown> | undefined;
    const islandFillPaint = islandFill?.paint as Record<string, unknown> | undefined;
    const islandLinePaint = islandLine?.paint as Record<string, unknown> | undefined;
    const selectedFillPaint = selectedFill?.paint as Record<string, unknown> | undefined;
    const selectedLinePaint = selectedLine?.paint as Record<string, unknown> | undefined;

    expect(parkFillPaint?.["fill-color"]).toEqual(expectedCategoryColor);
    expect(parkLinePaint?.["line-color"]).toEqual(expectedCategoryColor);
    expect(islandFillPaint?.["fill-color"]).toEqual(expectedCategoryColor);
    expect(islandLinePaint?.["line-color"]).toEqual(expectedCategoryColor);
    expect(selectedFillPaint?.["fill-color"]).toEqual(expectedCategoryColor);
    expect(selectedLinePaint?.["line-color"]).toEqual(expectedCategoryColor);
    expect(parkFillPaint?.["fill-opacity"]).toEqual([
      "interpolate", ["linear"], ["zoom"],
      5, ["case", ["boolean", ["feature-state", "visited"], false], 0.22, 0.16],
      8, ["case", ["boolean", ["feature-state", "visited"], false], 0.3, 0.23],
      12, ["case", ["boolean", ["feature-state", "visited"], false], 0.38, 0.3],
    ]);
    expect(selectedFillPaint?.["fill-opacity"]).toEqual(["interpolate", ["linear"], ["zoom"], 5, 0.54, 9, 0.6, 12, 0.66]);
    expect((selectedHalo?.paint as Record<string, unknown> | undefined)?.["line-width"])
      .toEqual(["interpolate", ["linear"], ["zoom"], 5, 4.5, 12, 8.5]);
    expect((selectedLine?.paint as Record<string, unknown> | undefined)?.["line-width"])
      .toEqual(["interpolate", ["linear"], ["zoom"], 5, 2.8, 12, 5.5]);
  });
});
