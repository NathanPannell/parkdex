import { distanceToMultiPolygon, interiorPoint, pointInMultiPolygon, type MultiPolygon, type Position } from "./osmParks.js";
import { HttpError } from "./validation.js";

/**
 * "Be there" checks for founding a park. The device reports a position and its accuracy; the
 * position counts as inside when it is in the outline or within the accuracy of its edge,
 * between MIN_TOLERANCE_M and MAX_TOLERANCE_M (the app's visit tolerance, src/lib/boundaries.ts).
 */

export const MIN_TOLERANCE_M = 10;
export const MAX_TOLERANCE_M = 35;
/** A fix worse than this cannot tell which park someone is in. */
export const MAX_ACCURACY_M = 100;

export interface DevicePosition {
  lat: number;
  lng: number;
  accuracyM: number;
}

export function toleranceFor(accuracyM: number): number {
  return Math.min(Math.max(accuracyM, MIN_TOLERANCE_M), MAX_TOLERANCE_M);
}

export const IMPRECISE_MESSAGE = "Your location is not precise enough. Step outside, wait a moment and try again.";

/** Validates `{lat, lng, accuracyM}` (exact keys) and refuses imprecise fixes. */
export function validatePosition(value: unknown): DevicePosition {
  const input = value as Record<string, unknown> | null;
  const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : null;
  if (!keys || keys.length !== 3 || !["lat", "lng", "accuracyM"].every((key) => keys.includes(key))) {
    throw new HttpError(400, "invalid_position", "Send your position as lat, lng and accuracyM.");
  }
  const { lat, lng, accuracyM } = input as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lng !== "number" || typeof accuracyM !== "number" ||
      !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracyM) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180 || accuracyM < 0) {
    throw new HttpError(400, "invalid_position", "Send your position as lat, lng and accuracyM.");
  }
  if (accuracyM > MAX_ACCURACY_M) throw new HttpError(422, "location_imprecise", IMPRECISE_MESSAGE);
  return { lat, lng, accuracyM };
}

export interface InsideResult {
  inside: boolean;
  /** Metres outside the outline edge, 0 when inside it. */
  distanceM: number;
}

export function positionInside(position: Pick<DevicePosition, "lat" | "lng" | "accuracyM">, outline: MultiPolygon): InsideResult {
  const point: Position = [position.lng, position.lat];
  const distanceM = distanceToMultiPolygon(point, outline);
  return { inside: distanceM <= toleranceFor(position.accuracyM), distanceM };
}

/**
 * Where to put a newly founded park's marker: a point inside the part of the outline the
 * founder is in (or nearest to). Never the device position, so a park is not published at
 * exactly the spot where a person stood.
 */
export function markerPoint(outline: MultiPolygon, position: Pick<DevicePosition, "lat" | "lng">): Position {
  const point: Position = [position.lng, position.lat];
  let best = outline.coordinates[0];
  let bestDistance = Infinity;
  for (const polygon of outline.coordinates) {
    const part: MultiPolygon = { type: "MultiPolygon", coordinates: [polygon] };
    const distance = pointInMultiPolygon(point, part) ? 0 : distanceToMultiPolygon(point, part);
    if (distance < bestDistance) {
      best = polygon;
      bestDistance = distance;
    }
  }
  const [lng, lat] = interiorPoint({ type: "MultiPolygon", coordinates: [best] });
  return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}
