import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BadgeShelfView } from "../../components/BadgeShelfView";
import { Flag, FlagPin } from "../../components/Flag";
import { shelfBadges } from "./badges";
import { FLAG_HEIGHT, FLAG_WIDTH, flagPinSvg, flagSpec, flagSvg } from "./flag";
import { patchesMarkup, patchSlots, PIN_CLOTH_TRANSFORM, pinPatchesMarkup, visiblePatchCount, withPatches } from "./patches";

const SEED = "0f6c1d2e9a7b4c3d";
const THREE = ["parks-1", "hold-7", "coast-to-coast"];
const count = (markup: string) => (markup.match(/class="flag-patch"/g) ?? []).length;

describe("flag patches", () => {
  // Every size a flag is drawn at in the app: map pins, lists, cards and the handle reveal.
  it.each([
    [24, 1], [28, 2], [36, 2], [40, 3], [56, 3], [72, 3], [76, 3], [176, 3],
  ])("a flag %ipx wide shows %i of 3 patches", (size, shown) => {
    expect(visiblePatchCount(size)).toBe(shown);
    const markup = patchesMarkup(THREE, { sizePx: size, idPrefix: "t" });
    expect(count(markup)).toBe(shown);
    expect(markup).toContain('href="/art/achievements/parks-1.webp"');
    // The first patch sewn on always shows, in the fly's bottom corner.
    expect(markup.indexOf('data-badge="parks-1"')).toBeGreaterThan(-1);
  });

  it("keeps every patch on the cloth", () => {
    for (const shown of [1, 2, 3]) {
      for (const slot of patchSlots(shown)) {
        expect(slot.x - slot.r).toBeGreaterThanOrEqual(0);
        expect(slot.x + slot.r).toBeLessThanOrEqual(FLAG_WIDTH);
        expect(slot.y + slot.r).toBeLessThanOrEqual(FLAG_HEIGHT);
      }
    }
  });

  it("never changes the generated flag: patches are only appended on top", () => {
    const before = flagSpec(SEED);
    const plain = flagSvg(SEED, { weather: 1, idPrefix: "x" });
    const patched = withPatches(plain, patchesMarkup(THREE, { sizePx: 72, idPrefix: "x" }));
    expect(patched.startsWith(plain.slice(0, -"</svg>".length))).toBe(true);
    expect(patched.endsWith("</svg>")).toBe(true);
    expect(flagSpec(SEED)).toEqual(before);
    expect(flagSvg(SEED, { weather: 1, idPrefix: "x" })).toBe(plain);
    expect(withPatches(plain, patchesMarkup([], { sizePx: 72 }))).toBe(plain);
  });

  it("skips unknown badges, and never draws one twice", () => {
    expect(count(patchesMarkup(["nope", "parks-1", "parks-1"], { sizePx: 72 }))).toBe(1);
    expect(patchesMarkup(["<script>"], { sizePx: 72 })).toBe("");
  });

  it("draws pin patches on the pin's cloth, where flag.ts puts it", () => {
    expect(flagPinSvg(SEED)).toContain(`<g transform="${PIN_CLOTH_TRANSFORM}">`);
    const markup = pinPatchesMarkup(THREE, { sizePx: 70, idPrefix: "p" });
    expect(markup.startsWith(`<g transform="${PIN_CLOTH_TRANSFORM}">`)).toBe(true);
    // A 44px pin's cloth is about 34px wide: room for 2.
    expect(count(pinPatchesMarkup(THREE, { sizePx: 44 }))).toBe(2);
  });

  it("renders patches in the Flag and FlagPin components, and none without them", () => {
    const flag = renderToStaticMarkup(createElement(Flag, { seed: SEED, size: 72, patches: THREE }));
    expect(count(flag)).toBe(3);
    expect(count(renderToStaticMarkup(createElement(Flag, { seed: SEED, size: 40, patches: THREE.slice(0, 1) })))).toBe(1);
    expect(count(renderToStaticMarkup(createElement(Flag, { seed: SEED, size: 72 })))).toBe(0);
    expect(count(renderToStaticMarkup(createElement(Flag, { seed: null, size: 72, patches: THREE })))).toBe(0);
    expect(count(renderToStaticMarkup(createElement(FlagPin, { seed: SEED, size: 56, patches: THREE })))).toBe(3);
  });
});

describe("badge shelf view", () => {
  const items = shelfBadges([
    { id: "parks-1", progress: 1, goal: 1, unlockedAt: "2026-10-01T00:00:00Z" },
    { id: "hold-7", progress: 7, goal: 7, unlockedAt: "2026-10-08T00:00:00Z" },
    { id: "parks-10", progress: 4, goal: 10, unlockedAt: null },
  ]);
  const render = (patches: string[], seen: string[]) => renderToStaticMarkup(createElement(BadgeShelfView, {
    items, patches, flagSeed: SEED, seen: new Set(seen), onOpen: () => {},
  }));

  it("shows earned badges in colour and locked ones as silhouettes with how to earn them", () => {
    const html = render([], []);
    expect(html).toContain("2 of 19 earned");
    expect((html.match(/achievement--earned/g) ?? []).length).toBe(2);
    expect((html.match(/achievement--locked/g) ?? []).length).toBe(17);
    expect(html).toContain('aria-label="Over the Bridge. Earned"');
    expect(html).toContain('aria-label="Swimming Upstream. Locked. Visit 10 parks"');
    expect(html).toContain("4 of 10");
    expect(html).toContain("Hold one flag for 30 days");
  });

  it("marks sewn badges, draws them on the flag, and marks new ones until seen", () => {
    const html = render(["hold-7"], ["parks-1"]);
    expect(html).toContain('aria-label="King of the Hill. Earned, on your flag"');
    expect(html).toContain("1 of 3 sewn on");
    expect(count(html)).toBe(1);
    expect((html.match(/badge-shelf__new/g) ?? []).length).toBe(1);
    expect((render(["hold-7"], ["parks-1", "hold-7"]).match(/badge-shelf__new/g) ?? []).length).toBe(0);
  });
});
