import type { FilterSpecification } from "maplibre-gl";

import { boundaryFilter, selectedBoundaryFilter, type BoundaryCollection, type BoundaryFeature, type BoundaryIndex } from "./boundaries";
import { explorationBoundaryFilter, explorationVisitedFilter } from "./exploration-map-style";
import placeAreaCatalogue from "./place-areas.catalogue.json";
import type { Place } from "./places";
import type { Visit } from "./account";

export type MapViewport = {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
};

export type BoundaryViewport = Pick<MapViewport, "west" | "south" | "east" | "north">;

/** Normalize MapLibre bounds for APIs that accept one wrapped longitude range. */
export function normalizeMapViewport(viewport: MapViewport): MapViewport {
  const longitudeSpan = viewport.east - viewport.west;
  const coversWorld = longitudeSpan >= 360;
  const wrapLongitude = (longitude: number) => {
    const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
    return wrapped === -180 && longitude > 0 ? 180 : wrapped;
  };
  const clampLatitude = (latitude: number) => Math.max(-90, Math.min(90, latitude));

  return {
    west: coversWorld ? -180 : wrapLongitude(viewport.west),
    south: clampLatitude(viewport.south),
    east: coversWorld ? 180 : wrapLongitude(viewport.east),
    north: clampLatitude(viewport.north),
    zoom: viewport.zoom,
  };
}

export type ParkMapMode = "explored" | "discover";

export type RecentPostcard = {
  place: Place;
  visit: Visit;
};

export type PlaceMarkerProperties = {
  id: string;
  name: string;
  category: Place["category"];
  visited: 0 | 1;
  groupSelected: 0 | 1;
};

export type PlaceNameProperties = {
  id: string;
  name: string;
  category: Place["category"];
  areaKm2: number;
  labelPriority: number;
};

export type PlaceMarkerData = GeoJSON.FeatureCollection<GeoJSON.Point, PlaceMarkerProperties>;
export type PlaceNameData = GeoJSON.FeatureCollection<GeoJSON.Point, PlaceNameProperties>;

export type MapPresentationInput = {
  places: readonly Place[];
  visited: ReadonlySet<string>;
  mode: ParkMapMode;
  selectedId: string | null;
  selectedIds: ReadonlySet<string>;
  viewport: MapViewport | null;
  boundaryIndex: BoundaryIndex | null;
  boundaryAsset: BoundaryCollection | null;
  selectedBoundary?: BoundaryFeature | null;
};

export type MapPresentation = {
  placeData: PlaceMarkerData;
  boundaryData: BoundaryCollection;
  boundaryIds: ReadonlySet<string>;
  boundaryFilter: FilterSpecification;
  islandBoundaryFilter: FilterSpecification;
  parkBoundaryFilter: FilterSpecification;
  selectedBoundaryFilter: FilterSpecification;
  explorationFilter: FilterSpecification;
  explorationEdgeFilter: FilterSpecification;
  placeNameData: PlaceNameData;
};

const EMPTY_BOUNDARIES: BoundaryCollection = { type: "FeatureCollection", features: [] };
const PLACE_AREAS = placeAreaCatalogue as Record<string, number>;
const boundaryIdsByCollection = new WeakMap<BoundaryCollection, ReadonlySet<string>>();

function boundaryIdsFor(collection: BoundaryCollection): ReadonlySet<string> {
  const cached = boundaryIdsByCollection.get(collection);
  if (cached) return cached;
  const ids = new Set(collection.features.map((feature) => feature.properties.id));
  boundaryIdsByCollection.set(collection, ids);
  return ids;
}

/** Keep every place point in the data set. Explore/discover only changes the progress overlay. */
export function visiblePlaces<T extends readonly Place[]>(places: T, _visited: ReadonlySet<string>, _mode: ParkMapMode): T {
  void _visited;
  void _mode;
  return places;
}

