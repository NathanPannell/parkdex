export const PLACE_VISUALS_SCHEMA_VERSION = 1;
export const DEFAULT_PLACE_VISUALS_BASE_URL = "/park-visuals-fixture";

export type PlaceVisualEntry = {
  placeId: string;
  satellite: string;
  relief: string;
  model: string;
  attribution: string[];
  acquired: string[];
  needsReview: boolean;
  reviewFlags: string[];
};

export type PlaceVisualAssetUrls = {
  satellite: string;
  relief: string;
  model: string;
};

const placeVisualIndexCache = new Map<string, Promise<ReadonlyMap<string, PlaceVisualEntry>>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafePlaceVisualId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 256
    && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2000);
}

function parseEntry(placeId: string, value: unknown): PlaceVisualEntry | null {
  if (!isSafePlaceVisualId(placeId) || !isRecord(value)) return null;
  const expected = {
    satellite: `${placeId}/satellite.avif`,
    relief: `${placeId}/relief.avif`,
    model: `${placeId}/${placeId}-terrain.glb`,
  };
  if (value.satellite !== expected.satellite || value.relief !== expected.relief || value.model !== expected.model) return null;
  if (!isTextList(value.attribution) || !isTextList(value.acquired)
    || typeof value.needsReview !== "boolean"
    || (value.reviewFlags !== null && !isTextList(value.reviewFlags))) return null;
  return {
    placeId,
    ...expected,
    attribution: value.attribution,
    acquired: value.acquired,
    needsReview: value.needsReview,
    reviewFlags: value.reviewFlags ?? [],
  };
}

export function parsePlaceVisualIndex(value: unknown): ReadonlyMap<string, PlaceVisualEntry> {
  if (!isRecord(value) || value.version !== PLACE_VISUALS_SCHEMA_VERSION || !isRecord(value.places)) {
    throw new Error("The place visuals index has an unsupported format.");
  }
  const entries = new Map<string, PlaceVisualEntry>();
  for (const [placeId, rawEntry] of Object.entries(value.places)) {
    const entry = parseEntry(placeId, rawEntry);
    if (entry) entries.set(placeId, entry);
  }
  return entries;
}

export function placeVisualIndexUrl(
  baseUrl = process.env.NEXT_PUBLIC_PARK_VISUALS_BASE_URL || DEFAULT_PLACE_VISUALS_BASE_URL,
  origin = typeof window === "undefined" ? "https://web.parkdex.app" : window.location.origin,
): string {
  const base = baseUrl.trim();
  if (!base || base.includes("?") || base.includes("#")) {
    throw new Error("The place visuals base URL is invalid.");
  }
  const root = new URL(`${base.replace(/\/+$/, "")}/`, origin);
  if (root.protocol !== "http:" && root.protocol !== "https:") {
    throw new Error("The place visuals base URL must use HTTP or HTTPS.");
  }
  return new URL("index.json", root).href;
}

export async function loadPlaceVisualIndex(
  baseUrl = process.env.NEXT_PUBLIC_PARK_VISUALS_BASE_URL || DEFAULT_PLACE_VISUALS_BASE_URL,
  fetcher: typeof fetch = fetch,
): Promise<ReadonlyMap<string, PlaceVisualEntry>> {
  const url = placeVisualIndexUrl(baseUrl);
  const cached = placeVisualIndexCache.get(url);
  if (cached) return cached;

  const request = fetcher(url, { cache: "force-cache" }).then(async (response) => {
    if (!response.ok) throw new Error(`The place visuals index returned ${response.status}.`);
    return parsePlaceVisualIndex(await response.json() as unknown);
  });
  placeVisualIndexCache.set(url, request);
  try {
    return await request;
  } catch (error) {
    if (placeVisualIndexCache.get(url) === request) placeVisualIndexCache.delete(url);
    throw error;
  }
}

export function placeVisualAssetUrls(
  entry: PlaceVisualEntry,
  baseUrl = process.env.NEXT_PUBLIC_PARK_VISUALS_BASE_URL || DEFAULT_PLACE_VISUALS_BASE_URL,
  origin = typeof window === "undefined" ? "https://web.parkdex.app" : window.location.origin,
): PlaceVisualAssetUrls {
  const validEntry = parseEntry(entry.placeId, entry);
  if (!validEntry) throw new Error("The place visuals entry is invalid.");
  const root = new URL(".", placeVisualIndexUrl(baseUrl, origin));
  const resolve = (path: string) => new URL(path.split("/").map(encodeURIComponent).join("/"), root).href;
  return {
    satellite: resolve(validEntry.satellite),
    relief: resolve(validEntry.relief),
    model: resolve(validEntry.model),
  };
}

export function clearPlaceVisualIndexCache(): void {
  placeVisualIndexCache.clear();
}
