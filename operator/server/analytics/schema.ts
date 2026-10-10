import type { SqlRunner } from "../drafts.js";

/**
 * Schemas the analytics pages read that a database may not have yet. Production can run a
 * release behind staging (founders_001 reached staging before main), so every query that
 * touches one of these checks for it first and the page shows "Not in this database yet"
 * instead of failing. Add an entry here when the analytics pages start reading a table from a
 * newer migration.
 */
export const OPTIONAL_FEATURES = {
  founders: {
    migration: "founders_001_init.sql",
    note: "founders not deployed",
    checks: [
      "to_regclass('kip_founders.parks') IS NOT NULL",
      "to_regclass('kip_founders.photo_checks') IS NOT NULL",
      "to_regprocedure('kip_founders.founder_points(uuid, timestamp with time zone)') IS NOT NULL",
    ],
  },
} as const;

export type Feature = keyof typeof OPTIONAL_FEATURES;
export type Features = Record<Feature, boolean>;

export const ALL_FEATURES: Features = { founders: true };

/** The notes for whatever is missing, for example ["founders not deployed"]. */
export function unavailableNotes(features: Features): string[] {
  return (Object.keys(OPTIONAL_FEATURES) as Feature[]).filter((feature) => !features[feature]).map((feature) => OPTIONAL_FEATURES[feature].note);
}

const FEATURE_NAMES = Object.keys(OPTIONAL_FEATURES) as Feature[];
export const FEATURE_PROBE = `SELECT ${FEATURE_NAMES.map((feature) => `(${OPTIONAL_FEATURES[feature].checks.join(" AND ")}) AS ${feature}`).join(", ")}`;

/** Remembered per database for a minute, so a migration shows up soon without a probe on every query. */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; features: Features }>();

export async function probeFeatures(db: SqlRunner, cacheKey: string | null, now = Date.now()): Promise<Features> {
  const cached = cacheKey ? cache.get(cacheKey) : undefined;
  if (cached && now - cached.at < CACHE_MS) return cached.features;
  const row = (await db.query(FEATURE_PROBE))[0] ?? {};
  const features = Object.fromEntries(FEATURE_NAMES.map((feature) => [feature, row[feature] === true || row[feature] === "t"])) as Features;
  if (cacheKey) {
    if (cache.size > 16) cache.clear();
    cache.set(cacheKey, { at: now, features });
  }
  return features;
}

/** For tests that change a database's schema between runs. */
export function clearFeatureCache(): void {
  cache.clear();
}
