import { HttpError } from "../../../worker/validation.js";

export type Position = [number, number];
export type MultiPolygon = { type: "MultiPolygon"; coordinates: Position[][][] };

function isPosition(value: unknown): value is Position {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function validRing(ring: unknown): ring is Position[] {
  if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isPosition)) return false;
  const first = ring[0], last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/** Polygon becomes a one-part MultiPolygon. Order, rings and positions are kept exactly. */
export function normalizeGeometry(geometry: unknown, label: string): MultiPolygon {
  const value = geometry as { type?: unknown; coordinates?: unknown };
  const polygons = value?.type === "Polygon" ? [value.coordinates] : value?.type === "MultiPolygon" ? value.coordinates : null;
  if (!Array.isArray(polygons) || polygons.length === 0 || !polygons.every((polygon) => Array.isArray(polygon) && polygon.length > 0 && polygon.every(validRing))) {
    throw new HttpError(422, "invalid_geometry", `${label} has a missing or malformed boundary.`);
  }
  return { type: "MultiPolygon", coordinates: polygons as Position[][][] };
}
