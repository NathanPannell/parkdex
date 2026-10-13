import { badgeArtUrl, badgeById, drawablePatches } from "./badges";
import { FLAG_WIDTH, PIN_HEIGHT, PIN_WIDTH } from "./flag";
import type { Rarity } from "../parks";

/**
 * Badge patches (#175), drawn on top of a generated flag. The flag itself comes from flag.ts and
 * is never changed here: patches are extra SVG appended after the cloth, so every flag still
 * draws exactly as its seed says, with or without patches.
 *
 * Coordinates are the flag's own 60 by 40 cloth. Patches sit along the bottom edge from the fly
 * (the right), the first one sewn on in the corner. Small flags show fewer, so each stays legible.
 */

export type PatchSlot = { x: number; y: number; r: number };

const OUTLINE = "#14231C";
const STITCH = "#FFF8EC";
// The outer colour of each rarity rim in components/Badge.tsx.
const RIM: Record<Rarity, string> = {
  common: "#FFF8EC",
  uncommon: "#7FD3F7",
  rare: "#A9B3D6",
  epic: "#9B7BFF",
  legendary: "#E9A800",
};

/** How many patches a flag drawn `sizePx` wide has room for. */
export function visiblePatchCount(sizePx: number): number {
  if (sizePx >= 40) return 3;
  if (sizePx >= 28) return 2;
  return 1;
}

/** Where each of `count` patches goes on the cloth. Fewer patches are drawn a little larger. */
export function patchSlots(count: number): PatchSlot[] {
  const r = count >= 3 ? 7 : count === 2 ? 8 : 9.5;
  const gap = 2;
  return Array.from({ length: Math.max(0, Math.min(3, count)) }, (_, index) => ({
    x: FLAG_WIDTH - 2 - r - index * (2 * r + gap),
    y: 40 - 2 - r,
    r,
  }));
}

function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** One patch: a rim in its rarity colour, the badge art clipped to a circle, and a stitched edge. */
function patchMarkup(id: string, slot: PatchSlot, clipId: string): string {
  const badge = badgeById(id);
  if (!badge) return "";
  const { x, y, r } = slot;
  return `<g class="flag-patch" data-badge="${id}">`
    + `<clipPath id="${clipId}"><circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}"/></clipPath>`
    + `<circle cx="${n(x)}" cy="${n(y + 0.6)}" r="${n(r + 1.4)}" fill="${OUTLINE}" fill-opacity="0.3"/>`
    + `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r + 1.2)}" fill="${RIM[badge.rarity]}" stroke="${OUTLINE}" stroke-width="0.9"/>`
    + `<image href="${badgeArtUrl(id)}" x="${n(x - r)}" y="${n(y - r)}" width="${n(2 * r)}" height="${n(2 * r)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
    + `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r - 0.9)}" fill="none" stroke="${STITCH}" stroke-opacity="0.85" stroke-width="0.5" stroke-dasharray="1.2 0.9"/>`
    + `</g>`;
}

export type PatchOptions = {
  /** The width the flag is drawn at, in CSS pixels; small flags show fewer patches. */
  sizePx: number;
  /** Unique per inline SVG, like the flag's own clip paths. */
  idPrefix?: string;
};

/** The patches as SVG in the flag's cloth coordinates, or "" for none. Unknown IDs are skipped. */
export function patchesMarkup(patches: readonly string[] | null | undefined, options: PatchOptions): string {
  const known = drawablePatches(patches).slice(0, visiblePatchCount(options.sizePx));
  if (!known.length) return "";
  const prefix = (options.idPrefix ?? "flag").replace(/[^A-Za-z0-9_-]/g, "");
  const slots = patchSlots(known.length);
  return known.map((id, index) => patchMarkup(id, slots[index], `${prefix}-patch${index}`)).join("");
}

/** Appends patch markup on top of a finished flag or pin SVG. */
export function withPatches(svg: string, markup: string): string {
  if (!markup) return svg;
  const end = svg.lastIndexOf("</svg>");
  return end === -1 ? svg : `${svg.slice(0, end)}${markup}${svg.slice(end)}`;
}

/** Where flag.ts draws the cloth inside a pin; kept in step by patches.test.ts. */
export const PIN_CLOTH_TRANSFORM = "translate(9.5 5.5) scale(0.62)";
const PIN_CLOTH_SCALE = 0.62;

/** Patches for a flag pin drawn `sizePx` wide: the cloth is a smaller part of the pin. */
export function pinPatchesMarkup(patches: readonly string[] | null | undefined, options: PatchOptions): string {
  const clothPx = options.sizePx * ((FLAG_WIDTH * PIN_CLOTH_SCALE) / PIN_WIDTH);
  const markup = patchesMarkup(patches, { ...options, sizePx: clothPx });
  return markup ? `<g transform="${PIN_CLOTH_TRANSFORM}">${markup}</g>` : "";
}

/**
 * The map draws a pin's first patch as its own image, the size of a whole pin and transparent
 * apart from the patch, so it lines up with the pin under the same anchor, offset and size.
 */
// On the cloth's lower fly corner: clear of the crew shield above (#171) and the pennants below.
export const MAP_PATCH_SLOT: PatchSlot = { x: 37, y: 21.5, r: 7 };

/** Draws a map patch image: the badge art in a rimmed circle at MAP_PATCH_SLOT, scaled by `ratio`. */
export function drawMapPatch(context: CanvasRenderingContext2D, art: CanvasImageSource, id: string, ratio: number): void {
  const badge = badgeById(id);
  const { x, y, r } = MAP_PATCH_SLOT;
  context.save();
  context.scale(ratio, ratio);
  context.clearRect(0, 0, PIN_WIDTH, PIN_HEIGHT);
  context.beginPath();
  context.arc(x, y + 0.8, r + 1.8, 0, Math.PI * 2);
  context.fillStyle = "rgba(20, 35, 28, 0.3)";
  context.fill();
  context.beginPath();
  context.arc(x, y, r + 1.5, 0, Math.PI * 2);
  context.fillStyle = badge ? RIM[badge.rarity] : STITCH;
  context.fill();
  context.lineWidth = 1.2;
  context.strokeStyle = OUTLINE;
  context.stroke();
  context.beginPath();
  context.arc(x, y, r, 0, Math.PI * 2);
  context.clip();
  context.drawImage(art, x - r, y - r, 2 * r, 2 * r);
  context.restore();
}
