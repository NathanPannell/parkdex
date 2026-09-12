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
  it("reserves fixed square Locate and Search controls beside resilient mode labels", () => {
    expect(css).toContain("grid-template-columns: minmax(0,1fr) minmax(0,1fr) 44px;");
    expect(css).toContain("grid-template-columns: minmax(0,1fr) 44px;");
    expect(css).toContain(".map-utility .search-dock { width: 44px; min-width: 44px; min-height: 44px; }");
    expect(css).toMatch(/\.map-utility \.map-mode-switch \.locate-button,[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
    expect(css).toContain("white-space: nowrap;");
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

describe("issue batch responsive CSS", () => {
  it("lets long group titles wrap without displacing 44px actions", () => {
    expect(css).toContain(".group-detail > header { display: grid; grid-template-columns: minmax(0,1fr) auto; }");
    expect(css).toContain(".group-detail h3, .group-item-copy strong { overflow: visible; overflow-wrap: anywhere; text-overflow: clip; white-space: normal; }");
    expect(css).toContain(".group-detail-actions button, .group-rename button { flex: 0 0 44px; }");
  });

  it("keeps the regional active state dark with white text", () => {
    const regional = ruleBody(".filter-tray button.category-regional.selected");
    expect(regional).toContain("background: #8a4300;");
    expect(regional).toContain("color: #fff;");
  });

  it("renders global progress as a chunky number without gauge styling", () => {
    expect(ruleBody(".global-progress strong")).toContain("font: 800 23px/1 var(--font-display);");
    expect(css).not.toMatch(/\.global-progress\s*>\s*(?:span|i)/);
  });

  it("pins global progress above every view and reserves mobile header space", () => {
    const progress = ruleBody(".global-progress");
    expect(progress).toContain("position: absolute;");
    expect(progress).toContain("z-index: 15;");
    expect(progress).toContain("top: max(15px,calc(env(safe-area-inset-top) + 15px));");
    expect(progress).toContain("right: max(12px,env(safe-area-inset-right));");
    expect(progress).toContain("width: 92px;");
    expect(css).toContain(".expedition-header { grid-template-columns: 38px minmax(0,1fr); padding-right: 108px; }");
    expect(css).toContain(".global-progress { top: max(23px,calc(env(safe-area-inset-top) + 23px)); right: max(16px,env(safe-area-inset-right)); }");
    expect(css).not.toContain(".expedition-header .global-progress");
  });
});

describe("mobile account shelf CSS", () => {
  it("keeps See all at a touch-friendly height", () => {
    expect(css).toMatch(/\.account-shelf header > button \{[\s\S]*?min-height: 44px;/);
  });
});
