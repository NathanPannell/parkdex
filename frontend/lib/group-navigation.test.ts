// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readGroupNavigation, rememberGroupNavigation } from "./group-navigation";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("private group history", () => {
  it("restores a group and reading position without putting private context in the URL", () => {
    window.history.replaceState({ framework: "preserved" }, "", "/?view=groups");
    rememberGroupNavigation("private-wishlist", 218, "owner-a");
    expect(readGroupNavigation("owner-a")).toEqual({ groupId: "private-wishlist", scrollTop: 218 });
    expect(window.location.search).toBe("?view=groups");
    expect(window.history.state.framework).toBe("preserved");
    const detailEntry = window.history.state;
    window.history.pushState(detailEntry, "", "/?view=map");
    rememberGroupNavigation(null);
    expect(readGroupNavigation().groupId).toBeNull();
    // The departing detail entry is not mutated when the next entry is cleared.
    window.history.replaceState(detailEntry, "", "/?view=groups");
    expect(readGroupNavigation("owner-a")).toEqual({ groupId: "private-wishlist", scrollTop: 218 });
    expect(readGroupNavigation("owner-b")).toEqual({ groupId: null, scrollTop: 0 });
    expect(readGroupNavigation()).toEqual({ groupId: null, scrollTop: 0 });
  });

  it("ignores malformed or absent saved context", () => {
    window.history.replaceState({ parkdexGroup: { groupId: 42, scrollTop: -10, accountId: "owner-a" } }, "");
    expect(readGroupNavigation("owner-a")).toEqual({ groupId: null, scrollTop: 0 });
  });
});
