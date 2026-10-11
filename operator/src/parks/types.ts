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

/** GET /api/parks/<id>/remove-from-map `plan` */
export type RemovalPlan = {
  parkId: string;
  name: string;
  source: ParkSource;
  hidden: boolean;
  founder: { handle: string | null; foundedAt: string; source: string } | null;
  pendingReviews: number;
  outline: { type: "way" | "relation"; id: number; name: string | null; areaM2: number; parkId: string } | null;
  blocked: { code: string; message: string } | null;
  audited: boolean;
};

/** POST /api/parks/<id>/remove-from-map */
export type RemovalResult = {
  ok: true;
  parkId: string;
  name: string;
  revision: number | null;
  founder: { handle: string | null } | null;
  reviewsClosed: number;
  outline: NonNullable<RemovalPlan["outline"]>;
  audited: boolean;
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

// ---------------------------------------------------------------- founding reviews (#153)

export type ReviewStatus = "pending" | "approved" | "rejected" | "superseded";
export type ReviewReasonCode = "people" | "lighting" | "not_park" | "inappropriate" | "other";

/** The rejection presets and the sentence the player reads; the same as worker/founding-reviews.ts. */
export const REVIEW_REASONS: Array<{ code: ReviewReasonCode; label: string; text: string }> = [
  { code: "people", label: "People", text: "There are people in the photo." },
  { code: "lighting", label: "Too dark or blurry", text: "The photo is too dark or blurry." },
  { code: "not_park", label: "Not the park", text: "The photo doesn't show the park." },
  { code: "inappropriate", label: "Inappropriate", text: "This photo can't be used as a park cover." },
  { code: "other", label: "Other", text: "" },
];

/** The check's flags, in the words the player saw. */
export const FLAG_LABELS: Record<string, string> = {
  people: "People", lighting: "Too dark or blurry", not_park: "Not the park", inappropriate: "Inappropriate", not_photo: "Screen or edited", personal_info: "Personal details",
};

/** One row of GET /api/parks/review */
export type ReviewItem = {
  id: string;
  status: ReviewStatus;
  parkId: string;
  parkName: string;
  osm: { type: string; id: number } | null;
  handle: string | null;
  outcome: "reject" | "unsure";
  flags: string[];
  createdAt: string;
  checkedAt: string;
  decidedAt: string | null;
  reasonCode: ReviewReasonCode | null;
  reason: string | null;
  foundedParkId: string | null;
  photoSha256: string;
  hasPhoto: boolean;
};

/** GET /api/parks/review/<id> `request` */
export type ReviewDetail = ReviewItem & {
  position: { lat: number; lng: number; accuracyM: number };
  photo: { sha256: string; width: number; height: number; bytes: number | null; purgedAt: string | null };
  /** `threshold` and a `verdict` answer only on checks stored before the verdict question was dropped. */
  moderation: {
    model: string | null;
    threshold: number | null;
    flagThresholds: Record<string, number> | null;
    answers: Record<string, { choice: string; probabilities: Record<string, number> }>;
  } | null;
  geometry: MultiPolygon | null;
  park: { inParkdex: boolean; hidden: boolean; founder: { handle: string | null; foundedAt: string } | null };
  otherPending: number;
  seenAt: string | null;
};

export type ReviewList = { available: boolean; counts: Record<ReviewStatus, number>; requests: ReviewItem[] };
