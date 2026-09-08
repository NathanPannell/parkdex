import type { LayerSpecification } from "maplibre-gl";

export const EXPLORATION_SOURCE_ID = "exploration";
export const CURRENT_LOCATION_SOURCE_ID = "current-location";

export function explorationLayerSpecifications(): LayerSpecification[] {
  return [
    {
      id: "exploration-fill",
      type: "fill",
      source: EXPLORATION_SOURCE_ID,
      paint: { "fill-color": "#b9ea55", "fill-opacity": 0.2 },
    },
    {
      id: "exploration-edge",
      type: "line",
      source: EXPLORATION_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#47745f",
        "line-opacity": 0.68,
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 11, 2.25],
      },
    },
  ];
}

export function currentLocationLayerSpecifications(): LayerSpecification[] {
  return [
    {
      id: "current-location-halo",
      type: "circle",
      source: CURRENT_LOCATION_SOURCE_ID,
      paint: {
        "circle-radius": 14,
        "circle-color": "#fffaf0",
        "circle-opacity": 0.84,
        "circle-stroke-color": "#173d32",
        "circle-stroke-width": 1.5,
      },
    },
    {
      id: "current-location-dot",
      type: "circle",
      source: CURRENT_LOCATION_SOURCE_ID,
      paint: { "circle-radius": 6, "circle-color": "#2b7a78", "circle-stroke-color": "#fffaf0", "circle-stroke-width": 2 },
    },
    {
      id: "current-location-heading",
      type: "symbol",
      source: CURRENT_LOCATION_SOURCE_ID,
      filter: ["has", "heading"],
      layout: {
        "text-field": "▲",
        "text-font": ["Noto Sans Bold"],
        "text-size": 18,
        "text-offset": [0, -1.05],
        "text-rotate": ["get", "heading"],
        "text-rotation-alignment": "map",
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#173d32", "text-halo-color": "#fffaf0", "text-halo-width": 1.5 },
    },
  ];
}

