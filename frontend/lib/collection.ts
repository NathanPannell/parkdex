import { matchesPlaceSearch, type Place } from "@/lib/places";

export type VisitFilter = "all" | "visited" | "unseen";

export function authorityForPlace(place: Place): string {
  if (place.category === "national") return "Parks Canada";
  if (place.category === "provincial") return "BC Parks";
  if (place.category === "island") return "Major islands";
  if (place.sourceName.includes("Capital Regional District")) return "Capital Regional District (CRD)";
  if (place.sourceName.includes("Nanaimo")) return "Regional District of Nanaimo (RDN)";
  if (place.sourceName.includes("Cowichan Valley")) return "Cowichan Valley Regional District (CVRD)";
  if (place.sourceName.includes("Mount Waddington")) return "Regional District of Mount Waddington (RDMW)";
  return place.sourceName;
}

export function collectionFilter(
  places: Place[],
  search: string,
  categories: ReadonlySet<Place["category"]>,
  authorities: ReadonlySet<string>,
  visitFilter: VisitFilter,
  visited: ReadonlySet<string>,
): Place[] {
  return places.filter((place) => {
    if (categories.size && !categories.has(place.category)) return false;
    if (authorities.size && !authorities.has(authorityForPlace(place))) return false;
    if (visitFilter === "visited" && !visited.has(place.id)) return false;
    if (visitFilter === "unseen" && visited.has(place.id)) return false;
    return matchesPlaceSearch(place, search, authorityForPlace(place));
  });
}

export function groupByAuthority(places: Place[]): Array<{ authority: string; places: Place[] }> {
  const groups = new Map<string, Place[]>();
  for (const place of places) {
    const authority = authorityForPlace(place);
    groups.set(authority, [...(groups.get(authority) ?? []), place]);
  }
  return [...groups].map(([authority, members]) => ({
    authority,
    places: members.sort((a, b) => a.name.localeCompare(b.name)),
  })).sort((a, b) => a.authority.localeCompare(b.authority));
}
