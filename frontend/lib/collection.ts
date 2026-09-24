import { matchesPlaceSearch, type Place } from "@/lib/places";

export type VisitFilter = "all" | "visited" | "unseen";

const SOUTHERN_VANCOUVER_ISLAND = "Southern Vancouver Island";
const NORTHERN_VANCOUVER_ISLAND = "Northern Vancouver Island";

// These are collection headings, not place metadata. Keep each place's original
// region available for search, place details, and existing badge progress.
const islandListRegions: Readonly<Record<string, string>> = {
  "Capital Region": SOUTHERN_VANCOUVER_ISLAND,
  "Cowichan Valley": SOUTHERN_VANCOUVER_ISLAND,
  "South Island": SOUTHERN_VANCOUVER_ISLAND,
  "Gulf Islands": SOUTHERN_VANCOUVER_ISLAND,
  "West Coast": SOUTHERN_VANCOUVER_ISLAND,
  "West Coast Islands": SOUTHERN_VANCOUVER_ISLAND,
  "North Island": NORTHERN_VANCOUVER_ISLAND,
  "Discovery Islands": NORTHERN_VANCOUVER_ISLAND,
  "Northern Gulf Islands": NORTHERN_VANCOUVER_ISLAND,
  "Northern Islands": NORTHERN_VANCOUVER_ISLAND,
};

const listRegionOrder = [
  SOUTHERN_VANCOUVER_ISLAND,
  NORTHERN_VANCOUVER_ISLAND,
  "South Coast",
  "Thompson & Okanagan",
  "Kootenays",
  "Cariboo & Central Interior",
  "Central Coast",
  "North Coast & Haida Gwaii",
  "Nechako",
  "Northeast",
];

export function listRegionForPlace(place: Place): string {
  if (place.region === "Central Island") {
    // The existing Central Island region spans Nanaimo/Parksville and Comox.
    return place.latitude >= 49.5 ? NORTHERN_VANCOUVER_ISLAND : SOUTHERN_VANCOUVER_ISLAND;
  }
  return islandListRegions[place.region] ?? place.region;
}

export function authorityForPlace(place: Place): string {
  if (place.category === "national") return "Parks Canada";
  if (place.category === "provincial") return "BC Parks";
  if (place.category === "island") return "Major islands";
  if (place.sourceName.includes("Capital Regional District")) return "Capital Regional District (CRD)";
  if (place.sourceName.includes("Nanaimo")) return "Regional District of Nanaimo (RDN)";
  if (place.sourceName.includes("Cowichan Valley")) return "Cowichan Valley Regional District (CVRD)";
  if (place.sourceName.includes("Mount Waddington")) return "Regional District of Mount Waddington (RDMW)";
  const greenspaceAuthority = place.sourceName.match(/^(.+?)\s+(?:via|—)\s+BC Local and Regional Greenspaces\b/i)?.[1]?.trim();
  if (greenspaceAuthority) return greenspaceAuthority;
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
    return matchesPlaceSearch(place, search, `${authorityForPlace(place)} ${listRegionForPlace(place)}`);
  });
}

export function groupByRegion(places: Place[]): Array<{ region: string; places: Place[] }> {
  const groups = new Map<string, Place[]>();
  for (const place of places) {
    const region = listRegionForPlace(place);
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region)!.push(place);
  }
  return [...groups].map(([region, members]) => ({
    region,
    places: members.sort((a, b) => a.name.localeCompare(b.name)),
  })).sort((a, b) => {
    const aOrder = listRegionOrder.indexOf(a.region);
    const bOrder = listRegionOrder.indexOf(b.region);
    if (aOrder !== bOrder) return (aOrder < 0 ? listRegionOrder.length : aOrder) - (bOrder < 0 ? listRegionOrder.length : bOrder);
    return a.region.localeCompare(b.region);
  });
}
