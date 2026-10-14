import { badgeArtUrl, badgeById, drawablePatches } from "./badges";
import { FLAG_HEIGHT, FLAG_WIDTH, PIN_WIDTH } from "./flag";
import type { Rarity } from "../parks";

/**
 * Badge patches (#175), drawn on top of a generated flag. The flag itself comes from flag.ts and
 * is never changed here: patches are drawn after the cloth, so every flag still draws exactly as
 * its seed says, with or without patches.
 *
 * One layout and one look for every view. `patchLayout` places 1 to 3 patches as fractions of the
 * flag rectangle, along the bottom edge from the fly (the right), the first one sewn on in the
 * corner. `patchesSvg` (lists, cards, the full-screen flag) and `drawPatches` (map pins, on a
 * canvas) both draw from it: the badge art in a plain circle with a thin rim in the badge's
 * rarity colour. So a flag looks like a scaled copy of itself wherever it shows.
 *
 * A flag drawn too small for patches to read shows none, rather than smudges: see `patchesFit`.
 */

/** A flag's cloth in some coordinate space. Always the cloth's own 3:2. */
export type FlagRect = { x: number; y: number; width: number; height: number };
/** One patch as fractions of the flag rectangle: `cx` of its width, `cy` and `r` of its height. */
export type PatchFraction = { cx: number; cy: number; r: number };
/** One patch in the coordinates of a FlagRect. */
export type PatchSlot = { x: number; y: number; r: number };

/** The cloth in flag.ts's own 60 by 40 coordinates, as the Flag component draws it. */
export const CLOTH_RECT: FlagRect = { x: 0, y: 0, width: FLAG_WIDTH, height: FLAG_HEIGHT };
/** Where flag.ts draws the cloth inside a pin; kept in step by patches.test.ts. */
export const PIN_CLOTH_TRANSFORM = "translate(9.5 5.5) scale(0.62)";
export const PIN_CLOTH_RECT: FlagRect = { x: 9.5, y: 5.5, width: FLAG_WIDTH * 0.62, height: FLAG_HEIGHT * 0.62 };

/**
 * The narrowest cloth, in CSS pixels, that shows patches. Below it a patch is a few pixels of
 * mush, so the flag is drawn plain. Every list and card draws flags at least this wide.
 */
export const MIN_PATCH_CLOTH_PX = 36;

export function patchesFit(clothWidthPx: number): boolean {
  return clothWidthPx >= MIN_PATCH_CLOTH_PX;
}

// Fewer patches are drawn a little larger. All in fractions of the flag's height.
const RADIUS = [0, 0.25, 0.215, 0.19];
const MARGIN = 0.05;
const GAP = 0.04;
/** The rim's width as a fraction of the patch radius. */
const RIM = 0.13;

const ASPECT = FLAG_WIDTH / FLAG_HEIGHT;

/** Where each of `count` patches (at most 3) goes on a flag. */
export function patchLayout(count: number): PatchFraction[] {
  const shown = Math.max(0, Math.min(3, Math.floor(count)));
  const r = RADIUS[shown];
  return Array.from({ length: shown }, (_, index) => ({
    // Worked out in heights, so circles stay round on the 3:2 cloth.
    cx: (ASPECT - MARGIN - r - index * (2 * r + GAP)) / ASPECT,
    cy: 1 - MARGIN - r,
    r,
  }));
}

/** The patches' places inside `rect`. */
export function placePatches(count: number, rect: FlagRect): PatchSlot[] {
  return patchLayout(count).map(({ cx, cy, r }) => ({
    x: rect.x + cx * rect.width,
    y: rect.y + cy * rect.height,
    r: r * rect.height,
  }));
}

// The outer colour of each rarity rim in components/Badge.tsx.
const RIM_COLOUR: Record<Rarity, string> = {
  common: "#FFF8EC",
  uncommon: "#7FD3F7",
  rare: "#A9B3D6",
  epic: "#9B7BFF",
  legendary: "#E9A800",
};
const FALLBACK_RIM = "#FFF8EC";

