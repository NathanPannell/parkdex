import type { Place } from "@/lib/places";

export type Coordinates = { latitude: number; longitude: number };
export type NearbyPlace = { place: Place; distanceKm: number };
export type ExplorerMapMode = "explored" | "discover";

export function modeForSelection(current: ExplorerMapMode, visited: ReadonlySet<string>, placeId: string): ExplorerMapMode {
  return visited.has(placeId) ? current : "discover";
}

export function distanceKm(from: Coordinates, to: Coordinates): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const firstLatitude = radians(from.latitude);
  const secondLatitude = radians(to.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function nearestUnseenParks(
  places: Place[],
  visited: ReadonlySet<string>,
  location: Coordinates,
  limit = 4,
): NearbyPlace[] {
  return places
    .filter((place) => place.category !== "island" && !visited.has(place.id))
    .map((place) => ({ place, distanceKm: distanceKm(location, place) }))
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, limit);
}

export function formatDistance(distance: number): string {
  return distance < 10 ? `${distance.toFixed(1)} km` : `${Math.round(distance)} km`;
}
