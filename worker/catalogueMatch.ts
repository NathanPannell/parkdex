import { distanceToMultiPolygon, interiorPoint, multiPolygonArea, pointInMultiPolygon, type MultiPolygon, type OsmFeature } from "./osmParks.js";

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
/** A catalogue park with the same name counts as the same place only within this distance. */
const NAME_MATCH_M = 1_500;
/** A catalogue park inside the outline is the same place when it covers at least this share of it. */
const SAME_PLACE_SHARE = 0.25;

/** The id the publish path gives an OpenStreetMap park (kept in step with parkPublish.osmParkId). */
function publishedId(feature: { type: string; id: number }): string {
  return `osm-${feature.type}-${feature.id}`;
}

export function nameKey(name: string | null): string {
  if (!name) return "";
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/).filter((word) => word && !GENERIC_WORDS.has(word)).join(" ");
}

function sameName(a: string | null, b: string | null): boolean {
  const left = nameKey(a), right = nameKey(b);
  if (!left || !right) return false;
  return left === right || (left.length >= 5 && right.includes(left)) || (right.length >= 5 && left.includes(right));
}

/**
 * The catalogue park this outline already is, if any: the same OSM id published before, an
 * outline that sits inside a catalogue park, a catalogue park that covers a good part of the
 * outline, or the same name close by.
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
    if (sameName(feature.name, park.name) && distanceToMultiPolygon([park.lng, park.lat], feature.geometry) <= NAME_MATCH_M) return { parkId: park.id, name: park.name };
  }
  return null;
}
