import { validateStyleMin, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { BOUNDARY_SOURCE_ID, boundaryLayerSpecifications } from "./boundary-style";

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
      },
      layers: boundaryLayerSpecifications(),
    };

    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });
});
