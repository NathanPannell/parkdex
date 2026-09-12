import { categoryLabels, type PlaceCategory } from "./places";
import type { VisitFilter } from "./collection";

export type View = "map" | "collection" | "groups" | "badges" | "account";
export type PublicNavigation = {
  view: View;
  selectedId: string | null;
  mapMode: "explored" | "discover";
  mapSearch: string;
  mapCategories: Set<PlaceCategory>;
  collectionSearch: string;
  collectionCategories: Set<PlaceCategory>;
  collectionAuthorities: Set<string>;
  collectionVisitFilter: VisitFilter;
};

export function hasAccountCallback(url: URL): boolean {
  const fragment = new URLSearchParams(url.hash.slice(1));
  return fragment.has("resetToken") || fragment.has("verificationToken") ||
    (url.searchParams.has("state") && (url.searchParams.has("code") || url.searchParams.has("error")));
}

export function readNavigation(href: string): PublicNavigation {
  const url = new URL(href, "https://parkdex.app"), params = url.searchParams;
  const requestedView = params.get("view");
  const view: View = requestedView && ["map", "collection", "groups", "badges", "account"].includes(requestedView) ? requestedView as View : "map";
  const selectedId = params.get("place") || null;
  const categorySet = (key: string) => new Set(params.getAll(key).filter((value): value is PlaceCategory => value in categoryLabels));
  const visit = params.get("placesVisited");
  return {
    view: hasAccountCallback(url) ? "account" : selectedId ? "map" : view,
    selectedId: hasAccountCallback(url) ? null : selectedId,
    mapMode: params.get("mode") === "explored" ? "explored" : params.get("mode") === "discover" || selectedId ? "discover" : "explored",
    mapSearch: params.get("mapQuery") ?? "",
    mapCategories: categorySet("mapCategory"),
    collectionSearch: params.get("placesQuery") ?? "",
    collectionCategories: categorySet("placesCategory"),
    collectionAuthorities: new Set(params.getAll("authority")),
    collectionVisitFilter: visit === "visited" || visit === "unseen" ? visit : "all",
  };
}

const publicKeys = ["view", "place", "mode", "mapQuery", "mapCategory", "placesQuery", "placesCategory", "authority", "placesVisited"];

/** Only public catalogue navigation belongs in the address. Private group context stays in memory. */
export function navigationUrl(currentHref: string, state: PublicNavigation): string {
  const url = new URL(currentHref, "https://parkdex.app");
  publicKeys.forEach((key) => url.searchParams.delete(key));
  url.searchParams.set("view", state.selectedId ? "map" : state.view);
  if (state.selectedId) url.searchParams.set("place", state.selectedId);
  if (state.mapMode === "discover") url.searchParams.set("mode", "discover");
  else if (state.selectedId) url.searchParams.set("mode", "explored");
  if (state.mapSearch.trim()) url.searchParams.set("mapQuery", state.mapSearch);
  [...state.mapCategories].sort().forEach((value) => url.searchParams.append("mapCategory", value));
  if (state.collectionSearch) url.searchParams.set("placesQuery", state.collectionSearch);
  [...state.collectionCategories].sort().forEach((value) => url.searchParams.append("placesCategory", value));
  [...state.collectionAuthorities].sort().forEach((value) => url.searchParams.append("authority", value));
  if (state.collectionVisitFilter !== "all") url.searchParams.set("placesVisited", state.collectionVisitFilter);
  return `${url.pathname}${url.search}${url.hash}`;
}
