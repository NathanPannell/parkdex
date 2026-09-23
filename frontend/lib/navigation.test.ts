import { describe, expect, it } from "vitest";
import { navigationUrl, placeIdFromSlug, placePath, readNavigation } from "./navigation";

describe("public navigation", () => {
  it("round trips independent map and Places filters with a stable place ID", () => {
    const state = readNavigation("/?view=collection&mapQuery=rain&mapCategory=provincial&placesQuery=coast&placesCategory=national&placesVisited=unseen&authority=Parks+Canada");
    state.view = "map";
    state.selectedId = "provincial-hathayim-marine-park-a-k-a-von-donop-marine-park";
    const url = navigationUrl("/?campaign=summer#notes", state);
    expect(url).toContain("/parks/hathayim-marine-park");
    expect(readNavigation(url)).toEqual(state);
    expect(url).toContain("campaign=summer");
    expect(url).toContain("#notes");
    expect(url).not.toContain("group");
  });

  it("maps app views to stable paths and account settings to their own URL", () => {
    const paths = [
      ["/map", "map"],
      ["/places", "collection"],
      ["/groups", "groups"],
      ["/badges", "badges"],
      ["/account", "account"],
    ] as const;
    for (const [path, view] of paths) {
      expect(readNavigation(path).view).toBe(view);
      const state = readNavigation(path);
      expect(navigationUrl("/", state)).toBe(path);
    }

    const settings = readNavigation("/settings?campaign=summer");
    expect(settings).toMatchObject({ view: "account", settingsOpen: true });
    expect(navigationUrl("/settings?campaign=summer", settings)).toBe("/settings?campaign=summer");
    expect(readNavigation("/?view=settings")).toMatchObject({ view: "account", settingsOpen: true });
  });

  it("uses readable catalogue slugs and falls back to safe stable IDs", () => {
    expect(placePath("provincial-goldstream-park")).toBe("/parks/goldstream-park");
    expect(placeIdFromSlug("goldstream-park")).toBe("provincial-goldstream-park");
    expect(placeIdFromSlug("removed-park")).toBeNull();

    const removedPlace = readNavigation("/?place=legacy-park-id");
    const url = navigationUrl("/", removedPlace);
    expect(url).toBe("/parks/legacy-park-id?mode=discover");
    expect(readNavigation(url).selectedId).toBe("legacy-park-id");
  });

  it("round trips map search as query and accepts the old mapQuery parameter", () => {
    expect(readNavigation("/map?query=river").mapSearch).toBe("river");
    expect(readNavigation("/?mapQuery=river").mapSearch).toBe("river");

    const state = readNavigation("/map?query=river");
    const url = navigationUrl("/?campaign=summer&mapQuery=old#map", state);
    expect(url).toBe("/map?campaign=summer&query=river#map");
  });

  it("uses from=places to retain the selected park's list context", () => {
    const state = readNavigation("/?view=collection&place=provincial-juan-de-fuca-park&detail=full&placesQuery=Forest&placesVisited=unseen&mode=explored");
    expect(state).toMatchObject({ view: "collection", selectedId: "provincial-juan-de-fuca-park", detailExpanded: true, settingsOpen: false, collectionSearch: "Forest", collectionVisitFilter: "unseen", mapMode: "explored" });
    const url = navigationUrl("/?campaign=fall", state);
    expect(url).toContain("/parks/juan-de-fuca-park");
    expect(url).toContain("from=places");
    expect(readNavigation(url)).toEqual(state);
  });

  it("does not persist fullscreen mode after a place closes", () => {
    const state = readNavigation("/parks/juan-de-fuca-park?detail=full");
    state.selectedId = null;
    state.detailExpanded = false;
    const url = navigationUrl("/parks/juan-de-fuca-park?detail=full", state);
    expect(url).toBe("/map?mode=discover");
    expect(readNavigation(url).detailExpanded).toBe(false);
  });

  it("uses safe defaults for malformed tab, visit and category values", () => {
    expect(readNavigation("/?view=unknown&mapCategory=nope&mapCategory=toString&placesVisited=never")).toMatchObject({ view: "map", selectedId: null, collectionVisitFilter: "all", mapCategories: new Set() });
    expect(readNavigation("/?place=removed-id")).toMatchObject({ view: "map", selectedId: "removed-id", mapMode: "discover" });
  });

  it.each(["#resetToken=one-use", "#verificationToken=one-use", "&code=one-use&state=pkce", "&error=access_denied&state=pkce"])("prioritizes account callbacks: %s", (callback) => {
    const href = `/?view=groups&place=public-place${callback}`;
    const state = readNavigation(href);
    expect(state.view).toBe("account");
    expect(state.selectedId).toBeNull();
    expect(JSON.stringify(state)).not.toContain("one-use");
    const target = navigationUrl(href, state);
    expect(target).toMatch(/^\/account\?/);
    expect(target).toContain(callback.startsWith("&") ? callback.slice(1) : callback);
  });
});
