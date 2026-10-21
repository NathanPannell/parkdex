import type { SqlClient } from "./db.js";

/**
 * Hidden parks (content_005_park_visibility.sql) keep their rows, so a lookup in
 * public.parks still finds them. Ask here before treating a park as live: for
 * new flag game visits, or to flag an OpenStreetMap candidate that matches one.
 */
export const HIDDEN_PARKS_SQL = "SELECT park_id, reason, source FROM public.content_park_hidden WHERE park_id = ANY($1::text[])";

export type HiddenPark = { parkId: string; reason: string; source: "category" | "operator" };

// The local stack does not install the content migrations; no table means nothing is hidden.
function missingTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "42P01";
}

export async function hiddenParks(sql: SqlClient, parkIds: readonly string[]): Promise<Map<string, HiddenPark>> {
  if (!parkIds.length) return new Map();
  try {
    const rows = (await sql.query(HIDDEN_PARKS_SQL, [[...new Set(parkIds)]])) as Array<Record<string, unknown>>;
    return new Map(
      rows.map((row) => [
        String(row.park_id),
        {
          parkId: String(row.park_id),
          reason: String(row.reason),
          source: row.source === "operator" ? "operator" : "category",
        },
      ]),
    );
  } catch (error) {
    if (missingTable(error)) return new Map();
    throw error;
  }
}

export async function isParkHidden(sql: SqlClient, parkId: string): Promise<boolean> {
  return (await hiddenParks(sql, [parkId])).has(parkId);
}
