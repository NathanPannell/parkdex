import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BadgeShelfView } from "../../components/BadgeShelfView";
import { Flag, FlagPin } from "../../components/Flag";
import { shelfBadges } from "./badges";
import { FLAG_HEIGHT, FLAG_WIDTH, flagPinSvg, flagSpec, flagSvg } from "./flag";
import { CLOTH_RECT, drawPatches, flagPatchesMarkup, MIN_PATCH_CLOTH_PX, patchesFit, patchesSvg, patchLayout, PIN_CLOTH_RECT, PIN_CLOTH_TRANSFORM, pinPatchesMarkup, placePatches, withPatches } from "./patches";

const SEED = "0f6c1d2e9a7b4c3d";
const THREE = ["parks-1", "hold-7", "coast-to-coast"];
const count = (markup: string) => (markup.match(/class="flag-patch"/g) ?? []).length;

describe("flag patches", () => {
  it("draws every patch at every size that has room for patches, and none below it", () => {
    // Every size a flag with patches is drawn at: crew lists, leaderboard rows, the score chip,
    // the badge shelf, cards and the full-screen flag.
    for (const size of [38, 40, 46, 60, 64, 72, 176, 320]) {
      const markup = flagPatchesMarkup(THREE, { sizePx: size, idPrefix: "t" });
      expect(count(markup)).toBe(3);
      expect(markup).toContain('href="/art/achievements/parks-1.webp"');
    }
    // A 34px flag's cloth is under 36px: plain, with no smudged patches.
    expect(patchesFit(MIN_PATCH_CLOTH_PX)).toBe(true);
    expect(patchesFit(MIN_PATCH_CLOTH_PX - 0.5)).toBe(false);
    expect(flagPatchesMarkup(THREE, { sizePx: 34 })).toBe("");
    // Pins: the park sheet's 48px pin and the podium's 56px have room, a 44px pin does not.
    expect(count(pinPatchesMarkup(THREE, { sizePx: 48 }))).toBe(3);
    expect(count(pinPatchesMarkup(THREE, { sizePx: 56 }))).toBe(3);
    expect(pinPatchesMarkup(THREE, { sizePx: 44 })).toBe("");
  });

  it("lays patches out as fractions of the flag, so every view is a scaled copy", () => {
    for (const shown of [1, 2, 3]) {
      const layout = patchLayout(shown);
      expect(layout).toHaveLength(shown);
      const onCloth = placePatches(shown, CLOTH_RECT);
      const onPin = placePatches(shown, PIN_CLOTH_RECT);
      const scale = PIN_CLOTH_RECT.width / CLOTH_RECT.width;
      onCloth.forEach((slot, index) => {
        // On the cloth, inside its edges.
        expect(slot.x - slot.r).toBeGreaterThanOrEqual(0);
        expect(slot.x + slot.r).toBeLessThanOrEqual(FLAG_WIDTH);
        expect(slot.y - slot.r).toBeGreaterThanOrEqual(0);
        expect(slot.y + slot.r).toBeLessThanOrEqual(FLAG_HEIGHT);
        // The pin's cloth is the same flag, scaled and moved.
        expect(onPin[index].x).toBeCloseTo(PIN_CLOTH_RECT.x + slot.x * scale, 6);
        expect(onPin[index].y).toBeCloseTo(PIN_CLOTH_RECT.y + slot.y * scale, 6);
        expect(onPin[index].r).toBeCloseTo(slot.r * scale, 6);
        // Patches never overlap; the first sewn on sits in the fly's bottom corner.
        if (index > 0) expect(onCloth[index - 1].x - slot.x).toBeGreaterThan(onCloth[index - 1].r + slot.r);
      });
      expect(onCloth[0].x).toBeGreaterThan(FLAG_WIDTH / 2);
    }
    expect(patchLayout(5)).toHaveLength(3);
    expect(patchLayout(0)).toEqual([]);
  });

  it("draws a plain circle with a thin rarity rim: no stitching and no dark border", () => {
    const markup = patchesSvg(["coast-to-coast"], CLOTH_RECT, "p");
    expect(markup).not.toContain("stroke-dasharray");
    expect(markup).not.toContain("stroke=");
    // Legendary rim colour, then the art clipped inside it.
    expect(markup).toContain('fill="#E9A800"');
    expect(markup).toMatch(/<image [^>]*clip-path="url\(#p-patch0\)"/);
  });

  it("draws the same circles on a canvas as in SVG", () => {
    const calls: string[] = [];
    const context = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      beginPath: () => {},
      arc: (x: number, y: number, r: number) => calls.push(`arc ${x.toFixed(2)} ${y.toFixed(2)} ${r.toFixed(2)}`),
      fill: () => calls.push("fill"),
      clip: () => calls.push("clip"),
      drawImage: () => calls.push("image"),
      set fillStyle(value: string) { calls.push(`fill ${value}`); },
    } as unknown as CanvasRenderingContext2D;
    const art = {} as CanvasImageSource;
    drawPatches(context, [{ id: "parks-1", art }, { id: "hold-7", art }], PIN_CLOTH_RECT);
    const svg = patchesSvg(["parks-1", "hold-7"], PIN_CLOTH_RECT, "x");
    const [first, second] = placePatches(2, PIN_CLOTH_RECT);
    for (const slot of [first, second]) {
      expect(calls).toContain(`arc ${slot.x.toFixed(2)} ${slot.y.toFixed(2)} ${slot.r.toFixed(2)}`);
      expect(svg).toContain(`r="${Math.round(slot.r * 100) / 100}"`);
    }
    expect(calls.filter((call) => call === "image")).toHaveLength(2);
    expect(calls).toContain("fill #FFF8EC");
    expect(calls).toContain("fill #7FD3F7");
  });

  it("never changes the generated flag: patches are only appended on top", () => {
    const before = flagSpec(SEED);
    const plain = flagSvg(SEED, { weather: 1, idPrefix: "x" });
    const patched = withPatches(plain, flagPatchesMarkup(THREE, { sizePx: 72, idPrefix: "x" }));
    expect(patched.startsWith(plain.slice(0, -"</svg>".length))).toBe(true);
    expect(patched.endsWith("</svg>")).toBe(true);
    expect(flagSpec(SEED)).toEqual(before);
    expect(flagSvg(SEED, { weather: 1, idPrefix: "x" })).toBe(plain);
    expect(withPatches(plain, flagPatchesMarkup([], { sizePx: 72 }))).toBe(plain);
  });

  it("skips unknown badges, and never draws one twice", () => {
    expect(count(flagPatchesMarkup(["nope", "parks-1", "parks-1"], { sizePx: 72 }))).toBe(1);
    expect(flagPatchesMarkup(["<script>"], { sizePx: 72 })).toBe("");
  });

  it("draws pin patches on the pin's cloth, where flag.ts puts it", () => {
    expect(flagPinSvg(SEED)).toContain(`<g transform="${PIN_CLOTH_TRANSFORM}">`);
    expect(PIN_CLOTH_TRANSFORM).toBe(`translate(${PIN_CLOTH_RECT.x} ${PIN_CLOTH_RECT.y}) scale(${PIN_CLOTH_RECT.width / FLAG_WIDTH})`);
    expect(PIN_CLOTH_RECT.height / FLAG_HEIGHT).toBeCloseTo(PIN_CLOTH_RECT.width / FLAG_WIDTH, 9);
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
