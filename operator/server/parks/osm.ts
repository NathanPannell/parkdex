import { catalogueMatch, type CataloguePark, type CatalogueMatch } from "../../../worker/catalogueMatch.js";
import { interiorPoint, simplifyMultiPolygon, type OsmFeature, type OsmRef } from "../../../worker/osmParks.js";
import { createSqlOsmParkTable } from "../../../worker/osmParkTable.js";
import { biomeFor, categoryFor, contentBoundary, osmParkId, seedFor, type PublishablePark } from "../../../worker/parkPublish.js";
import { provinceFor } from "../../../worker/provinces.js";
import { HttpError } from "../../../worker/validation.js";
import { publishStatements, SHAPE_FOR_CATEGORY, shortName, type SqlRunner } from "../drafts.js";
import type { MultiPolygon } from "./geometry.js";
import { grow, type Bbox } from "./manager.js";

/**
 * OpenStreetMap outlines from kip_osm.parks on the park map, and "Create from OSM", which
 * publishes an outline that is not in Parkdex through the same draft and publish transaction
 * park founding uses (operator/server/drafts.ts publishStatements).
 */

export interface CatalogueNeighbour extends CataloguePark {
  region: string;
}

export interface OsmOutline {
  type: "way" | "relation";
  id: number;
  name: string | null;
  kind: string;
  areaM2: number;
  geometry: MultiPolygon;
  /** The Parkdex park this outline already is, by worker/catalogueMatch. */
  inParkdex: CatalogueMatch | null;
}

export interface OsmStore {
  /** Outlines whose box overlaps the view, smallest first, at most `limit`. */
  inBox(bbox: Bbox, limit: number): Promise<OsmFeature[]>;
  feature(ref: OsmRef): Promise<OsmFeature | null>;
  /** Catalogue parks (hidden ones too) with their pin in the box, for matching and the region. */
  catalogue(bbox: Bbox): Promise<CatalogueNeighbour[]>;
  /** Writes the draft and publishes it in one transaction; returns the content revision. */
  publish(park: PublishablePark, at: string): Promise<number | null>;
}

/** Outlines per map request; dense towns have a few hundred in view. */
export const OSM_LIMIT = 400;
/** Region and catalogue lookups reach this far around an outline. */
const NEIGHBOUR_KM = 30;
const KM_PER_DEG_LAT = 110.54;

function kmBox(bbox: Bbox, km: number): Bbox {
  const lat = (bbox.north + bbox.south) / 2;
  const dLat = km / KM_PER_DEG_LAT,
    dLng = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  return { west: bbox.west - dLng, south: bbox.south - dLat, east: bbox.east + dLng, north: bbox.north + dLat };
}

