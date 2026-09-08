import type { FilterSpecification, LayerSpecification } from "maplibre-gl";

export const EXPLORATION_TERRITORY_SOURCE_ID = "exploration-territories";
export const EXPLORATION_TERRITORY_DATA_URL = "/data/exploration-territories.v1.geojson";
export const CURRENT_LOCATION_SOURCE_ID = "current-location";

export function explorationVisitedFilter(visitedIds: readonly string[]): FilterSpecification {
  return [
    "all",
    ["==", ["get", "kind"], "estimated-territory"],
    ["in", ["get", "id"], ["literal", [...new Set(visitedIds)].sort()]],
  ];
}

export function explorationLayerSpecifications(visitedIds: readonly string[] = []): LayerSpecification[] {
  const visitedFilter = explorationVisitedFilter(visitedIds);
  return [
    {
      id: "exploration-scope-outline",
      type: "line",
      source: EXPLORATION_TERRITORY_SOURCE_ID,
      filter: ["==", ["get", "kind"], "exploration-scope"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#173d32",
        "line-opacity": 0.72,
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.25, 11, 2.5],
      },
    },
    {
      id: "exploration-fill",
      type: "fill",
      source: EXPLORATION_TERRITORY_SOURCE_ID,
      filter: visitedFilter,
      paint: { "fill-color": "#8fd54f", "fill-opacity": 0.62 },
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

