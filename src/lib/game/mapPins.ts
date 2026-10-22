import type { ParkFlag } from "./client";
import { drawablePatches } from "./badges";
import { flagAgeDays, flagAgeMs, flagPinSvg, flagSpec, formatFlagAge, weatherForDays, type FlagWeather } from "./flag";
import { MIN_PATCH_CLOTH_PX, PIN_CLOTH_RECT } from "./patches";

/**
 * Park pins for the map's symbol layer. Each pin names a shared image (empty pole, or a
 * holder's flag at a weather and age), so a thousand parks reuse a handful of images
 * instead of a thousand DOM markers.
 *
 * A holder's badge patches (#175) are drawn into a second image of the same pin, which the map
 * shows only where the pin is drawn big enough for patches to read (see `patchMinZoom`): zoomed
 * in close, or the selected pin. Everywhere else the pin is the plain flag.
 */

export const EMPTY_PIN = "pin:empty";

export type PinImage = {
  seed: string | null;
  weather: FlagWeather;
  label: string | null;
  /** Badges sewn on the flag, drawn on the cloth (#175). Only in the `patched` image. */
  patches?: readonly string[];
};
/** `icon` is the plain pin; `patched` the same pin with the holder's patches, or `icon` without any. */
export type PinProperties = { id: string; icon: string; patched: string; dot: string; held: 0 | 1; sort: number };
export type PinFeature = { type: "Feature"; id: number; properties: PinProperties; geometry: { type: "Point"; coordinates: [number, number] } };
export type PinCollection = { type: "FeatureCollection"; features: PinFeature[] };

type PinnedPark = { id: string; lng: number; lat: number };
export type PinOptions = {
  /** Draw holders' badge patches (#175). Off unless the `badges` flag is on; then no pin has a patched image. */
  badges?: boolean;
};

export function pinIconId(seed: string, weather: FlagWeather, label: string): string {
  return `pin:${weather}:${label}:${seed}`;
}

/** The pin image with patches sewn on: the plain pin's ID plus the badges it draws, in order. */
export function patchedPinIconId(icon: string, patches: readonly string[]): string {
  return patches.length ? `${icon}:patches:${patches.join(",")}` : icon;
}

export function buildPins(
  parks: readonly PinnedPark[],
  flags: ReadonlyMap<string, ParkFlag> | null,
  now: number,
  options: PinOptions = {},
): {
  collection: PinCollection;
  images: Map<string, PinImage>;
} {
  const images = new Map<string, PinImage>([[EMPTY_PIN, { seed: null, weather: 0, label: null }]]);
  const features = parks.map((park, index): PinFeature => {
    const flag = flags?.get(park.id);
    let icon = EMPTY_PIN;
    let patched = EMPTY_PIN;
    let dot = "#FFF8EC";
    if (flag) {
      const days = flagAgeDays(flag.since, now);
      const weather = weatherForDays(days);
      const label = formatFlagAge(flagAgeMs(flag.since, now));
      icon = pinIconId(flag.flagSeed, weather, label);
      dot = flagSpec(flag.flagSeed).field;
      const image: PinImage = { seed: flag.flagSeed, weather, label };
      if (!images.has(icon)) images.set(icon, image);
      const patches = options.badges ? drawablePatches(flag.patches) : [];
      patched = patchedPinIconId(icon, patches);
      if (!images.has(patched)) images.set(patched, { ...image, patches });
    }
    return {
      type: "Feature",
      id: index,
      // Held parks draw above empty ones where pins overlap.
      properties: { id: park.id, icon, patched, dot, held: flag ? 1 : 0, sort: flag ? 1 : 0 },
      geometry: { type: "Point", coordinates: [park.lng, park.lat] },
    };
  });
  return { collection: { type: "FeatureCollection", features }, images };
}

/** Pins are drawn at twice their size so they stay sharp on high-density screens. */
export const PIN_PIXEL_RATIO = 2;
/** Pins with patches only show drawn large, so they get more pixels for the badge art. */
export const PATCHED_PIN_PIXEL_RATIO = 3;

/** Below this zoom the map shows dots; from it, flags on poles. */
export const FLAG_PIN_ZOOM = 10.5;

/** How big the map draws a pin at a zoom, plain and selected; linear in between, flat outside. */
export const PIN_SCALE_STOPS: readonly (readonly [zoom: number, plain: number, selected: number])[] = [
  // The selected pin is drawn big enough for its patches at every zoom that shows flags.
  [FLAG_PIN_ZOOM, 0.62, 0.97],
  [13, 0.9, 1.3],
  [16, 1.05, 1.45],
];

export function pinScale(zoom: number, selected: boolean): number {
  const pick = (stop: readonly [number, number, number]) => (selected ? stop[2] : stop[1]);
  const first = PIN_SCALE_STOPS[0];
  if (zoom <= first[0]) return pick(first);
  for (let index = 1; index < PIN_SCALE_STOPS.length; index += 1) {
    const low = PIN_SCALE_STOPS[index - 1];
    const high = PIN_SCALE_STOPS[index];
    if (zoom <= high[0]) return pick(low) + ((pick(high) - pick(low)) * (zoom - low[0])) / (high[0] - low[0]);
  }
  return pick(PIN_SCALE_STOPS[PIN_SCALE_STOPS.length - 1]);
}

/**
 * The zoom, to a tenth, from which a pin's cloth is drawn at least MIN_PATCH_CLOTH_PX wide, so
 * its patches read: the same rule as every other flag in the app.
 */
export function patchMinZoom(selected: boolean): number {
  const last = PIN_SCALE_STOPS[PIN_SCALE_STOPS.length - 1][0];
  for (let tenth = Math.round(FLAG_PIN_ZOOM * 10); tenth <= Math.round(last * 10); tenth += 1) {
    if (PIN_CLOTH_RECT.width * pinScale(tenth / 10, selected) >= MIN_PATCH_CLOTH_PX) return tenth / 10;
  }
  return Number.POSITIVE_INFINITY;
}

/** The pin without its patches, `ratio` times its size; patches are drawn over it on a canvas. */
export function pinImageSvg(image: PinImage, ratio = PIN_PIXEL_RATIO): string {
  return flagPinSvg(image.seed, { weather: image.weather, label: image.label ?? undefined, idPrefix: "pin", scale: ratio });
}
