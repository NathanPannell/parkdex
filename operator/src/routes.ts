/**
 * The dashboard's sections, their sub-routes and the redirects from retired pages. Plain data
 * and functions with no React, so the shell and its tests share one source of truth.
 */

export type SectionId = "feedback" | "parks" | "analytics" | "app";
/** Icons the sidebar uses; each is a name in ui/Icon.tsx. */
export type SectionIcon = "inbox" | "park" | "chart" | "rocket" | "activity" | "users" | "sliders" | "upload" | "check";

/**
 * Which database a page reads. "toggle" follows the sidebar's Production/Staging switch.
 * "production" pages always read production, because installed apps do (Build config).
 */
export type DatabaseScope = "toggle" | "production";

export interface SubRoute {
  path: string;
  label: string;
  icon: SectionIcon;
  database?: DatabaseScope;
}

export interface SectionRoute {
  id: SectionId;
  path: string;
  label: string;
  icon: SectionIcon;
  /** One line for the page title and the sidebar tooltip. */
  description: string;
  children?: SubRoute[];
}

export const SECTIONS: readonly SectionRoute[] = [
  { id: "feedback", path: "/feedback", label: "Feedback", icon: "inbox", description: "Player reports, from new to done" },
  {
    id: "parks",
    path: "/parks",
    label: "Parks",
    icon: "park",
    description: "The live park catalogue and founding reviews",
    children: [
      // The catalogue owns /parks and every park page under it; the more specific Review wins below.
      { path: "/parks", label: "Catalogue", icon: "park" },
      { path: "/parks/review", label: "Review", icon: "check" },
    ],
  },
  {
    id: "analytics",
    path: "/analytics",
    label: "Analytics",
    icon: "chart",
    description: "Players, accounts and events",
    children: [
      { path: "/analytics/overview", label: "Overview", icon: "chart" },
      { path: "/analytics/accounts", label: "Accounts", icon: "users" },
      { path: "/analytics/events", label: "Events", icon: "activity" },
    ],
  },
  {
    id: "app",
    path: "/app",
    label: "App and updates",
    icon: "rocket",
    description: "Build config and over-the-air updates",
    children: [
      { path: "/app/builds", label: "Build config", icon: "sliders", database: "production" },
      // Both update channels and their history live in production, like build config.
      { path: "/app/updates", label: "Updates", icon: "upload", database: "production" },
    ],
  },
];

export const DEFAULT_PATH = "/feedback";

function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Where an old or bare path now lives, or null when the path is already right. Bookmarks to the
 * retired Proposals, Import and Drafts pages land on Parks; the old Build config page moved
 * under App and updates.
 */
export function redirectFor(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/" || path === "") return DEFAULT_PATH;
  if (within(path, "/proposals")) return "/parks";
  if (within(path, "/builds")) return "/app/builds";
  for (const section of SECTIONS) {
    if (!section.children) continue;
    // A bare section path opens its first page; an unknown sub-path does too.
    if (within(path, section.path) && !section.children.some((child) => within(path, child.path))) return section.children[0].path;
  }
  return path === pathname ? null : path;
}

export interface ResolvedRoute {
  section: SectionRoute;
  child: SubRoute | null;
  database: DatabaseScope;
}

/** The most specific sub-route that owns a path: /parks/review is Review, /parks/<id> is Catalogue. */
export function childFor(section: SectionRoute, pathname: string): SubRoute | null {
  return (section.children ?? []).filter((item) => within(pathname, item.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

/** The section and sub-route a path belongs to, or null for a path no section owns. */
export function resolveRoute(pathname: string): ResolvedRoute | null {
  const section = SECTIONS.find((item) => within(pathname, item.path));
  if (!section) return null;
  const child = childFor(section, pathname);
  return { section, child, database: child?.database ?? "toggle" };
}
