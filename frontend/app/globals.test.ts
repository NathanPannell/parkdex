import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const ruleBody = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `missing CSS rule: ${selector}`).toBeTruthy();
  return match?.[1] ?? "";
};
const relativeLuminance = (hex: string) => hex.match(/[0-9a-f]{2}/gi)?.map((part) => {
  const channel = Number.parseInt(part, 16) / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}) as number[];
const contrastRatio = (foreground: string, background: string) => {
  const luminance = (hex: string) => {
    const [red, green, blue] = relativeLuminance(hex);
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
};

describe("mobile map toolbar CSS", () => {
  it("reserves fixed square Locate and Search controls beside resilient mode labels", () => {
    expect(css).toContain("grid-template-columns: minmax(0,1fr) minmax(0,1fr) 44px;");
    expect(css).toContain("grid-template-columns: minmax(0,1fr) 44px;");
    expect(css).toContain(".map-utility .search-dock { width: 44px; min-width: 44px; min-height: 44px; }");
    expect(css).toMatch(/\.map-utility \.map-mode-switch \.locate-button,[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
    expect(css).toContain("white-space: nowrap;");
    expect(css).not.toMatch(/\.map-utility[^\{]*\{[^}]*96px/);
    expect(css).toContain(".thumb-nav.guest { grid-template-columns: repeat(3,1fr); }");
    expect(css).toContain(".thumb-nav.guest { grid-template-columns: repeat(3,minmax(0,1fr)); }");
    expect(css).not.toContain(".thumb-nav.guest { grid-template-columns: repeat(2,minmax(0,1fr)); }");
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

  it("renders global progress as a colorful chunky number without gauge styling", () => {
    expect(ruleBody(".global-progress strong")).toContain("font: 800 25px/1 var(--font-display);");
    expect(ruleBody(".global-progress strong span:last-child")).toContain("color: var(--water);");
    expect(css).not.toMatch(/\.global-progress\s*>\s*(?:span|i)/);
  });

  it("integrates global progress into the responsive header without a white card", () => {
    const progress = ruleBody(".global-progress");
    expect(progress).toContain("position: relative;");
    expect(progress).toContain("margin-left: auto;");
    expect(progress).toContain("background: transparent;");
    expect(progress).toContain("border-bottom: 3px solid var(--lime);");
    expect(progress).toContain("box-shadow: none;");
    expect(css).toContain(".expedition-header { grid-template-columns: 38px minmax(0,1fr) auto; padding-right: 11px; }");
    expect(ruleBody(".global-progress[hidden]")).toContain("display: none;");
  });
});

describe("mobile account shelf CSS", () => {
  it("keeps See all at a touch-friendly height", () => {
    expect(css).toMatch(/\.account-shelf header > button \{[\s\S]*?min-height: 44px;/);
  });
});

describe("staging design audit responsive contracts", () => {
  it("covers fractional widths continuously at the desktop breakpoint", () => {
    expect(css).toContain("@media (width < 860px)");
    expect(css).toContain("@media (min-width: 860px)");
    expect(css).toContain(".desktop-top-nav { display: none; }");
    expect(css).not.toContain("@media (max-width: 859px)");
    expect(css).not.toContain("@media (min-width: 859px)");
  });

  it("keeps the mobile dock, search, and filter surfaces on the same ten-pixel rails", () => {
    expect(css).toContain(".thumb-nav { right: 10px; left: 10px;");
    expect(css).toContain(".search-results, .filter-tray { top: auto; right: 10px; bottom: calc(194px + env(safe-area-inset-bottom)); left: 10px; width: auto;");
    expect(css).not.toContain(".thumb-nav { right: 24px; left: auto; width: 500px; }");
  });

  it("moves connection feedback into a reserved, nonblocking status lane", () => {
    const note = ruleBody(".connection-note, .sync-note");
    expect(note).toContain("z-index: 14;");
    expect(note).toContain("min-height: 34px;");
    expect(css).toContain(".connection-note { pointer-events: none; }");
    expect(css).toContain(".connection-status > .sync-note { pointer-events: auto; }");
    expect(css).toContain(".map-stage:has(.connection-status) .search-results");
    expect(css).toContain("var(--connection-status-height,34px)");
    expect(css).not.toContain("connection-status-stack");
  });

  it("keeps Wishlist white text readable on its darkened heart-red surface", () => {
    expect(css).toMatch(/\.wishlist-group-card \{[^}]*background: #b93632;[^}]*color: #fff8ed;/);
    expect(css).toContain(".wishlist-group-icon { display: grid; width: 58px; height: 58px; place-items: center; border-radius: 15px; background: rgba(255,255,255,.22); }");
    expect(css).toContain(".wishlist-group-card small { color: #fff0e1;");
    expect(css).toContain(".wishlist-group-card > svg { color: #fff0e1; }");
    expect(contrastRatio("#fff8ed", "#b93632")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#fff0e1", "#b93632")).toBeGreaterThanOrEqual(4.5);
    expect(css).toContain(".place-sheet-media .sheet-actions { grid-template-columns: minmax(0,1fr) 52px auto;");
    expect(css).toContain(".place-sheet-media .sheet-actions:not(:has(.visit-button)) { grid-template-columns: 52px minmax(0,1fr);");
    expect(css).toContain("font: 900 12px/1 var(--font-body);");
    expect(css).toContain(".place-sheet-media .sheet-actions .group-quick-action > span { display: inline;");
    expect(css).toContain(".place-sheet-media .sheet-actions:has(.visit-button) .group-quick-action { grid-column: 1 / -1; width: 100%; min-width: 0; }");
    expect(css).toContain(".place-sheet-media .sheet-actions:has(.visit-button) { grid-template-columns: 148px; }");
    expect(css).toContain(".place-sheet-media .sheet-actions:has(.visit-button) .group-quick-action { width: 148px; min-width: 148px;");
    expect(css).toContain("button:not(.group-quick-action) > span { display: none; }");
  });

  it("keeps the offline filter tray bottom-anchored while reserving the status lane", () => {
    expect(css).toContain(".filter-tray { position: absolute;");
    expect(css).toContain("overflow-y: auto;");
    expect(css).toContain(".filter-tray { max-height: min(46dvh,calc(100dvh - 274px - env(safe-area-inset-top) - env(safe-area-inset-bottom))); }");
    expect(css).toContain(".map-stage:has(.connection-status) .filter-tray { top: auto; right: 10px; bottom: calc(194px + env(safe-area-inset-bottom)); left: 10px;");
    expect(css).toContain("max-height: min(46dvh,calc(100dvh - 274px - env(safe-area-inset-top) - env(safe-area-inset-bottom) - var(--connection-status-height,34px)))");
    expect(css).not.toContain(".map-stage:has(.connection-status) .filter-tray { top: calc(");
  });

  it("gives details, badges, catalogue search, and shelves responsive space", () => {
    expect(ruleBody(".place-sheet")).toContain("max-height: min(620px, calc(100dvh - 48px));");
    expect(css).toContain(".place-sheet:has(.sheet-actions:empty) .sheet-actions { display: none; }");
    expect(css).toContain("calc(100dvh - 164px - var(--connection-status-height,34px))");
    expect(css).toContain("grid-template-rows: minmax(180px,34dvh) minmax(0,1fr);");
    expect(css).toContain(".feature-collection .category-chips { flex-wrap: wrap;");
    expect(css).toContain(".collection-view.has-query .collection-progress");
    expect(css).toContain(".collection-filter-summary button { display: inline-flex; min-height: 44px;");
    expect(css).toContain(".release-diagnostics summary { display: inline-flex; min-height: 44px;");
    expect(css).toContain("-webkit-line-clamp: 2;");
    expect(css).toContain("text-overflow: ellipsis; white-space: nowrap;");
  });
});
