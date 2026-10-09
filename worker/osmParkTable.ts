import type { MultiPolygon, OsmFeature, OsmRef } from "./osmParks.js";

/**
 * Our own copy of OpenStreetMap park outlines (kip_osm.parks, loaded by
 * scripts/osm_park_index.py). The table narrows by bounding box; the caller does the exact
 * containment and distance test on the outlines it returns.
 */
export interface OsmParkTable {
  /** Outlines whose bounding box comes within `radiusM` of the pin, smallest first. */
  near(lat: number, lng: number, radiusM: number): Promise<OsmFeature[]>;
  get(ref: OsmRef): Promise<OsmFeature | null>;
}

interface QueryRunner {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

const M_PER_DEG_LAT = 110_540;
// Dense towns have a few hundred outlines within a kilometre; this keeps a query bounded.
const MAX_ROWS = 400;
const COLUMNS = "osm_type, osm_id, name, kind, tags, area_m2, geometry";

function featureFrom(row: Record<string, unknown>): OsmFeature | null {
  const type = row.osm_type, id = Number(row.osm_id);
  const geometry = row.geometry as MultiPolygon | null;
  if ((type !== "way" && type !== "relation") || !Number.isSafeInteger(id) || id <= 0) return null;
  if (!geometry || geometry.type !== "MultiPolygon" || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length) return null;
  const tags = row.tags && typeof row.tags === "object" ? row.tags as Record<string, string> : {};
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 140) : null;
  return { type, id, name, kind: String(row.kind), tags, geometry, areaM2: Math.round(Number(row.area_m2) || 0) };
}

export function createSqlOsmParkTable(db: QueryRunner): OsmParkTable {
  return {
    async near(lat, lng, radiusM) {
      const dLat = radiusM / M_PER_DEG_LAT, dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM kip_osm.parks
         WHERE min_lat <= $2 AND max_lat >= $1 AND min_lng <= $4 AND max_lng >= $3
         ORDER BY area_m2 LIMIT ${MAX_ROWS}`,
        [lat - dLat, lat + dLat, lng - dLng, lng + dLng],
      );
      return rows.map(featureFrom).filter((feature): feature is OsmFeature => feature !== null);
    },
    async get(ref) {
      const rows = await db.query(`SELECT ${COLUMNS} FROM kip_osm.parks WHERE osm_type = $1 AND osm_id = $2`, [ref.type, ref.id]);
      return rows[0] ? featureFrom(rows[0]) : null;
    },
  };
}
