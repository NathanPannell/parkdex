import { describe, expect, it } from "vitest";
import { navigationUrl, readNavigation } from "./navigation";

describe("public navigation", () => {
  it("round trips independent map and Places filters with a stable place ID", () => {
    const state = readNavigation("/?view=collection&mapQuery=rain&mapCategory=provincial&placesQuery=coast&placesCategory=national&placesVisited=unseen&authority=Parks+Canada");
    state.view = "map";
    state.selectedId = "provincial-hathayim-marine-park-a-k-a-von-donop-marine-park";
    const url = navigationUrl("/?campaign=summer#notes", state);
    expect(readNavigation(url)).toEqual(state);
    expect(url).toContain("campaign=summer");
    expect(url).toContain("#notes");
    expect(url).not.toContain("group");
  });

  it("uses safe defaults for malformed tab, visit and category values", () => {
    expect(readNavigation("/?view=unknown&mapCategory=nope&mapCategory=toString&placesVisited=never")).toMatchObject({ view: "map", selectedId: null, collectionVisitFilter: "all", mapCategories: new Set() });
    expect(readNavigation("/?place=removed-id")).toMatchObject({ view: "map", selectedId: "removed-id", mapMode: "discover" });
  });

  it("keeps the list origin and fullscreen detail in a shareable place URL", () => {
    const state = readNavigation("/?view=collection&place=provincial-juan-de-fuca-park&detail=full&placesQuery=Forest&placesVisited=unseen&mode=explored");
    expect(state).toMatchObject({ view: "collection", selectedId: "provincial-juan-de-fuca-park", detailExpanded: true, collectionSearch: "Forest", collectionVisitFilter: "unseen", mapMode: "explored" });
    expect(readNavigation(navigationUrl("/?campaign=fall", state))).toEqual(state);
  });

  it("does not persist fullscreen mode after a place closes", () => {
    const state = readNavigation("/?view=collection&place=provincial-juan-de-fuca-park&detail=full");
    state.selectedId = null;
    const url = navigationUrl("/?view=collection&place=provincial-juan-de-fuca-park&detail=full", state);
    expect(url).not.toContain("place=");
    expect(url).not.toContain("detail=");
    expect(readNavigation(url).detailExpanded).toBe(false);
  });

  it.each(["#resetToken=one-use", "#verificationToken=one-use", "&code=one-use&state=pkce", "&error=access_denied&state=pkce"])("prioritizes account callbacks: %s", (callback) => {
    const href = `/?view=groups&place=public-place${callback}`;
    const state = readNavigation(href);
    expect(state.view).toBe("account");
    expect(state.selectedId).toBeNull();
    expect(JSON.stringify(state)).not.toContain("one-use");
    expect(navigationUrl(href, state)).toContain(callback.startsWith("&") ? callback.slice(1) : callback);
  });
});
