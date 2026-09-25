import type { Place, PlaceCategory } from "./places";
import type { FilterSpecification } from "maplibre-gl";

export const BOUNDARY_DATA_URL = "/data/boundaries.v1.geojson";
export const BOUNDARY_INDEX_URL = "/data/boundaries-index.v1.json";

export type BoundaryProperties = {
  id: string;
  name: string;
  category: PlaceCategory;
  sourceName: string;
  sourceUrl: string;
  sourceId: string | null;
};

export type BoundaryGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;
export type BoundaryFeature = GeoJSON.Feature<BoundaryGeometry, BoundaryProperties>;
export type BoundaryCollection = GeoJSON.FeatureCollection<BoundaryGeometry, BoundaryProperties>;
export type BoundaryBounds = [[number, number], [number, number]];
export type BoundaryIndex = { version: 1; boundsById: Record<string, BoundaryBounds> };
export type BoundaryLoadState =
  | { status: "loading"; placeIds: ReadonlySet<string> }
  | { status: "ready"; placeIds: ReadonlySet<string> }
  | { status: "failed"; placeIds: ReadonlySet<string> };
export type BoundaryLoadStatus = BoundaryLoadState["status"];

const ALL_VIEWPORT_BOUNDARIES_FILTER: FilterSpecification = ["has", "id"];
const VIEWPORT_ISLAND_BOUNDARIES_FILTER: FilterSpecification = [
  "all",
  ALL_VIEWPORT_BOUNDARIES_FILTER,
  ["==", ["get", "category"], "island"],
];
const VIEWPORT_PARK_BOUNDARIES_FILTER: FilterSpecification = [
  "all",
  ALL_VIEWPORT_BOUNDARIES_FILTER,
  ["!=", ["get", "category"], "island"],
];

export function settleBoundaryLoadStatus(current: BoundaryLoadStatus, signal: "ready" | "failed"): BoundaryLoadStatus {
  return current === "loading" ? signal : current;
}

let cachedBoundaryRequest: Promise<BoundaryIndex> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundaryFeature(value: unknown): value is BoundaryFeature {
  if (!isRecord(value) || value.type !== "Feature" || !isRecord(value.geometry) || !isRecord(value.properties)) return false;
  const geometryType = value.geometry.type;
  return (
    (geometryType === "Polygon" || geometryType === "MultiPolygon") &&
    Array.isArray(value.geometry.coordinates) &&
    typeof value.properties.id === "string" &&
    typeof value.properties.name === "string" &&
    typeof value.properties.category === "string"
  );
}

export function parseBoundaryCollection(value: unknown): BoundaryCollection {
  if (!isRecord(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new Error("Boundary data is not a GeoJSON FeatureCollection");
  }
  if (!value.features.every(isBoundaryFeature)) {
    throw new Error("Boundary data contains an unsupported feature");
  }
  return value as unknown as BoundaryCollection;
}

export function parseBoundaryIndex(value: unknown): BoundaryIndex {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.boundsById)) {
    throw new Error("Boundary index has an unsupported format");
  }
  for (const bounds of Object.values(value.boundsById)) {
    if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds.every((corner) => Array.isArray(corner) && corner.length === 2 && corner.every(Number.isFinite))) {
      throw new Error("Boundary index contains invalid bounds");
    }
  }
  return value as BoundaryIndex;
}

export function loadBoundaryIndex(): Promise<BoundaryIndex> {
  if (!cachedBoundaryRequest) {
    cachedBoundaryRequest = fetch(BOUNDARY_INDEX_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Boundary index returned ${response.status}`);
        return parseBoundaryIndex(await response.json());
      })
      .catch((error) => {
        cachedBoundaryRequest = null;
        throw error;
      });
  }
  return cachedBoundaryRequest;
}

export function boundaryPlaceIds(index: BoundaryIndex): ReadonlySet<string> {
  return new Set(Object.keys(index.boundsById));
}

export function boundaryFeatureStateUpdates(
  boundaryIds: ReadonlySet<string>,
  visitedIds: ReadonlySet<string>,
  selectedIds: ReadonlySet<string>,
): Array<{ id: string; state: { visited: boolean; selected: boolean } }> {
  return [...boundaryIds].map((id) => ({
    id,
    state: { visited: visitedIds.has(id), selected: selectedIds.has(id) },
  }));
}

export function boundaryFilter(
  _visibleIds: readonly string[],
  category: "island" | "park" | "all" = "all",
): FilterSpecification {
  if (category === "island") return VIEWPORT_ISLAND_BOUNDARIES_FILTER;
  if (category === "park") return VIEWPORT_PARK_BOUNDARIES_FILTER;
  return ALL_VIEWPORT_BOUNDARIES_FILTER;
}

export function selectedBoundaryFilter(_selectedId: string | null, _visibleIds: readonly string[]): FilterSpecification {
  // Selection is a feature-state paint effect. Keep every viewport feature
  // eligible for the selected layers so these filters remain constant.
  void _selectedId;
  void _visibleIds;
  return ALL_VIEWPORT_BOUNDARIES_FILTER;
}

function visitPositions(value: unknown, visit: (longitude: number, latitude: number) => void) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    visit(value[0], value[1]);
    return;
  }
  value.forEach((child) => visitPositions(child, visit));
}

export function geometryBounds(geometry: BoundaryGeometry): BoundaryBounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  visitPositions(geometry.coordinates, (longitude, latitude) => {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  });
  return Number.isFinite(west) ? [[west, south], [east, north]] : null;
}

export function boundsForPlace(index: BoundaryIndex, placeId: string): BoundaryBounds | null {
  return index.boundsById[placeId] ?? null;
}

export function pickBoundaryPlace(
  features: readonly { properties: unknown; geometry?: unknown }[],
  places: readonly Place[],
  click: { lng: number; lat: number },
): string | null {
  const byId = new Map(places.map((place) => [place.id, place]));
  const candidates = features
    .flatMap((feature) => {
      if (!isRecord(feature.properties) || typeof feature.properties.id !== "string") return [];
      const place = byId.get(feature.properties.id);
      const rawCategory = feature.properties.category;
      const category = place?.category ?? (rawCategory === "national" || rawCategory === "provincial" || rawCategory === "regional" || rawCategory === "island"
        ? rawCategory
        : null);
      let longitude = place?.longitude;
      let latitude = place?.latitude;
      const geometry = feature.geometry;
      if ((longitude == null || latitude == null)
        && isRecord(geometry)
        && (geometry.type === "Polygon" || geometry.type === "MultiPolygon")
        && Array.isArray(geometry.coordinates)) {
        const bounds = geometryBounds(geometry as unknown as BoundaryGeometry);
        if (bounds) {
          longitude = (bounds[0][0] + bounds[1][0]) / 2;
          latitude = (bounds[0][1] + bounds[1][1]) / 2;
        }
      }
      if (!category || longitude == null || latitude == null) return [];
      return [{ id: feature.properties.id, category, longitude, latitude }];
    });
  const parks = candidates.filter((candidate) => candidate.category !== "island");
  const pool = parks.length ? parks : candidates;
  pool.sort((a, b) => {
    const aDistance = (a.longitude - click.lng) ** 2 + (a.latitude - click.lat) ** 2;
    const bDistance = (b.longitude - click.lng) ** 2 + (b.latitude - click.lat) ** 2;
    return aDistance - bDistance;
  });
  return pool[0]?.id ?? null;
}