export function placeMarkerData(
  places: readonly Place[],
  visited: ReadonlySet<string>,
  selectedIds: ReadonlySet<string>,
): PlaceMarkerData {
  return {
    type: "FeatureCollection",
    features: places.map((place) => ({
      type: "Feature",
      id: place.id,
      geometry: { type: "Point", coordinates: [place.longitude, place.latitude] },
      properties: {
        id: place.id,
        name: place.name,
        category: place.category,
        visited: visited.has(place.id) ? 1 : 0,
        groupSelected: selectedIds.has(place.id) ? 1 : 0,
      },
    })),
  };
}

function pointInViewport(longitude: number, latitude: number, viewport: MapViewport): boolean {
  const inLongitude = viewport.west <= viewport.east
    ? longitude >= viewport.west && longitude <= viewport.east
    : longitude >= viewport.west || longitude <= viewport.east;
  return inLongitude && latitude >= viewport.south && latitude <= viewport.north;
}

export function boundsIntersectViewport(bounds: BoundaryIndex["boundsById"][string], viewport: BoundaryViewport): boolean {
  const [[west, south], [east, north]] = bounds;
  if (north < viewport.south || south > viewport.north) return false;
  if (viewport.west <= viewport.east) return east >= viewport.west && west <= viewport.east;
  return east >= viewport.west || west <= viewport.east;
}

function placeLabelPriority(place: Place, areaKm2: number): number {
  const categoryRank: Record<Place["category"], number> = {
    national: 0,
    island: 1,
    provincial: 2,
    regional: 3,
  };
  return categoryRank[place.category] * 1_000_000 - Math.min(areaKm2, 999_999);
}

/**
 * Offer every sampled place name to MapLibre. The renderer places names that
 * fit around other map labels and leaves the corresponding dot visible when a
 * name collides.
 */
export function placeNameData(
  places: readonly Place[],
  viewport: MapViewport | null,
): PlaceNameData {
  const candidates = places
    .filter((place) => !viewport || pointInViewport(place.longitude, place.latitude, viewport))
    .map((place) => {
      const areaKm2 = PLACE_AREAS[place.id] ?? 0;
      return { place, areaKm2, labelPriority: placeLabelPriority(place, areaKm2) };
    })
    .sort((left, right) => left.labelPriority - right.labelPriority || left.place.name.localeCompare(right.place.name));

  return {
    type: "FeatureCollection",
    features: candidates.map(({ place, areaKm2, labelPriority }) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [place.longitude, place.latitude] },
      properties: { id: place.id, name: place.name, category: place.category, areaKm2, labelPriority },
    })),
  };
}

export function mapPresentation(input: MapPresentationInput): MapPresentation {
  const visible = visiblePlaces(input.places, input.visited, input.mode);

  // The API has already selected every polygon in its buffered viewport. Keep
  // the complete returned set independent from marker, visit, search, and
  // group filters. MapLibre clips geometry naturally at the current frame.
  let boundaryData = input.boundaryAsset ?? EMPTY_BOUNDARIES;
  let includedIds = boundaryIdsFor(boundaryData);
  const selectedBoundaryId = input.selectedBoundary?.properties.id;
  const selectedBoundaryIsActive = selectedBoundaryId != null
    && (input.selectedId === selectedBoundaryId || input.selectedIds.has(selectedBoundaryId));
  if (input.selectedBoundary && selectedBoundaryIsActive && !includedIds.has(input.selectedBoundary.properties.id)) {
    boundaryData = { type: "FeatureCollection", features: [...boundaryData.features, input.selectedBoundary] };
    includedIds = boundaryIdsFor(boundaryData);
  }
  const progressIds = input.mode === "explored" ? [...input.visited] : [];

  return {
    placeData: placeMarkerData(visible, input.visited, input.selectedIds),
    boundaryData,
    boundaryIds: includedIds,
    boundaryFilter: boundaryFilter([]),
    islandBoundaryFilter: boundaryFilter([], "island"),
    parkBoundaryFilter: boundaryFilter([], "park"),
    selectedBoundaryFilter: selectedBoundaryFilter(null, []),
    explorationFilter: explorationVisitedFilter(progressIds),
    explorationEdgeFilter: explorationBoundaryFilter(progressIds),
    placeNameData: placeNameData(visible, input.viewport),
  };
}
