import { distanceToMultiPolygon, interiorPoint, multiPolygonArea, pointInMultiPolygon, type MultiPolygon, type OsmFeature, type Position } from "./osmParks.js";

/**
 * Whether an OpenStreetMap park is already in the Parkdex catalogue, so the app can show it as
 * "Already on the map" and the server never publishes it a second time. Hidden parks keep their
 * row in public.parks, so they count too.
 */

export interface CataloguePark {
  id: string;
  name: string;
  lat: number;
  lng: number;
  boundary: MultiPolygon | null;
}

export interface CatalogueMatch {
  parkId: string;
  name: string;
}

/** Name matches ignore these words, so "Watershed Park" and "Watershed Regional Park" agree. */
const GENERIC_WORDS = new Set(["park", "parks", "regional", "provincial", "national", "municipal", "community", "reserve", "the", "and", "of"]);
/** A catalogue park without a boundary and with the same name counts as the same place only within this distance. */
const NAME_MATCH_M = 1_500;
/** A catalogue park inside the outline is the same place when it covers at least this share of it. */
const SAME_PLACE_SHARE = 0.25;
/** Samples per side of the grid that measures how much two shapes share. */
const OVERLAP_GRID = 32;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG_EQUATOR = 111_320;

/** The id the publish path gives an OpenStreetMap park (kept in step with parkPublish.osmParkId). */
function publishedId(feature: { type: string; id: number }): string {
  return `osm-${feature.type}-${feature.id}`;
}

export function nameKey(name: string | null): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !GENERIC_WORDS.has(word))
    .join(" ");
}

/**
 * The same name, apart from generic words and word order. A name inside a longer one is not the
 * same name: "Steveston Park" and "Steveston Town Square Park" are two parks.
 */
function sameName(a: string | null, b: string | null): boolean {
  const left = nameKey(a),
    right = nameKey(b);
  if (!left || !right) return false;
  const words = (key: string) => [...new Set(key.split(" "))].sort().join(" ");
  return left === right || words(left) === words(right);
}

function bounds(geometry: MultiPolygon): [number, number, number, number] {
  let west = Infinity,
    south = Infinity,
    east = -Infinity,
    north = -Infinity;
  for (const [outer] of geometry.coordinates) {
    for (const [lng, lat] of outer) {
      west = Math.min(west, lng);
      south = Math.min(south, lat);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
    }
  }
  return [west, south, east, north];
}

/**
 * Whether the two shapes share at least SAME_PLACE_SHARE of the smaller one's area, measured on
 * a grid over the box they share. Thin shapes drawn a little differently, such as a shoreline
 * park, count; neighbours that only touch do not.
 */
function shareArea(a: MultiPolygon, b: MultiPolygon): boolean {
  const boxA = bounds(a),
    boxB = bounds(b);
  const west = Math.max(boxA[0], boxB[0]),
    south = Math.max(boxA[1], boxB[1]),
    east = Math.min(boxA[2], boxB[2]),
    north = Math.min(boxA[3], boxB[3]);
  if (west >= east || south >= north) return false;
  const smaller = Math.min(multiPolygonArea(a), multiPolygonArea(b));
  if (smaller <= 0) return false;
  const cellM2 =
    ((east - west) * M_PER_DEG_LNG_EQUATOR * Math.cos((((south + north) / 2) * Math.PI) / 180) * (north - south) * M_PER_DEG_LAT) / OVERLAP_GRID ** 2;
  let shared = 0;
  for (let i = 0; i < OVERLAP_GRID; i += 1) {
    for (let j = 0; j < OVERLAP_GRID; j += 1) {
      const point: Position = [west + ((east - west) * (i + 0.5)) / OVERLAP_GRID, south + ((north - south) * (j + 0.5)) / OVERLAP_GRID];
      if (pointInMultiPolygon(point, a) && pointInMultiPolygon(point, b)) shared += cellM2;
    }
  }
  return shared >= smaller * SAME_PLACE_SHARE;
}

/**
 * The catalogue park this outline already is, if any: the same OSM id published before, an
 * outline that sits inside a catalogue park, or a catalogue park that covers a good part of the
 * outline. A name never overrides the shapes: a catalogue park with a boundary also matches when
 * it has the same name and shares a good part of the smaller shape with the outline, and one
 * without a boundary (a pin only) when it has the same name close by. A name inside a longer one
 * is not the same name, so "Steveston Community Park" is not "Steveston Town Square Park".
 */
export function catalogueMatch(feature: OsmFeature, parks: CataloguePark[]): CatalogueMatch | null {
  const id = publishedId(feature);
  const inside = interiorPoint(feature.geometry);
  const area = multiPolygonArea(feature.geometry);
  for (const park of parks) {
    if (park.id === id) return { parkId: park.id, name: park.name };
  }
  for (const park of parks) {
    const pin: [number, number] = [park.lng, park.lat];
    if (park.boundary && pointInMultiPolygon(inside, park.boundary)) return { parkId: park.id, name: park.name };
    const covered = park.boundary ? multiPolygonArea(park.boundary) : 0;
    const anchor = park.boundary ? interiorPoint(park.boundary) : pin;
    if (pointInMultiPolygon(anchor, feature.geometry) && (!park.boundary || covered >= area * SAME_PLACE_SHARE)) return { parkId: park.id, name: park.name };
  }
  for (const park of parks) {
    if (!sameName(feature.name, park.name)) continue;
    const same = park.boundary ? shareArea(feature.geometry, park.boundary) : distanceToMultiPolygon([park.lng, park.lat], feature.geometry) <= NAME_MATCH_M;
    if (same) return { parkId: park.id, name: park.name };
  }
  return null;
}
