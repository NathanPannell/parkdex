import { CONTENT_AREAS, contentAreaAt, nearestContentArea, type ContentArea } from "./content/contracts";
import type { LngLat } from "./geo";

/**
 * Where a player starts: their own position anywhere in a supported province (CONTENT_AREAS),
 * and the Victoria demo spot only when they are outside every one or share no location.
 */
export type OnboardingStart =
  | { kind: "located"; point: LngLat }
  | { kind: "demo"; message: string };

export const OUTSIDE_PROVINCES_MESSAGE = "Parkdex is in British Columbia and Nova Scotia for now. Using a demo spot in Victoria.";
export const NO_LOCATION_MESSAGE = "No location, no problem. Using a demo spot in Victoria.";

export function onboardingStart(fix: LngLat | null): OnboardingStart {
  if (!fix) return { kind: "demo", message: NO_LOCATION_MESSAGE };
  if (contentAreaAt(fix)) return { kind: "located", point: fix };
  return { kind: "demo", message: OUTSIDE_PROVINCES_MESSAGE };
}

export type MapCamera = { center: LngLat; zoom: number };

// Close enough to show badges rather than dots when the map opens on the visitor.
export const USER_ZOOM = 12.5;

// Each province framed whole on a phone held upright.
const PROVINCE_VIEWS: Record<string, MapCamera> = {
  "British Columbia": { center: [-125.5, 53.8], zoom: 4.6 },
  "Nova Scotia": { center: [-63.1, 45.2], zoom: 5.5 },
};

export function provinceView(area: ContentArea): MapCamera {
  return PROVINCE_VIEWS[area.name] ?? { center: area.anchor, zoom: 6 };
}

/**
 * Where the map first opens. Builds without live GPS open on the player's spot. Builds
 * with it open on the last known location inside a province, else frame the province
 * nearest that location, else British Columbia.
 */
export function startingMapView(tracksRealLocation: boolean, user: LngLat, last: LngLat | null): MapCamera {
  if (!tracksRealLocation) return { center: user, zoom: 12 };
  if (last && contentAreaAt(last)) return { center: last, zoom: USER_ZOOM };
  return provinceView(last ? nearestContentArea(last) : CONTENT_AREAS[0]);
}
