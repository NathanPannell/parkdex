import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryDataUrl = new URL("../../data/", import.meta.url);
const packagedDataUrl = new URL("../catalogue-build-data/", import.meta.url);
const canonicalBoundaryUrl = new URL("boundaries.geojson", repositoryDataUrl);
const stagingBoundaryUrl = new URL("staging-field-boundaries.geojson", repositoryDataUrl);

export const CATALOGUE_SCOPE_ENV = "PARKDEX_CATALOGUE_SCOPE";
export const CATALOGUE_DATA_ROOT_ENV = "PARKDEX_CATALOGUE_DATA_ROOT";
export const CANONICAL_CATALOGUE_SCOPE = "canonical";
export const STAGING_CATALOGUE_SCOPE = "staging";
export const CATALOGUE_SOURCE_ENV = Object.freeze({
  canonicalBoundary: "PARKDEX_CANONICAL_BOUNDARY_SOURCE",
});

/**
 * Scope is deliberately fail-closed. Only the explicit staging value can
 * change the shipped catalogue; production, preview, local, and unknown
 * values all use the reviewed canonical asset.
 */
export function resolveCatalogueScope(value = process.env[CATALOGUE_SCOPE_ENV]) {
  return value?.trim().toLowerCase() === STAGING_CATALOGUE_SCOPE
    ? STAGING_CATALOGUE_SCOPE
    : CANONICAL_CATALOGUE_SCOPE;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function normalizeCollection(value, sourceName) {
  if (isRecord(value) && value.type === "Feature") {
    return { type: "FeatureCollection", features: [value] };
  }
  if (!isRecord(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new Error(`${sourceName} must be a GeoJSON FeatureCollection`);
  }
  return value;
}

function featureId(feature, sourceName) {
  const id = feature?.properties?.id;
  if (typeof id !== "string" || !id.trim()) throw new Error(`${sourceName} contains a feature without a non-empty properties.id`);
  return id;
}

function assertUniqueIds(features, sourceName) {
  const ids = new Set();
  for (const feature of features) {
    const id = featureId(feature, sourceName);
    if (ids.has(id)) throw new Error(`${sourceName} contains duplicate boundary id ${id}`);
    ids.add(id);
  }
  return ids;
}

/**
 * Additive staging boundary merge. A staging boundary may not replace a
 * canonical feature with the same id; that would make a staging build look
 * like a canonical build while silently changing reviewed geometry.
 */
export function mergeBoundaryCollections(canonicalValue, stagingValue) {
  const canonical = normalizeCollection(canonicalValue, "Canonical boundary data");
  const staging = normalizeCollection(stagingValue, "Staging boundary data");
  const canonicalIds = assertUniqueIds(canonical.features, "Canonical boundary data");
  const stagingIds = assertUniqueIds(staging.features, "Staging boundary data");
  for (const id of stagingIds) {
    if (canonicalIds.has(id)) throw new Error(`Staging boundary id ${id} already exists in canonical boundary data`);
  }
  return {
    ...canonical,
    features: [...canonical.features, ...staging.features].sort((left, right) => (
      featureId(left, "Boundary data").localeCompare(featureId(right, "Boundary data"))
    )),
  };
}

export function normalizeBoundaryText(value) {
  return value.replace(/\r\n/g, "\n");
}

export function boundarySourceDescription(scope = resolveCatalogueScope()) {
  return scope === STAGING_CATALOGUE_SCOPE
    ? "data/boundaries.geojson + data/staging-field-boundaries.geojson"
    : "data/boundaries.geojson";
}

/**
 * Vercel receives `frontend/` as its deployment root, while local, Android,
 * and Cloudflare builds can read the repository-level data directory. The
 * release workflow packages the same reviewed inputs under frontend before a
 * staging Vercel upload. Never fall back to a generated public asset: staging
 * generation temporarily rewrites those files during the build.
 */
export async function readCatalogueSource(name, environment = process.env) {
  const configuredPath = environment[CATALOGUE_SOURCE_ENV.canonicalBoundary];
  if (name === "boundaries.geojson" && configuredPath?.trim()) {
    const configuredUrl = configuredPath.trim().startsWith("file:")
      ? new URL(configuredPath.trim())
      : pathToFileURL(resolve(configuredPath.trim()));
    return readFile(configuredUrl, "utf8");
  }
  let lastError;
  const configuredRoot = environment[CATALOGUE_DATA_ROOT_ENV]?.trim();
  const bases = configuredRoot
    ? [pathToFileURL(`${resolve(configuredRoot)}${sep}`)]
    : [repositoryDataUrl, packagedDataUrl];
  for (const base of bases) {
    try {
      return await readFile(new URL(name, base), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      lastError = error;
    }
  }
  const error = new Error(`Catalogue build source ${name} is unavailable`, { cause: lastError });
  if (lastError?.code) error.code = lastError.code;
  throw error;
}

export async function readScopedBoundaryCollection(scope = resolveCatalogueScope(), environment = process.env) {
  const canonicalText = await readCatalogueSource("boundaries.geojson", environment);
  const canonical = normalizeCollection(JSON.parse(canonicalText), "Canonical boundary data");
  if (scope !== STAGING_CATALOGUE_SCOPE) {
    assertUniqueIds(canonical.features, "Canonical boundary data");
    return {
      scope: CANONICAL_CATALOGUE_SCOPE,
      collection: canonical,
      canonicalText,
      stagingText: null,
      inputText: normalizeBoundaryText(canonicalText),
      stagingIds: new Set(),
    };
  }

  let stagingText;
  try {
    stagingText = await readCatalogueSource("staging-field-boundaries.geojson", environment);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("PARKDEX_CATALOGUE_SCOPE=staging requires data/staging-field-boundaries.geojson");
    }
    throw error;
  }
  const staging = normalizeCollection(JSON.parse(stagingText), "Staging boundary data");
  const collection = mergeBoundaryCollections(canonical, staging);
  const stagingIds = new Set(staging.features.map((feature) => featureId(feature, "Staging boundary data")));
  return {
    scope: STAGING_CATALOGUE_SCOPE,
    collection,
    canonicalText,
    stagingText,
    inputText: `${normalizeBoundaryText(canonicalText).trimEnd()}\n${normalizeBoundaryText(stagingText).trimStart()}`,
    stagingIds,
  };
}

export { canonicalBoundaryUrl, stagingBoundaryUrl };
