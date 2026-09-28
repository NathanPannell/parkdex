import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

// Must match the extract bounds in scripts/fetch-map.mjs.
export const ISLAND_BOUNDS: [number, number, number, number] = [-128.45, 48.28, -123.25, 50.92];

// Storybook palette over the bundled Protomaps tiles: warm paper land,
// candy water, soft greens and quiet roads.
const FLAVOR: Flavor = {
  ...namedFlavor("light"),
  background: "#A8E1EC",
  earth: "#F7ECD8",
  park_a: "#D5ECC0",
  park_b: "#C9E7B2",
  wood_a: "#D3EBBE",
  wood_b: "#C6E4AE",
  scrub_a: "#E3F0C8",
  scrub_b: "#DCEDBE",
  glacier: "#FFFFFF",
  sand: "#FBE3B0",
  beach: "#FBE3B0",
  water: "#A8E1EC",
  buildings: "#EAD6B6",
  pedestrian: "#F3E3C8",
  hospital: "#F6E0D0",
  school: "#F6E6C8",
  industrial: "#EFE2CC",
  aerodrome: "#EFE4D2",
  zoo: "#D5ECC0",
  military: "#EFE4D2",
  minor_casing: "#E9D4B0",
  minor_service_casing: "#E9D4B0",
  link_casing: "#E3C697",
  major_casing_early: "#E3C697",
  major_casing_late: "#E3C697",
  highway_casing_early: "#E0B878",
  highway_casing_late: "#E0B878",
  minor_a: "#FFFDF7",
  minor_b: "#FFFDF7",
  minor_service: "#FFFDF7",
  other: "#FFFDF7",
  link: "#FFFFFF",
  major: "#FFFFFF",
  highway: "#FFD68A",
  boundaries: "#C9B89A",
  roads_label_minor: "#8C7B63",
  roads_label_minor_halo: "#FFFDF7",
  roads_label_major: "#7A6A55",
  roads_label_major_halo: "#FFFFFF",
  ocean_label: "#3D8EA0",
  city_label: "#6B5B47",
  city_label_halo: "#F7ECD8",
  subplace_label: "#8C7B63",
  subplace_label_halo: "#F7ECD8",
  state_label: "#A89880",
  state_label_halo: "#F7ECD8",
  country_label: "#A89880",
  address_label: "#A89880",
  address_label_halo: "#F7ECD8",
  regular: "Noto Sans Regular",
  bold: "Noto Sans Medium",
  italic: "Noto Sans Italic",
  pois: undefined,
};

export function mapStyle(releaseId: string): StyleSpecification {
  if (!releaseId) throw new Error("A content release is required to build the map style");
  // No sprite ships offline, so drop icon-only layers and icons on labels.
  const base = (layers("protomaps", FLAVOR, { lang: "en" }) as LayerSpecification[])
    .filter((l) => l.id !== "roads_oneway" && l.id !== "roads_shields")
    .map((l) => {
      if (l.type !== "symbol" || !l.layout?.["icon-image"]) return l;
      const { ["icon-image"]: _icon, ...layout } = l.layout;
      return { ...l, layout };
    });
  const waterIndex = base.findIndex((l) => l.id === "water");
  // An offset copy of the water under itself gives coastlines a soft sticker edge.
  const shadow: LayerSpecification = {
    id: "water-shadow",
    type: "fill",
    source: "protomaps",
    "source-layer": "water",
    paint: { "fill-color": "#7FC7D6", "fill-translate": [0, 2.5] },
  };
  const style = waterIndex >= 0 ? [...base.slice(0, waterIndex), shadow, ...base.slice(waterIndex)] : base;
  return {
    version: 8,
    glyphs: `contentglyph://${encodeURIComponent(releaseId)}/map/fonts/{fontstack}/{range}.pbf`,
    sources: {
      protomaps: {
        type: "vector",
        tiles: [`pmtiles://${encodeURIComponent(releaseId)}/{z}/{x}/{y}`],
        minzoom: 0,
        maxzoom: 14,
        bounds: ISLAND_BOUNDS,
        attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: style,
  };
}
