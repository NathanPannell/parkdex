export type Position = [number, number];
export type MultiPolygon = { type: "MultiPolygon"; coordinates: Position[][][] };

export type LivePark = {
  id: string;
  name: string;
  short: string;
  category: string;
  region: string;
  lat: number;
  lng: number;
  biome: string;
  shape: string;
  rarity: string;
  scene: string | null;
  seed: number;
  blurb: string;
};

/** GET /api/parks/<id> `park` */
export type LiveParkDetail = LivePark & { geometry: MultiPolygon | null };

export type ParkSource = "curated" | "legacy" | "founded" | "proposal";
export type HiddenState = { reason: string; source: "category" | "operator"; hiddenAt: string };

/** One row of GET /api/parks */
export type ParkRow = {
  id: string;
  name: string;
  short: string;
  category: string;
  region: string;
  lat: number;
  lng: number;
  biome: string;
  rarity: string;
  source: ParkSource;
  hidden: HiddenState | null;
  founder: { handle: string | null; foundedAt: string; photoSha256: string } | null;
  visits: number;
};

/** GET /api/parks/stats */
export type ParkStats = { live: number; hidden: number; founded: number; osmOutlines: number; osmNotInParkdex: number; osmSourceDate: string | null };

export type ChangeRow = { revision: number; at: string; entity: "park" | "boundary" | "drive" | "asset"; operation: "upsert" | "delete"; value: Record<string, unknown> | null };

/** GET /api/parks/<id> `activity` */
export type ParkActivity = {
  source: ParkSource;
  hidden: HiddenState | null;
  founder: { handle: string | null; foundedAt: string; source: string; photoSha256: string; photoWidth: number; photoHeight: number; photoBytes: number } | null;
  visits: { total: number; last30Days: number; uniquePlayers: number };
  flag: { handle: string | null; since: string; lastVisitAt: string; fallsAt: string; up: boolean } | null;
  tenures: number;
  history: ChangeRow[];
};

/** GET /api/parks/outlines */
export type ParkOutline = { id: string; category: string; hidden: boolean; geometry: MultiPolygon };

/** GET /api/parks/osm */
export type OsmOutline = {
  type: "way" | "relation";
  id: number;
  name: string | null;
  kind: string;
  areaM2: number;
  geometry: MultiPolygon;
  inParkdex: { parkId: string; name: string } | null;
};

/** GET /api/parks/osm/<type>-<id> `draft` */
export type OsmDraft = Omit<LivePark, "scene"> & { geometry: MultiPolygon };

export const CATEGORIES = ["national", "provincial", "regional", "municipal", "community"] as const;
export const BIOMES = ["coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"] as const;
export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
/** Mirrors the server: the badge shape follows the category. */
export const SHAPE_FOR_CATEGORY: Record<string, string> = { community: "circle", municipal: "circle", regional: "hex", provincial: "shield", national: "seal" };

/** Map colours per category, the same hues as the list's category dots. */
export const CATEGORY_COLORS: Record<string, string> = {
  national: "#ff5c8a",
  provincial: "#2f9e6b",
  regional: "#22b3c5",
  municipal: "#e9b21f",
  community: "#7b61ff",
};

export const SOURCE_LABELS: Record<ParkSource, string> = {
  curated: "Curated",
  legacy: "Legacy import",
  founded: "OpenStreetMap (osm-*)",
  proposal: "Player proposal",
};

export function title(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export function osmKey(outline: { type: string; id: number }): string {
  return `${outline.type}-${outline.id}`;
}
