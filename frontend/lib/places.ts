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

export const normalizePlaceSearch = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
export function matchesPlaceSearch(place: Place, query: string, extra = ""): boolean {
  return normalizePlaceSearch(`${place.name} ${place.region} ${place.description} ${extra}`).includes(normalizePlaceSearch(query.trim()));
}

export function filterPlaces(
  places: Place[],
  search: string,
  categories: Set<PlaceCategory>,
): Place[] {
  return places.filter((place) => {
    const inCategory = categories.size === 0 || categories.has(place.category);
    const inSearch = matchesPlaceSearch(place, search);
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
