import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";

import { boundaryFilter, selectedBoundaryFilter } from "./boundaries";
import { PLACE_CATEGORY_COLORS } from "./place-marker-style";

export const BOUNDARY_SOURCE_ID = "park-boundaries";
export const BOUNDARY_DISPLAY_SOURCE_ID = "park-boundaries-display";

const boundaryCategoryColor: ExpressionSpecification = [
  "match",
  ["get", "category"],
  "island", PLACE_CATEGORY_COLORS.island,
  "regional", PLACE_CATEGORY_COLORS.regional,
  "provincial", PLACE_CATEGORY_COLORS.provincial,
  "national", PLACE_CATEGORY_COLORS.national,
  "#8B7F6B",
];
const selectedState: ExpressionSpecification = ["boolean", ["feature-state", "selected"], false];
const selectedFillOpacity: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  5, ["case", selectedState, 0.54, 0],
  9, ["case", selectedState, 0.6, 0],
  12, ["case", selectedState, 0.66, 0],
];

export function boundaryLayerSpecifications(displaySource = BOUNDARY_SOURCE_ID): LayerSpecification[] {
  const unfiltered = boundaryFilter([]);
  return [
    {
      id: "boundary-island-buffer",
      type: "line",
      source: displaySource,
      filter: unfiltered,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": boundaryCategoryColor,
        "line-opacity": 0.12,
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2.4, 10, 5.5, 14, 8],
        "line-blur": ["interpolate", ["linear"], ["zoom"], 5, 0.4, 14, 1.2],
      },
    },
    {
      id: "boundary-island-fill",
      type: "fill",
      source: displaySource,
      filter: unfiltered,
      paint: {
        "fill-color": boundaryCategoryColor,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["boolean", ["feature-state", "visited"], false], 0.22, 0.16], 8, ["case", ["boolean", ["feature-state", "visited"], false], 0.3, 0.23], 12, ["case", ["boolean", ["feature-state", "visited"], false], 0.38, 0.3]],
      },
    },
    {
      id: "boundary-island-line",
      type: "line",
      source: displaySource,
      filter: unfiltered,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": boundaryCategoryColor,
        "line-opacity": ["case", ["boolean", ["feature-state", "visited"], false], 0.98, 0.9],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.65, 10, 1.35, 14, 2],
      },
    },
    {
      id: "boundary-park-buffer",
      type: "line",
      source: displaySource,
      filter: unfiltered,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": boundaryCategoryColor,
        // Keep a restrained colour echo around the rounded perimeter. The
        // display asset no longer offsets park geometry, so this layer must
        // not recreate the old padded silhouette between adjacent parks.
        "line-opacity": 0.12,
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.2, 10, 2.1, 14, 3],
        "line-blur": ["interpolate", ["linear"], ["zoom"], 5, 0.25, 14, 0.6],
      },
    },
    {
      id: "boundary-park-fill",
      type: "fill",
      source: displaySource,
      filter: unfiltered,
      paint: {
        "fill-color": boundaryCategoryColor,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["boolean", ["feature-state", "visited"], false], 0.22, 0.16], 8, ["case", ["boolean", ["feature-state", "visited"], false], 0.3, 0.23], 12, ["case", ["boolean", ["feature-state", "visited"], false], 0.38, 0.3]],
      },
    },
    {
      id: "boundary-park-line",
      type: "line",
      source: displaySource,
      filter: unfiltered,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": boundaryCategoryColor,
        "line-opacity": ["case", ["boolean", ["feature-state", "visited"], false], 1, 0.92],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.7, 10, 1.45, 14, 2.15],
      },
    },
    {
      id: "boundary-selected-fill",
      type: "fill",
      source: displaySource,
      filter: selectedBoundaryFilter(null, []),
      paint: {
        "fill-color": boundaryCategoryColor,
        "fill-opacity": selectedFillOpacity,
      },
    },
    {
      id: "boundary-selected-halo",
      type: "line",
      source: displaySource,
      filter: selectedBoundaryFilter(null, []),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#fffaf0",
        "line-opacity": ["case", selectedState, 0.95, 0],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 4.5, 12, 8.5],
      },
    },
    {
      id: "boundary-selected-line",
      type: "line",
      source: displaySource,
      filter: selectedBoundaryFilter(null, []),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": boundaryCategoryColor,
        "line-opacity": ["case", selectedState, 1, 0],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2.8, 12, 5.5],
      },
    },
    {
      id: "boundary-hit",
      type: "fill",
      source: BOUNDARY_SOURCE_ID,
      filter: unfiltered,
      paint: { "fill-color": "#173d32", "fill-opacity": 0.001 },
    },
  ];
}
