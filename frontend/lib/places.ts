export type PlaceCategory = "national" | "provincial" | "regional" | "island";

export type Place = {
  id: string;
  name: string;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  region: string;
  description: string;
  sourceUrl: string;
  sourceName: string;
  sourceId?: string | null;
};

export const categoryLabels: Record<PlaceCategory, string> = {
  national: "National",
  provincial: "Provincial",
  regional: "Regional",
  island: "Major islands",
};

export function filterPlaces(
  places: Place[],
  search: string,
  categories: Set<PlaceCategory>,
): Place[] {
  const needle = search.trim().toLocaleLowerCase();
  return places.filter((place) => {
    const inCategory = categories.size === 0 || categories.has(place.category);
    const inSearch =
      !needle ||
      `${place.name} ${place.region} ${place.description}`.toLocaleLowerCase().includes(needle);
    return inCategory && inSearch;
  });
}

export function createCollectionKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
