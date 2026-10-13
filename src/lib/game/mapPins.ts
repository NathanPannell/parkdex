import type { ParkFlag } from "./client";
import { drawablePatches } from "./badges";
import { flagAgeDays, flagAgeMs, flagPinSvg, flagSpec, formatFlagAge, weatherForDays, type FlagWeather } from "./flag";

/**
 * Park pins for the map's symbol layer. Each pin names a shared image (empty pole, or a
 * holder's flag at a weather and age), so a thousand parks reuse a handful of images
 * instead of a thousand DOM markers.
 *
 * Crew flags (#171): the leader's flag flies on top, with up to 3 small pennants in members'
 * colours below it and a "+N" tag for bigger crews, and a shield while the protected hour runs.
 * The flag drawing itself stays in `flag.ts`; pennants and the shield are drawn here.
 *
 * A holder's first badge patch (#175) is a second, shared image per badge that the map draws
 * over the pin only when zoomed in close.
 */

export const EMPTY_PIN = "pin:empty";
const MAX_PENNANTS = 3;

export type PinImage = {
  seed: string | null;
  weather: FlagWeather;
  label: string | null;
  /** Member flag seeds drawn as pennants, earliest first (#171). */
  pennants?: readonly string[];
  /** Crew members beyond the pennants, for the "+N" tag. */
  extra?: number;
  /** The protected hour is running. */
  shield?: boolean;
};
/** `patch` is the image ID of the holder's first badge patch, or "" for none. */
export type PinProperties = { id: string; icon: string; dot: string; held: 0 | 1; sort: number; patch: string };
export type PinFeature = { type: "Feature"; id: number; properties: PinProperties; geometry: { type: "Point"; coordinates: [number, number] } };
export type PinCollection = { type: "FeatureCollection"; features: PinFeature[] };

type PinnedPark = { id: string; lng: number; lat: number };
export type PinOptions = { /** Draw crews: pennants and the protected shield. Off unless the `crews` flag is on. */ crews?: boolean };

export function pinIconId(seed: string, weather: FlagWeather, label: string, crew?: { pennants: readonly string[]; size: number; shield: boolean }): string {
  const base = `pin:${weather}:${label}:${seed}`;
  if (!crew || (!crew.pennants.length && !crew.shield)) return base;
  return `${base}:crew:${crew.size}:${crew.shield ? "p" : "o"}:${crew.pennants.join(",")}`;
}

/** The crew part of a pin: pennants for up to 3 members, the rest as a count, and the shield. */
export function pinCrew(flag: ParkFlag, now: number): { pennants: string[]; size: number; extra: number; shield: boolean } {
  const crew = flag.crew;
  const pennants = (crew?.memberSeeds ?? []).slice(0, MAX_PENNANTS);
  const size = Math.max(1, crew?.size ?? 1, pennants.length + 1);
  const until = crew?.protectedUntil ? Date.parse(crew.protectedUntil) : Number.NaN;
  return { pennants, size, extra: Math.max(0, size - 1 - pennants.length), shield: Number.isFinite(until) && now < until };
}

export function patchIconId(badgeId: string): string {
  return `patch:${badgeId}`;
}

export function buildPins(parks: readonly PinnedPark[], flags: ReadonlyMap<string, ParkFlag> | null, now: number, options: PinOptions = {}): {
  collection: PinCollection;
  images: Map<string, PinImage>;
  /** Patch image ID to badge ID, for every patch a pin shows. */
  patches: Map<string, string>;
} {
  const images = new Map<string, PinImage>([[EMPTY_PIN, { seed: null, weather: 0, label: null }]]);
  const patches = new Map<string, string>();
  const features = parks.map((park, index): PinFeature => {
    const flag = flags?.get(park.id);
    let icon = EMPTY_PIN;
    let dot = "#FFF8EC";
    let patch = "";
    if (flag) {
      const first = drawablePatches(flag.patches)[0];
      if (first) {
        patch = patchIconId(first);
        patches.set(patch, first);
      }
      const days = flagAgeDays(flag.since, now);
      const weather = weatherForDays(days);
      const label = formatFlagAge(flagAgeMs(flag.since, now));
      const crew = options.crews ? pinCrew(flag, now) : null;
      icon = pinIconId(flag.flagSeed, weather, label, crew ?? undefined);
      dot = flagSpec(flag.flagSeed).field;
      if (!images.has(icon)) {
        images.set(icon, crew && (crew.pennants.length || crew.shield)
          ? { seed: flag.flagSeed, weather, label, pennants: crew.pennants, extra: crew.extra, shield: crew.shield }
          : { seed: flag.flagSeed, weather, label });
      }
    }
    return {
      type: "Feature",
      id: index,
      // Held parks draw above empty ones where pins overlap.
      properties: { id: park.id, icon, dot, held: flag ? 1 : 0, sort: flag ? 1 : 0, patch },
      geometry: { type: "Point", coordinates: [park.lng, park.lat] },
    };
  });
  return { collection: { type: "FeatureCollection", features }, images, patches };
}

