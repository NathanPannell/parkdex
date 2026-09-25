import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";

export const PLACE_CATEGORY_COLORS = Object.freeze({
  island: "#247BA0",
  regional: "#D97706",
  provincial: "#D84A3A",
  national: "#7C4DFF",
});

export const MAP_INK = "#173D32";

const categoryColor: ExpressionSpecification = [
  "match",
  ["get", "category"],
  "island", PLACE_CATEGORY_COLORS.island,
  "regional", PLACE_CATEGORY_COLORS.regional,
  "provincial", PLACE_CATEGORY_COLORS.provincial,
  "national", PLACE_CATEGORY_COLORS.national,
  "#F6F0DC",
];

const visibleWhenNameDoesNotFit: ExpressionSpecification = [
  "case",
  ["boolean", ["feature-state", "nameVisible"], false],
  0,
  1,
];

/** Each point stays an individual map feature, including coincident points. */
export function placeMarkerLayerSpecifications(): LayerSpecification[] {
  return [
    {
      id: "place-hit-targets",
      type: "circle",
      source: "places",
      paint: { "circle-radius": 30, "circle-color": "rgba(0,0,0,0)" },
    },
    {
      id: "place-points",
      type: "circle",
      source: "places",
      paint: {
        "circle-color": categoryColor,
        "circle-radius": ["case", ["==", ["get", "groupSelected"], 1], 8, ["==", ["get", "visited"], 1], 6, 5],
        "circle-opacity": visibleWhenNameDoesNotFit,
        "circle-stroke-color": MAP_INK,
        "circle-stroke-width": ["case", ["==", ["get", "groupSelected"], 1], 3, 2],
        "circle-stroke-opacity": visibleWhenNameDoesNotFit,
      },
    },
    {
      id: "place-checks",
      type: "symbol",
      source: "places",
      filter: ["==", ["get", "visited"], 1],
      layout: { "text-field": "✓", "text-size": 15, "text-font": ["Noto Sans Bold"] },
      paint: { "text-color": "#FFFAF0", "text-opacity": visibleWhenNameDoesNotFit },
    },
  ];
}

/** MapLibre hides colliding labels automatically, while visible names remain clickable. */
export function placeNameLayerSpecifications(): LayerSpecification[] {
  return [
    {
      id: "place-name-labels",
      type: "symbol",
      source: "place-names",
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 8, 12, 12, 14, 15, 16],
        "text-anchor": "center",
        "text-offset": [0, 0],
        "text-padding": 5,
        "text-max-width": 18,
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "symbol-sort-key": ["get", "labelPriority"],
      },
      paint: {
        "text-color": MAP_INK,
        "text-halo-color": "#FFFAF0",
        "text-halo-width": 2,
        "text-halo-blur": 0.25,
      },
    },
  ];
}
