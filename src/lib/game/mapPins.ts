import type { ParkFlag } from "./client";
import { flagAgeDays, flagAgeMs, flagPinSvg, flagSpec, formatFlagAge, weatherForDays, type FlagWeather } from "./flag";

/**
 * Park pins for the map's symbol layer. Each pin names a shared image (empty pole, or a
 * holder's flag at a weather and age), so a thousand parks reuse a handful of images
 * instead of a thousand DOM markers.
 */

export const EMPTY_PIN = "pin:empty";

export type PinImage = { seed: string | null; weather: FlagWeather; label: string | null };
export type PinProperties = { id: string; icon: string; dot: string; held: 0 | 1; sort: number };
export type PinFeature = { type: "Feature"; id: number; properties: PinProperties; geometry: { type: "Point"; coordinates: [number, number] } };
export type PinCollection = { type: "FeatureCollection"; features: PinFeature[] };

type PinnedPark = { id: string; lng: number; lat: number };

export function pinIconId(seed: string, weather: FlagWeather, label: string): string {
  return `pin:${weather}:${label}:${seed}`;
}

export function buildPins(parks: readonly PinnedPark[], flags: ReadonlyMap<string, ParkFlag> | null, now: number): { collection: PinCollection; images: Map<string, PinImage> } {
  const images = new Map<string, PinImage>([[EMPTY_PIN, { seed: null, weather: 0, label: null }]]);
  const features = parks.map((park, index): PinFeature => {
    const flag = flags?.get(park.id);
    let icon = EMPTY_PIN;
    let dot = "#FFF8EC";
    if (flag) {
      const days = flagAgeDays(flag.since, now);
      const weather = weatherForDays(days);
      const label = formatFlagAge(flagAgeMs(flag.since, now));
      icon = pinIconId(flag.flagSeed, weather, label);
      dot = flagSpec(flag.flagSeed).field;
      if (!images.has(icon)) images.set(icon, { seed: flag.flagSeed, weather, label });
    }
    return {
      type: "Feature",
      id: index,
      // Held parks draw above empty ones where pins overlap.
      properties: { id: park.id, icon, dot, held: flag ? 1 : 0, sort: flag ? 1 : 0 },
      geometry: { type: "Point", coordinates: [park.lng, park.lat] },
    };
  });
  return { collection: { type: "FeatureCollection", features }, images };
}

/** Pins are drawn at twice their size so they stay sharp on high-density screens. */
export const PIN_PIXEL_RATIO = 2;

export function pinImageSvg(image: PinImage): string {
  return flagPinSvg(image.seed, { weather: image.weather, label: image.label ?? undefined, idPrefix: "pin", scale: PIN_PIXEL_RATIO });
}
