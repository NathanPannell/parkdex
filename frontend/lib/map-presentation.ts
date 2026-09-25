import type { FilterSpecification } from "maplibre-gl";

import { boundaryFilter, boundaryPlaceIds, selectedBoundaryFilter, type BoundaryCollection, type BoundaryFeature, type BoundaryIndex } from "./boundaries";
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
  areaKm2: number;
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
export const PARK_NAME_LABEL_MIN_ZOOM = 9;
export const PARK_NAME_LABEL_EXPANSION_LIMIT = 5;

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

function boundsIntersectViewport(bounds: BoundaryIndex["boundsById"][string], viewport: MapViewport): boolean {
  const [[west, south], [east, north]] = bounds;
  if (north < viewport.south || south > viewport.north) return false;
  if (viewport.west <= viewport.east) return east >= viewport.west && west <= viewport.east;
  return east >= viewport.west || west <= viewport.east;
}

function visibleParkPlaces(places: readonly Place[], viewport: MapViewport | null, index: BoundaryIndex | null): Place[] {
  if (!viewport) return [];
  return places.filter((place) => {
    if (place.category === "island") return false;
    const bounds = index?.boundsById[place.id];
    return pointInViewport(place.longitude, place.latitude, viewport)
      && (!bounds || boundsIntersectViewport(bounds, viewport));
  });
}

/**
 * Provide one high-priority park label at every zoom. At close zoom, expand to
 * nearby names when five or fewer park boundaries are in the viewport. MapLibre
 * handles text collision placement, keeping labels legible and clickable.
 */
export function placeNameData(
  places: readonly Place[],
  viewport: MapViewport | null,
  boundaryIndex: BoundaryIndex | null,
): PlaceNameData {
  const visible = visibleParkPlaces(places, viewport, boundaryIndex)
    .map((place) => ({ place, areaKm2: PLACE_AREAS[place.id] ?? 0 }))
    .sort((left, right) => right.areaKm2 - left.areaKm2 || left.place.name.localeCompare(right.place.name));
  const labels = viewport && viewport.zoom >= PARK_NAME_LABEL_MIN_ZOOM && visible.length <= PARK_NAME_LABEL_EXPANSION_LIMIT
    ? visible
    : visible.slice(0, 1);

  return {
    type: "FeatureCollection",
    features: labels.map(({ place, areaKm2 }) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [place.longitude, place.latitude] },
      properties: { id: place.id, name: place.name, areaKm2 },
    })),
  };
}

export function mapPresentation(input: MapPresentationInput): MapPresentation {
  const visible = visiblePlaces(input.places, input.visited, input.mode);
  const selected = new Set(input.selectedIds);
  if (input.selectedId) selected.add(input.selectedId);

  const availableIds = input.boundaryIndex ? boundaryPlaceIds(input.boundaryIndex) : new Set<string>();
  const boundaryIds = new Set<string>();
  visible.forEach((place) => {
    const bounds = input.boundaryIndex?.boundsById[place.id];
    if (selected.has(place.id) || (input.viewport && (bounds
      ? boundsIntersectViewport(bounds, input.viewport)
      : pointInViewport(place.longitude, place.latitude, input.viewport)))) {
      boundaryIds.add(place.id);
    }
  });

  const visibleBoundaryFeatures = input.boundaryAsset?.features.filter((feature) => boundaryIds.has(feature.properties.id)) ?? [];
  if (input.selectedBoundary && selected.has(input.selectedBoundary.properties.id)) {
    const selectedIndex = visibleBoundaryFeatures.findIndex((feature) => feature.properties.id === input.selectedBoundary?.properties.id);
    if (selectedIndex >= 0) visibleBoundaryFeatures[selectedIndex] = input.selectedBoundary;
    else visibleBoundaryFeatures.push(input.selectedBoundary);
  }
  const boundaryData = visibleBoundaryFeatures.length
    ? { type: "FeatureCollection" as const, features: visibleBoundaryFeatures }
    : EMPTY_BOUNDARIES;
  const includedIds = input.boundaryIndex
    ? new Set([...boundaryIds].filter((id) => availableIds.has(id)))
    : new Set(boundaryIds);
  const ids = [...includedIds];
  const selectedIds = [...selected].filter((id) => includedIds.has(id));
  const progressIds = input.mode === "explored" ? [...input.visited] : [];

  return {
    placeData: placeMarkerData(visible, input.visited, input.selectedIds),
    boundaryData,
    boundaryIds: includedIds,
    boundaryFilter: boundaryFilter(ids),
    islandBoundaryFilter: boundaryFilter(ids, "island"),
    parkBoundaryFilter: boundaryFilter(ids, "park"),
    selectedBoundaryFilter: selectedIds.length
      ? ["in", ["get", "id"], ["literal", selectedIds]] as FilterSpecification
      : selectedBoundaryFilter(input.selectedId, ids),
    explorationFilter: explorationVisitedFilter(progressIds),
    explorationEdgeFilter: explorationBoundaryFilter(progressIds),
    placeNameData: placeNameData(visible, input.viewport, input.boundaryIndex),
  };
}
