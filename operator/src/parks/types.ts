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

/** GET /api/parks/<id> */
export type LiveParkDetail = LivePark & { geometry: MultiPolygon | null };