export function featureBbox(geometry: MultiPolygon): Bbox {
  let west = Infinity,
    south = Infinity,
    east = -Infinity,
    north = -Infinity;
  for (const polygon of geometry.coordinates)
    for (const ring of polygon)
      for (const [lng, lat] of ring) {
        west = Math.min(west, lng);
        east = Math.max(east, lng);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
  return { west, south, east, north };
}

/** About one screen pixel at the view's width, so a city view does not ship 5 m detail for big reserves. */
function toleranceFor(bbox: Bbox): number {
  const widthM = (bbox.east - bbox.west) * 111_320 * Math.cos((((bbox.north + bbox.south) / 2) * Math.PI) / 180);
  return Math.max(0, Math.min(200, widthM / 2000));
}

export function matchOutlines(features: OsmFeature[], catalogue: CataloguePark[], view?: Bbox): OsmOutline[] {
  const tolerance = view ? toleranceFor(view) : 0;
  return features.map((feature) => ({
    type: feature.type,
    id: feature.id,
    name: feature.name,
    kind: feature.kind,
    areaM2: feature.areaM2,
    geometry: tolerance > 1 ? simplifyMultiPolygon(feature.geometry, tolerance) : feature.geometry,
    inParkdex: catalogueMatch(feature, catalogue),
  }));
}

function distanceKm(a: [number, number], b: [number, number]): number {
  const dx = (a[0] - b[0]) * 111.32 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180),
    dy = (a[1] - b[1]) * KM_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** The region of the nearest catalogue park in the same province within 30 km, else the province, like a published proposal gets. */
export function regionNear(point: [number, number], catalogue: CatalogueNeighbour[]): string {
  const province = provinceFor(point);
  let best: { region: string; km: number } | null = null;
  for (const park of catalogue) {
    if (!park.region.trim() || provinceFor([park.lng, park.lat]) !== province) continue;
    const km = distanceKm(point, [park.lng, park.lat]);
    if (km <= NEIGHBOUR_KM && (!best || km < best.km)) best = { region: park.region, km };
  }
  return best?.region ?? province;
}

function defaultBlurb(feature: OsmFeature): string {
  if (feature.tags.leisure === "nature_reserve") return "A nature reserve.";
  if (feature.tags.leisure === "garden") return "A public garden.";
  if (feature.tags.leisure === "dog_park") return "An off-leash dog park.";
  if (feature.tags.boundary) return "A protected area.";
  return "A local park.";
}

/** What the create form starts from: the outline's name, a category guess, the region nearby and the outline itself. */
export function osmDraft(feature: OsmFeature, catalogue: CatalogueNeighbour[]): PublishablePark {
  const id = osmParkId(feature);
  const name = (feature.name ?? "").trim().slice(0, 140);
  const category = categoryFor({ name, tags: feature.tags });
  const marker = interiorPoint(feature.geometry);
  return {
    id,
    name,
    short: name ? shortName(name).slice(0, 140) : "",
    category,
    region: regionNear(marker, catalogue),
    lat: Math.round(marker[1] * 1e6) / 1e6,
    lng: Math.round(marker[0] * 1e6) / 1e6,
    biome: biomeFor(feature, name),
    shape: SHAPE_FOR_CATEGORY[category] ?? "circle",
    rarity: "common",
    seed: seedFor(id),
    blurb: defaultBlurb(feature),
    // Thinned like a published proposal, so one park cannot push the content snapshot over its limit.
    geometry: contentBoundary(feature.geometry),
    source: {
      operator: { action: "create_from_osm" },
      osm: { type: feature.type, id: feature.id, name: feature.name, kind: feature.kind, tags: feature.tags, areaM2: feature.areaM2 },
    },
  };
}

/** Catalogue parks around an outline, wide enough to find the region and any park that already covers it. */
export function neighbourhood(feature: OsmFeature): Bbox {
  return kmBox(featureBbox(feature.geometry), NEIGHBOUR_KM);
}

export function parseOsmRef(value: string): OsmRef | null {
  const match = /^(way|relation)-([1-9][0-9]{0,15})$/.exec(value);
  if (!match) return null;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? { type: match[1] as OsmRef["type"], id } : null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * The draft row and the publish transaction, as park founding writes them: the draft's
 * updated_at is the timestamp publishStatements checks, so nothing can change in between. A
 * draft left over from an unpublished proposal is taken over; a published one blocks.
 */
export async function createStatements(park: PublishablePark, at: string) {
  const sourceSha256 = await sha256Hex(JSON.stringify(park.source));
  return [
    {
      text: `INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb, updated_at)
        VALUES ($1, $2::jsonb, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz)
        ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, source_sha256 = EXCLUDED.source_sha256, geometry = EXCLUDED.geometry,
          name = EXCLUDED.name, short = EXCLUDED.short, category = EXCLUDED.category, region = EXCLUDED.region, lat = EXCLUDED.lat,
          lng = EXCLUDED.lng, biome = EXCLUDED.biome, shape = EXCLUDED.shape, rarity = EXCLUDED.rarity, seed = EXCLUDED.seed,
          blurb = EXCLUDED.blurb, updated_at = EXCLUDED.updated_at
        WHERE kip_park_drafts.drafts.status = 'draft'`,
      params: [
        park.id,
        JSON.stringify(park.source),
        sourceSha256,
        JSON.stringify(park.geometry),
        park.name,
        park.short,
        park.category,
        park.region,
        park.lat,
        park.lng,
        park.biome,
        park.shape,
        park.rarity,
        park.seed,
        park.blurb,
        at,
      ],
    },
    ...publishStatements(park.id, at, null),
  ];
}

export function publishError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  if (/park_exists/.test(message)) return new HttpError(409, "already_in_parkdex", "This outline is already a Parkdex park.");
  if (/draft_changed|draft_missing/.test(message)) {
    return new HttpError(409, "osm_blocked", "An earlier publication of this outline left a draft behind, so it cannot be created again here.");
  }
  if (/draft_incomplete/.test(message)) return new HttpError(422, "draft_incomplete", "The park needs a name, a short name, a category and an outline.");
  const code = (error as { code?: unknown })?.code;
  return new HttpError(422, "save_failed", `Publishing was rolled back by a content check${typeof code === "string" ? ` (${code})` : ""}.`);
}

export function createSqlOsmStore(db: SqlRunner): OsmStore {
  const table = createSqlOsmParkTable(db);
  return {
    async inBox(bbox, limit) {
      const rows = await db.query(
        `SELECT osm_type, osm_id, name, kind, tags, area_m2, geometry FROM kip_osm.parks
         WHERE min_lat <= $2 AND max_lat >= $1 AND min_lng <= $4 AND max_lng >= $3
         ORDER BY area_m2, osm_type, osm_id LIMIT ${Math.max(1, Math.min(OSM_LIMIT, Math.floor(limit)))}`,
        [bbox.south, bbox.north, bbox.west, bbox.east],
      );
      return rows.flatMap((row) => {
        const geometry = (typeof row.geometry === "string" ? JSON.parse(row.geometry) : row.geometry) as MultiPolygon;
        const tags = (typeof row.tags === "string" ? JSON.parse(row.tags) : (row.tags ?? {})) as Record<string, string>;
        const type = row.osm_type,
          id = Number(row.osm_id);
        if ((type !== "way" && type !== "relation") || !geometry?.coordinates?.length) return [];
        return [
          {
            type,
            id,
            name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : null,
            kind: String(row.kind),
            tags,
            geometry,
            areaM2: Math.round(Number(row.area_m2) || 0),
          },
        ];
      });
    },
    feature: (ref) => table.get(ref),
    async catalogue(bbox) {
      const rows = await db.query(
        `SELECT p.id, p.name, p.region, p.lat, p.lng, b.feature->'geometry' AS geometry
         FROM public.parks p LEFT JOIN public.boundaries b ON b.park_id = p.id
         WHERE p.lat BETWEEN $1 AND $2 AND p.lng BETWEEN $3 AND $4`,
        [bbox.south, bbox.north, bbox.west, bbox.east],
      );
      return rows.map((row) => {
        const geometry = (typeof row.geometry === "string" ? JSON.parse(row.geometry) : row.geometry) as MultiPolygon | null;
        return {
          id: String(row.id),
          name: String(row.name),
          region: String(row.region),
          lat: Number(row.lat),
          lng: Number(row.lng),
          boundary: geometry?.type === "MultiPolygon" && geometry.coordinates?.length ? geometry : null,
        };
      });
    },
    async publish(park, at) {
      try {
        const results = await db.transaction(await createStatements(park, at));
        const revision = results[results.length - 1]?.[0]?.published_revision;
        return revision === undefined || revision === null ? null : Number(revision);
      } catch (error) {
        throw publishError(error);
      }
    },
  };
}

/** The catalogue around the view: the view itself, grown so big parks just outside still match. */
export function catalogueBox(view: Bbox): Bbox {
  return kmBox(grow(view, 0.25), 3);
}
