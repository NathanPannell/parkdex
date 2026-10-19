export type ParkCategory = "national" | "provincial" | "regional" | "municipal" | "community";
export type ParkBiome = "coast" | "forest" | "mountain" | "lake" | "waterfall" | "river" | "cave" | "marsh" | "heritage";
export type ParkShape = "circle" | "hex" | "shield" | "arch" | "seal";
export type ParkRarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export interface ParkSnapshot {
  id: string;
  name: string;
  short: string;
  category: ParkCategory;
  region: string;
  lat: number;
  lng: number;
  biome: ParkBiome;
  shape: ParkShape;
  rarity: ParkRarity;
  seed: number;
  blurb: string;
  scene: string | null;
}

export interface ClaimPayload {
  claimId: string;
  parkId: string;
  claimedAt: string;
  parkSnapshot: ParkSnapshot;
  contentReleaseId: string | null;
}

export interface ClaimRecord extends ClaimPayload {
  createdAt: string;
  syncRevision: string;
  payloadHash: string;
  photo: PhotoView;
}

export type PhotoContentType = "image/jpeg" | "image/png" | "image/webp";

export interface PhotoMetadata {
  status: "pending" | "ready";
  contentType: PhotoContentType;
  sizeBytes: number;
  sha256: string;
  objectKey: string;
  createdAt: string;
}

export type PhotoView = { status: "missing" } | { status: "pending" } | { status: "ready"; sha256: string; sizeBytes: number; contentType: PhotoContentType };

/** A 3:4 crop normalised 0–1 to the upright photo (src/lib/photoCrop.ts). */
export interface PhotoCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A photo claim's display choices (#174), backed up beside the immutable claim. */
export interface ClaimDisplay {
  crop: PhotoCrop | null;
  /** When the player made this photo their park's cover; the latest per park wins. */
  coverAt: string | null;
  removed: boolean;
}

export interface ClaimDisplayRecord extends ClaimDisplay {
  claimId: string;
  updatedAt: string;
}

export interface AccountAuthContext {
  accountId: string;
  sessionId: string;
  transport: "bearer" | "cookie";
}

export interface ProgressEnv {
  DATABASE_URL?: string;
  KIP_PHOTO_SERVICE_URL?: string;
  KIP_PHOTO_SERVICE_TOKEN?: string;
}

export function photoObjectKey(accountId: string, claimId: string): string {
  return `accounts/${accountId.toLowerCase()}/claims/${claimId.toLowerCase()}`;
}
