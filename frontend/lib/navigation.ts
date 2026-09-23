import parkRoutes from "./park-routes.json";
import { categoryLabels, type PlaceCategory } from "./places";
import type { VisitFilter } from "./collection";

export type View = "map" | "collection" | "groups" | "badges" | "account";
export type PublicNavigation = {
  view: View;
  selectedId: string | null;
  detailExpanded: boolean;
  settingsOpen: boolean;
  mapMode: "explored" | "discover";
  mapSearch: string;
  mapCategories: Set<PlaceCategory>;
  collectionSearch: string;
  collectionCategories: Set<PlaceCategory>;
  collectionAuthorities: Set<string>;
  collectionVisitFilter: VisitFilter;
};

const routeById = new Map(parkRoutes.map(({ id, slug }) => [id, slug]));
const idByRoute = new Map(parkRoutes.map(({ id, slug }) => [slug, id]));
const knownIds = new Set(routeById.keys());

export function placePath(id: string): string {
  const route = routeById.get(id) ?? safePathSegment(id);
  return `/parks/${encodeURIComponent(route)}`;
}

export function placeIdFromSlug(slug: string): string | null {
  const normalized = decodePathSegment(slug)?.toLocaleLowerCase();
  if (!normalized) return null;
  return idByRoute.get(normalized) ?? (knownIds.has(normalized) ? normalized : null);
}

export function hasAccountCallback(url: URL): boolean {
  const fragment = new URLSearchParams(url.hash.slice(1));
  return fragment.has("resetToken") || fragment.has("verificationToken") ||
    (url.searchParams.has("state") && (url.searchParams.has("code") || url.searchParams.has("error")));
}

export function readNavigation(href: string): PublicNavigation {
  const url = new URL(href, "https://web.parkdex.app"), params = url.searchParams;
  const route = readRoute(url);
  const requestedView = params.get("view");
  const legacyView: View = requestedView === "settings"
    ? "account"
    : requestedView && ["map", "collection", "groups", "badges", "account"].includes(requestedView)
      ? requestedView as View
      : "map";
  const isLegacyRoot = normalizePath(url.pathname) === "/";
  const selectedId = route.selectedId ?? (isLegacyRoot ? params.get("place") || null : null);
  const isCallback = hasAccountCallback(url);
  const categorySet = (key: string) => new Set(params.getAll(key).filter((value): value is PlaceCategory => Object.hasOwn(categoryLabels, value)));
  const visit = params.get("placesVisited");

  return {
    view: isCallback ? "account" : route.view ?? legacyView,
    selectedId: isCallback ? null : selectedId,
    detailExpanded: !isCallback && Boolean(selectedId) && params.get("detail") === "full",
    settingsOpen: !isCallback && (route.settingsOpen || (isLegacyRoot && requestedView === "settings")),
    mapMode: params.get("mode") === "explored" ? "explored" : params.get("mode") === "discover" || selectedId ? "discover" : "explored",
    mapSearch: params.get("query") ?? params.get("mapQuery") ?? "",
    mapCategories: categorySet("mapCategory"),
    collectionSearch: params.get("placesQuery") ?? "",
    collectionCategories: categorySet("placesCategory"),
    collectionAuthorities: new Set(params.getAll("authority")),
    collectionVisitFilter: visit === "visited" || visit === "unseen" ? visit : "all",
  };
}

const publicKeys = ["view", "place", "detail", "settings", "from", "mode", "query", "mapQuery", "mapCategory", "placesQuery", "placesCategory", "authority", "placesVisited"];

/** Only public catalogue navigation belongs in the address. Private group context stays in memory. */
export function navigationUrl(currentHref: string, state: PublicNavigation): string {
  const url = new URL(currentHref, "https://web.parkdex.app");
  publicKeys.forEach((key) => url.searchParams.delete(key));

  if (state.settingsOpen) url.pathname = "/settings";
  else if (state.selectedId) url.pathname = placePath(state.selectedId);
  else url.pathname = viewPath(state.view);

  if (state.selectedId && state.view === "collection") url.searchParams.set("from", "places");
  if (state.selectedId && state.detailExpanded) url.searchParams.set("detail", "full");
  if (state.mapMode === "discover") url.searchParams.set("mode", "discover");
  else if (state.selectedId) url.searchParams.set("mode", "explored");
  if (state.mapSearch.trim()) url.searchParams.set("query", state.mapSearch);
  [...state.mapCategories].sort().forEach((value) => url.searchParams.append("mapCategory", value));
  if (state.collectionSearch) url.searchParams.set("placesQuery", state.collectionSearch);
  [...state.collectionCategories].sort().forEach((value) => url.searchParams.append("placesCategory", value));
  [...state.collectionAuthorities].sort().forEach((value) => url.searchParams.append("authority", value));
  if (state.collectionVisitFilter !== "all") url.searchParams.set("placesVisited", state.collectionVisitFilter);
  return `${url.pathname}${url.search}${url.hash}`;
}

function readRoute(url: URL): { view: View | null; selectedId: string | null; settingsOpen: boolean } {
  const path = normalizePath(url.pathname).toLocaleLowerCase();
  if (path === "/map") return { view: "map", selectedId: null, settingsOpen: false };
  if (path === "/places") return { view: "collection", selectedId: null, settingsOpen: false };
  if (path === "/groups") return { view: "groups", selectedId: null, settingsOpen: false };
  if (path === "/badges") return { view: "badges", selectedId: null, settingsOpen: false };
  if (path === "/account") return { view: "account", selectedId: null, settingsOpen: false };
  if (path === "/settings") return { view: "account", selectedId: null, settingsOpen: true };
  const match = path.match(/^\/parks\/([^/]+)$/);
  if (match) {
    const slug = decodePathSegment(match[1]);
    if (!slug) return { view: "map", selectedId: null, settingsOpen: false };
    const selectedId = placeIdFromSlug(slug) ?? (isSafePathSegment(slug) ? slug : null);
    const fromPlaces = url.searchParams.get("from") === "places";
    return { view: fromPlaces ? "collection" : "map", selectedId, settingsOpen: false };
  }
  return { view: null, selectedId: null, settingsOpen: false };
}

function viewPath(view: View): string {
  switch (view) {
    case "collection": return "/places";
    case "groups": return "/groups";
    case "badges": return "/badges";
    case "account": return "/account";
    default: return "/map";
  }
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

function decodePathSegment(value: string): string | null {
  try { return decodeURIComponent(value); }
  catch { return null; }
}

function safePathSegment(value: string): string {
  const safe = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "unknown-place";
}

function isSafePathSegment(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value);
}
