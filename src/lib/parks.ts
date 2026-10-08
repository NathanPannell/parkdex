export type Biome = "coast" | "forest" | "mountain" | "lake" | "waterfall" | "river" | "cave" | "marsh" | "heritage";
export type Shape = "circle" | "hex" | "shield" | "arch" | "seal";
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export type ParkCategory = "national" | "provincial" | "regional" | "municipal" | "community";

export type Park = {
  id: string;
  name: string;
  short: string;
  category: ParkCategory;
  region: string;
  lat: number;
  lng: number;
  biome: Biome;
  shape: Shape;
  rarity: Rarity;
  seed: number;
  blurb: string;
  // Badge art for live badges; null means "badge coming soon".
  scene: string | null;
  // Directions target such as a trailhead or parking lot. Without it,
  // directions go to the lat/lng pin.
  googleMapsUrl?: string | null;
  // End of the in-app approach line. Without it, the line ends at the boundary.
  trailheadLat?: number | null;
  trailheadLng?: number | null;
};

// Per-park badge art and descriptions are retired for the flag game. The
// catalogue keeps scene and blurb and the CDN keeps the images, so turning this
// back on needs no content change.
export const SHOW_BADGE_ART = false;

// Without per-park art every park is a full park; with it, a park without art
// was "coming soon".
export const isLive = (park: Pick<Park, "scene">) => !SHOW_BADGE_ART || park.scene !== null;
export const scenePath = (scene: string) => `art/badges/scenes/${scene}.webp`;
// Kept as a path helper for callers that also have to resolve the active release URL.
export const sceneUrl = (scene: string) => `/${scenePath(scene)}`;

// The map shows every live park, plus any park already in the Dex.
export function mapParks<T extends Pick<Park, "id" | "scene">>(parks: readonly T[], claimed: Readonly<Record<string, unknown>>): T[] {
  return parks.filter((park) => isLive(park) || Object.hasOwn(claimed, park.id));
}

// Keep earned retired badges in the visitor's lifetime collection denominator.
export function badgeTotal(liveParks: readonly Pick<Park, "id">[], claimedParkIds: Iterable<string>) {
  return new Set([...liveParks.map((park) => park.id), ...claimedParkIds]).size;
}

export type Palette = {
  skyTop: string;
  skyBottom: string;
  sun: string;
  far: string;
  mid: string;
  near: string;
  water: string;
  accent: string;
  ribbon: string;
  ribbonText: string;
};

// These are presentation tokens, not park content, so they remain in the app bundle.
export const PALETTES: Record<Biome, Palette> = {
  coast: { skyTop: "#FFB38A", skyBottom: "#FFE3B3", sun: "#FFF4D6", far: "#7FB8D8", mid: "#3E97B8", near: "#F4CF8E", water: "#27A9C4", accent: "#FF5A1F", ribbon: "#0E6E86", ribbonText: "#FFF8EC" },
  forest: { skyTop: "#A6E6C3", skyBottom: "#E7F8D8", sun: "#FFD45C", far: "#6CC08F", mid: "#2F9E6B", near: "#1C5B43", water: "#6FD1C4", accent: "#FFC93C", ribbon: "#1C5B43", ribbonText: "#FFF8EC" },
  mountain: { skyTop: "#9CCBFF", skyBottom: "#E6F2FF", sun: "#FFE6A8", far: "#9EA9F0", mid: "#6474DB", near: "#39479F", water: "#7FD3F7", accent: "#FF7AA2", ribbon: "#39479F", ribbonText: "#FFF8EC" },
  lake: { skyTop: "#FFD08A", skyBottom: "#FFF1C9", sun: "#FF8A3D", far: "#8ACB8E", mid: "#4DAF6B", near: "#2C7F57", water: "#39B5E0", accent: "#FF5A1F", ribbon: "#1F7FA8", ribbonText: "#FFF8EC" },
  waterfall: { skyTop: "#B9F0E0", skyBottom: "#ECFFF7", sun: "#FFF2B3", far: "#9B8CE6", mid: "#7461D1", near: "#4B3C9E", water: "#DDF8FF", accent: "#5CE1FF", ribbon: "#4B3C9E", ribbonText: "#FFF8EC" },
  river: { skyTop: "#FFE39A", skyBottom: "#FFF7DC", sun: "#FFB547", far: "#A6D98A", mid: "#6BBF5E", near: "#3F8F48", water: "#35B1D6", accent: "#FF6B3D", ribbon: "#2E7F9E", ribbonText: "#FFF8EC" },
  cave: { skyTop: "#2B2350", skyBottom: "#4F3F92", sun: "#FFE27A", far: "#6D5BD0", mid: "#8B7BE6", near: "#2A1F57", water: "#5CE1FF", accent: "#FFD84D", ribbon: "#2A1F57", ribbonText: "#FFE27A" },
  marsh: { skyTop: "#FFC8D8", skyBottom: "#FFF0F4", sun: "#FFF3C4", far: "#A8D8A0", mid: "#72B865", near: "#3E8A4A", water: "#8FD8CB", accent: "#FF7A59", ribbon: "#3E8A4A", ribbonText: "#FFF8EC" },
  heritage: { skyTop: "#FFC89A", skyBottom: "#FFEBD1", sun: "#FFF1D6", far: "#E0A37A", mid: "#C9774C", near: "#8C4A2F", water: "#7ACBD6", accent: "#FFF1D6", ribbon: "#8C4A2F", ribbonText: "#FFF1D6" },
};

