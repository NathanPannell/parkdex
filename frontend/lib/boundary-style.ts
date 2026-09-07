import type { LayerSpecification } from "maplibre-gl";

import { boundaryFilter, selectedBoundaryFilter } from "./boundaries";

export const BOUNDARY_SOURCE_ID = "park-boundaries";

export function boundaryLayerSpecifications(): LayerSpecification[] {
  const unfiltered = boundaryFilter([]);
  return [
    {
      id: "boundary-island-fill",
      type: "fill",
      source: BOUNDARY_SOURCE_ID,
      filter: unfiltered,
      paint: {
        "fill-color": "#ffd862",
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["boolean", ["feature-state", "visited"], false], 0.055, 0.025], 8, ["case", ["boolean", ["feature-state", "visited"], false], 0.1, 0.055], 12, ["case", ["boolean", ["feature-state", "visited"], false], 0.15, 0.09]],
      },
    },
    {
      id: "boundary-island-line",
      type: "line",
      source: BOUNDARY_SOURCE_ID,
      filter: unfiltered,
      paint: {
        "line-color": "#9b641f",
        "line-opacity": ["case", ["boolean", ["feature-state", "visited"], false], 0.78, 0.52],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.65, 10, 1.35, 14, 2],
        "line-dasharray": [3, 2],
      },
    },
    {
      id: "boundary-park-fill",
      type: "fill",
      source: BOUNDARY_SOURCE_ID,
      filter: unfiltered,
      paint: {
        "fill-color": ["match", ["get", "category"], "national", "#ffd862", "provincial", "#b9ea55", "regional", "#ef755f", "#b9ea55"],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["boolean", ["feature-state", "visited"], false], 0.1, 0.055], 8, ["case", ["boolean", ["feature-state", "visited"], false], 0.17, 0.1], 12, ["case", ["boolean", ["feature-state", "visited"], false], 0.24, 0.16]],
      },
    },
    {
      id: "boundary-park-line",
      type: "line",
      source: BOUNDARY_SOURCE_ID,
      filter: unfiltered,
      paint: {
        "line-color": "#173d32",
        "line-opacity": ["case", ["boolean", ["feature-state", "visited"], false], 0.88, 0.62],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.7, 10, 1.45, 14, 2.15],
        "line-dasharray": [3, 2],
      },
    },
    {
      id: "boundary-selected-fill",
      type: "fill",
      source: BOUNDARY_SOURCE_ID,
      filter: selectedBoundaryFilter(null, []),
      paint: { "fill-color": "#ffd862", "fill-opacity": 0.3 },
    },
    {
      id: "boundary-selected-halo",
      type: "line",
      source: BOUNDARY_SOURCE_ID,
      filter: selectedBoundaryFilter(null, []),
      paint: { "line-color": "#fffaf0", "line-opacity": 0.95, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 6] },
    },
    {
      id: "boundary-selected-line",
      type: "line",
      source: BOUNDARY_SOURCE_ID,
      filter: selectedBoundaryFilter(null, []),
      paint: {
        "line-color": ["case", ["==", ["get", "category"], "island"], "#9b641f", "#173d32"],
        "line-opacity": 1,
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.5, 12, 3],
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
