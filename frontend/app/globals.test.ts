import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const ruleBody = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `missing CSS rule: ${selector}`).toBeTruthy();
  return match?.[1] ?? "";
};

describe("mobile map toolbar CSS", () => {
  it("uses three equal mode columns and only reserves the collapsed search button width", () => {
    expect(css).toContain("grid-template-columns: repeat(3,minmax(0,1fr));");
    expect(css).toContain("grid-template-columns: minmax(0,1fr) 44px;");
    expect(css).toContain(".map-utility .search-dock { width: 44px; min-width: 44px; min-height: 44px; }");
    expect(css).toContain(".map-utility .map-mode-switch .locate-button { width: 100%; min-width: 0; flex: 1 1 auto; }");
    expect(css).not.toMatch(/\.map-utility[^\{]*\{[^}]*96px/);
  });

  it("keeps higher-specificity collapsed and expanded rules aligned at 44px", () => {
    const collapsed = ruleBody(".map-utility .search-dock.collapsed");
    expect(collapsed).toContain("flex: 0 0 44px;");
    expect(collapsed).toContain("width: 44px;");
    expect(collapsed).toContain("min-width: 44px;");
    expect(collapsed).not.toContain("46px");

    const expandedModes = ruleBody(".map-utility.search-open .map-mode-switch button");
    expect(expandedModes).toContain("min-height: 44px;");
    expect(expandedModes).not.toContain("40px");
  });

  it("lets the expanded search own a full row above the three mode controls", () => {
    expect(css).toContain(".map-utility.search-open { grid-template-columns: 1fr; }");
    expect(css).toContain(".map-utility.search-open .search-dock { width: 100%; min-width: 0; }");
    expect(css).toContain(".map-utility.search-open .map-mode-switch { order: 2; }");
    expect(css).toContain(".map-utility.search-open .search-dock { order: 1; }");
  });
});

describe("mobile account shelf CSS", () => {
  it("keeps See all at a touch-friendly height", () => {
    expect(css).toMatch(/\.account-shelf header > button \{[\s\S]*?min-height: 44px;/);
  });
});