function rimColour(id: string): string {
  const badge = badgeById(id);
  return badge ? RIM_COLOUR[badge.rarity] : FALLBACK_RIM;
}

function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** One patch as SVG: a rim-coloured disc with the badge art clipped to a circle inside it. */
function patchSvg(id: string, slot: PatchSlot, clipId: string): string {
  const { x, y, r } = slot;
  const art = r * (1 - RIM);
  return `<g class="flag-patch" data-badge="${id}">`
    + `<clipPath id="${clipId}"><circle cx="${n(x)}" cy="${n(y)}" r="${n(art)}"/></clipPath>`
    + `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${rimColour(id)}"/>`
    + `<image href="${badgeArtUrl(id)}" x="${n(x - art)}" y="${n(y - art)}" width="${n(2 * art)}" height="${n(2 * art)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
    + `</g>`;
}

/** The patches as SVG inside `rect`, or "" for none. Unknown and repeated IDs are skipped. */
export function patchesSvg(patches: readonly string[] | null | undefined, rect: FlagRect, idPrefix = "flag"): string {
  const known = drawablePatches(patches);
  if (!known.length) return "";
  const prefix = idPrefix.replace(/[^A-Za-z0-9_-]/g, "");
  const slots = placePatches(known.length, rect);
  return known.map((id, index) => patchSvg(id, slots[index], `${prefix}-patch${index}`)).join("");
}

export type PatchOptions = {
  /** The width the whole flag (or pin) is drawn at, in CSS pixels. */
  sizePx: number;
  /** Unique per inline SVG, like the flag's own clip paths. */
  idPrefix?: string;
};

/** Patches for a Flag drawn `sizePx` wide (its view box has a 1-unit margin round the cloth). */
export function flagPatchesMarkup(patches: readonly string[] | null | undefined, options: PatchOptions): string {
  const clothPx = (options.sizePx * FLAG_WIDTH) / (FLAG_WIDTH + 2);
  return patchesFit(clothPx) ? patchesSvg(patches, CLOTH_RECT, options.idPrefix) : "";
}

/** Patches for a flag pin drawn `sizePx` wide: the cloth is a smaller part of the pin. */
export function pinPatchesMarkup(patches: readonly string[] | null | undefined, options: PatchOptions): string {
  const clothPx = (options.sizePx * PIN_CLOTH_RECT.width) / PIN_WIDTH;
  return patchesFit(clothPx) ? patchesSvg(patches, PIN_CLOTH_RECT, options.idPrefix) : "";
}

/** Appends patch markup on top of a finished flag or pin SVG. */
export function withPatches(svg: string, markup: string): string {
  if (!markup) return svg;
  const end = svg.lastIndexOf("</svg>");
  return end === -1 ? svg : `${svg.slice(0, end)}${markup}${svg.slice(end)}`;
}

/** A badge to draw on a canvas, with its art already loaded. */
export type LoadedPatch = { id: string; art: CanvasImageSource };

/**
 * Draws patches on a canvas inside `rect`, the same way patchesSvg does: for the map's pin
 * images, where an SVG image cannot load the badge art itself. The context's transform maps
 * `rect`'s coordinates to pixels.
 */
export function drawPatches(context: CanvasRenderingContext2D, patches: readonly LoadedPatch[], rect: FlagRect): void {
  const slots = placePatches(patches.length, rect);
  patches.slice(0, slots.length).forEach(({ id, art }, index) => {
    const { x, y, r } = slots[index];
    const inner = r * (1 - RIM);
    context.save();
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fillStyle = rimColour(id);
    context.fill();
    context.beginPath();
    context.arc(x, y, inner, 0, Math.PI * 2);
    context.clip();
    context.drawImage(art, x - inner, y - inner, 2 * inner, 2 * inner);
    context.restore();
  });
}
