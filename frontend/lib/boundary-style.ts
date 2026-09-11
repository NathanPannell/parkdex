import type { LayerSpecification } from "maplibre-gl";

import { boundaryFilter, selectedBoundaryFilter } from "./boundaries";

export const BOUNDARY_SOURCE_ID = "park-boundaries";
export const BOUNDARY_DISPLAY_SOURCE_ID = "park-boundaries-display";

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
        "line-color": "#ffd862",
        "line-opacity": 0.18,
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
        "fill-color": "#ffd862",
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["boolean", ["feature-state", "visited"], false], 0.055, 0.025], 8, ["case", ["boolean", ["feature-state", "visited"], false], 0.1, 0.055], 12, ["case", ["boolean", ["feature-state", "visited"], false], 0.15, 0.09]],
      },
    },
    {
      id: "boundary-island-line",
      type: "line",
      source: displaySource,
      filter: unfiltered,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#9b641f",
        "line-opacity": ["case", ["boolean", ["feature-state", "visited"], false], 0.78, 0.52],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.65, 10, 1.35, 14, 2],
        "line-dasharray": [3, 2],
      },
    },
    {
      id: "boundary-park-buffer",
      type: "line",
      source: displaySource,
      filter: unfiltered,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["match", ["get", "category"], "national", "#ffd862", "provincial", "#b9ea55", "regional", "#ef755f", "#b9ea55"],
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
        "fill-color": ["match", ["get", "category"], "national", "#ffd862", "provincial", "#b9ea55", "regional", "#ef755f", "#b9ea55"],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["boolean", ["feature-state", "visited"], false], 0.1, 0.055], 8, ["case", ["boolean", ["feature-state", "visited"], false], 0.17, 0.1], 12, ["case", ["boolean", ["feature-state", "visited"], false], 0.24, 0.16]],
      },
    },
    {
      id: "boundary-park-line",
      type: "line",
      source: displaySource,
      filter: unfiltered,
      layout: { "line-cap": "round", "line-join": "round" },
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
      source: displaySource,
      filter: selectedBoundaryFilter(null, []),
      paint: {
        "fill-color": ["match", ["get", "category"], "national", "#ffd862", "provincial", "#b9ea55", "regional", "#ef755f", "#b9ea55"],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.44, 9, 0.52, 12, 0.6],
      },
    },
    {
      id: "boundary-selected-halo",
      type: "line",
      source: displaySource,
      filter: selectedBoundaryFilter(null, []),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#fffaf0", "line-opacity": 0.95, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 4.5, 12, 8.5] },
    },
    {
      id: "boundary-selected-line",
      type: "line",
      source: displaySource,
      filter: selectedBoundaryFilter(null, []),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["case", ["==", ["get", "category"], "island"], "#9b641f", "#173d32"],
        "line-opacity": 1,
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
