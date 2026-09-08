import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";

export const PLACE_CATEGORY_COLORS = Object.freeze({
  island: "#247BA0",
  regional: "#D97706",
  provincial: "#D84A3A",
  national: "#7C4DFF",
});

export const CLUSTER_COLOR = "#F4C84A";
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

export function placeMarkerLayerSpecifications(): LayerSpecification[] {
  return [
    {
      id: "cluster-hit-targets",
      type: "circle",
      source: "places",
      filter: ["has", "point_count"],
      paint: {
        "circle-radius": ["step", ["get", "point_count"], 32, 12, 37, 35, 42],
        "circle-color": "rgba(0,0,0,0)",
      },
    },
    {
      id: "clusters",
      type: "circle",
      source: "places",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": CLUSTER_COLOR,
        "circle-radius": ["step", ["get", "point_count"], 20, 12, 25, 35, 30],
        "circle-stroke-color": MAP_INK,
        "circle-stroke-width": 3,
      },
    },
    {
      id: "cluster-count",
      type: "symbol",
      source: "places",
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 14,
      },
      paint: {
        "text-color": MAP_INK,
        "text-opacity-transition": { duration: 0, delay: 0 },
      },
    },
    {
      id: "place-hit-targets",
      type: "circle",
      source: "places",
      filter: ["!", ["has", "point_count"]],
      paint: { "circle-radius": 30, "circle-color": "rgba(0,0,0,0)" },
    },
    {
      id: "place-points",
      type: "circle",
      source: "places",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": categoryColor,
        "circle-radius": ["case", ["==", ["get", "visited"], 1], 13, 10],
        "circle-stroke-color": MAP_INK,
        "circle-stroke-width": 3,
      },
    },
    {
      id: "place-checks",
      type: "symbol",
      source: "places",
      filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "visited"], 1]],
      layout: { "text-field": "✓", "text-size": 15, "text-font": ["Noto Sans Bold"] },
      paint: { "text-color": "#FFFAF0" },
    },
  ];
}