export const RARITY: Record<Rarity, { label: string; color: string; ink: string; stars: number }> = {
  common: { label: "Common", color: "#DDEFE3", ink: "#1C5B43", stars: 1 },
  uncommon: { label: "Uncommon", color: "#CDEFFF", ink: "#0E6E86", stars: 2 },
  rare: { label: "Rare", color: "#DCD5FF", ink: "#4B3C9E", stars: 3 },
  epic: { label: "Epic", color: "#FFD3E6", ink: "#A3245C", stars: 4 },
  legendary: { label: "Legendary", color: "#FFE9A8", ink: "#8A5A00", stars: 5 },
};

export const BIOME_LABEL: Record<Biome, string> = {
  coast: "Coastline",
  forest: "Forest",
  mountain: "Summit",
  lake: "Lake",
  waterfall: "Waterfall",
  river: "River",
  cave: "Cave",
  marsh: "Wetland",
  heritage: "Heritage",
};

export type Landscape = Biome | "legendary";

// The landscape follows the badge art when a park has it.
export function landscapeOf(park: Park): Landscape {
  const kind = park.scene?.split("-")[0];
  if (kind === "legendary") return "legendary";
  return kind && kind in BIOME_LABEL ? (kind as Biome) : park.biome;
}

export function landscapeLabel(park: Park) {
  const kind = landscapeOf(park);
  return kind === "legendary" ? "Legendary vista" : BIOME_LABEL[kind];
}

// Light card tints with a readable ink; the badge palettes are too dark for some biomes (cave).
export const LANDSCAPE_TINT: Record<Landscape, { bg: string; ink: string }> = {
  coast: { bg: "#DDF1F7", ink: "#0E6E86" },
  forest: { bg: "#DFF3E4", ink: "#1C5B43" },
  mountain: { bg: "#E3E8FF", ink: "#39479F" },
  lake: { bg: "#DCEFFA", ink: "#1F7FA8" },
  waterfall: { bg: "#E6E1FA", ink: "#4B3C9E" },
  river: { bg: "#E4F3DC", ink: "#3F8F48" },
  cave: { bg: "#E4DFF5", ink: "#2A1F57" },
  marsh: { bg: "#EAF0D8", ink: "#5B7A2E" },
  heritage: { bg: "#F8E6D6", ink: "#8C4A2F" },
  legendary: { bg: "#FFE9A8", ink: "#8A5A00" },
};

export const CATEGORY_LABEL: Record<ParkCategory, string> = {
  national: "National Park",
  provincial: "Provincial Park",
  regional: "Regional Park",
  municipal: "Municipal Park",
  community: "Community Park",
};

// Small deterministic PRNG so every park's badge art is stable across renders.
export function rng(seed: number) {
  let s = seed * 9301 + 49297;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}