/** Pins are drawn at twice their size so they stay sharp on high-density screens. */
export const PIN_PIXEL_RATIO = 2;

const INK = "#14231C";
const PAPER = "#FFF8EC";
const n = (value: number) => Number(value.toFixed(2)).toString();

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * A small pennant in a member's flag colours: a triangle in the field colour with an accent
 * band, hanging from its top edge at (x, y). Generated from the seed, never from user text.
 */
export function pennantShape(seed: string, x: number, y: number, width = 7, height = 9): string {
  const spec = flagSpec(seed);
  const tip = `${n(x + width / 2)},${n(y + height)}`;
  const band = height * 0.34;
  return `<polygon points="${n(x)},${n(y)} ${n(x + width)},${n(y)} ${tip}" fill="${spec.field}"/>`
    + `<polygon points="${n(x + (width * band) / height / 2)},${n(y + band)} ${n(x + width - (width * band) / height / 2)},${n(y + band)} ${n(x + width / 2)},${n(y + band * 1.9)}" fill="${spec.accent}"/>`
    + `<polygon points="${n(x)},${n(y)} ${n(x + width)},${n(y)} ${tip}" fill="none" stroke="${INK}" stroke-width="1" stroke-linejoin="round"/>`;
}

/** A pennant on its own, for the join scene and crew lists: a long triangle pointing away from the pole. */
export function pennantSvg(seed: string): string {
  const spec = flagSpec(seed);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 50 32" width="50" height="32">`
    + `<polygon points="0,0 48,15 0,30" fill="${spec.field}"/>`
    + `<polygon points="0,9 19.2,15 0,21" fill="${spec.accent}"/>`
    + `<circle cx="8" cy="15" r="3.2" fill="${spec.emblemColor}"/>`
    + `<polygon points="0,0 48,15 0,30" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

/** The protected hour's mark: a small gold shield over the flag's top corner. */
const SHIELD = `<path d="M42.5 1.2 47 3v3.7c0 2.9-1.9 4.7-4.5 5.8-2.6-1.1-4.5-2.9-4.5-5.8V3Z" fill="#FFC93C" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>`
  + `<path d="M40.6 6.6 42 8l2.5-2.8" fill="none" stroke="${INK}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`;

export function pinImageSvg(image: PinImage): string {
  const pennants = image.pennants ?? [];
  if (!image.seed || (!pennants.length && !image.shield)) {
    return flagPinSvg(image.seed, { weather: image.weather, label: image.label ?? undefined, idPrefix: "pin", scale: PIN_PIXEL_RATIO });
  }
  // The leader's flag on its pole, drawn by flag.ts without its age tag; the tag moves below the pennants.
  const base = flagPinSvg(image.seed, { weather: image.weather, idPrefix: "pin", scale: PIN_PIXEL_RATIO }).replace(/<\/svg>$/, "");
  let overlay = "";
  pennants.forEach((seed, index) => {
    overlay += pennantShape(seed, 10.5 + index * 8, 31);
  });
  const extra = image.extra ?? 0;
  if (extra > 0) {
    const text = escapeText(`+${Math.min(extra, 9)}`);
    const x = 11 + pennants.length * 8;
    // A crew has at most 8 people, so the tag is "+1" to "+4" and fits inside the pin.
    const width = 4 + text.length * 4.2;
    overlay += `<rect x="${n(x)}" y="31" width="${n(width)}" height="9" rx="4.5" fill="${INK}"/>`
      + `<text x="${n(x + width / 2)}" y="38.2" font-family="system-ui, sans-serif" font-size="7" font-weight="800" fill="${PAPER}" text-anchor="middle">${text}</text>`;
  }
  const label = image.label ? escapeText(image.label.slice(0, 6)) : "";
  if (label) {
    const width = 7 + label.length * 5.6;
    overlay += `<rect x="10.5" y="${pennants.length || extra ? 42 : 33}" width="${n(width)}" height="11" rx="5.5" fill="${INK}"/>`
      + `<text x="${n(10.5 + width / 2)}" y="${pennants.length || extra ? 50.4 : 41.4}" font-family="system-ui, sans-serif" font-size="9" font-weight="800" fill="${PAPER}" text-anchor="middle">${label}</text>`;
  }
  if (image.shield) overlay += SHIELD;
  return `${base}${overlay}</svg>`;
}
