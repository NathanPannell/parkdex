/**
 * Which province each catalogue region belongs to, for My Dex (#174). `public.parks.region` is
 * free text, so this list is kept by hand: add a label here when an import brings a new one.
 * Anything not listed falls under "Other".
 */

export const OTHER_PROVINCE = "Other";

export const PROVINCE_ORDER = ["British Columbia", "Nova Scotia"] as const;

const BRITISH_COLUMBIA = [
  // The legacy BC import (docs/import-legacy-bc-parks.md).
  "Southern Vancouver Island",
  "Northern Vancouver Island",
  "Thompson & Okanagan",
  "Kootenays",
  "South Coast",
  "Cariboo & Central Interior",
  "North Coast & Haida Gwaii",
  "Northeast",
  "Nechako",
  "Central Coast",
  "Gulf Islands",
  "West Coast",
  // Vancouver Island and its islands, from the curated catalogue.
  "Capital Region",
  "Central Island",
  "North Island",
  "South Island",
  "Cowichan Valley",
  "Northern Islands",
  "Northern Gulf Islands",
  "West Coast Islands",
  "Discovery Islands",
];

// Nova Scotia's regions (#178).
const NOVA_SCOTIA = [
  "Halifax Metro",
  "South Shore",
  "Yarmouth and Acadian Shores",
  "Bay of Fundy and Annapolis Valley",
  "Northumberland Shore",
  "Eastern Shore",
  "Cape Breton Island",
];

const key = (region: string) => region.trim().toLowerCase();

/** Every known region label, lower-cased, with its province. game_004_badges.sql mirrors it. */
export const PROVINCE_BY_REGION: ReadonlyMap<string, string> = new Map<string, string>([
  ...BRITISH_COLUMBIA.map((region) => [key(region), "British Columbia"] as const),
  ...NOVA_SCOTIA.map((region) => [key(region), "Nova Scotia"] as const),
]);

/** The province a region label belongs to, or "Other" for a label this build does not know. */
export function provinceFor(region: string | null | undefined): string {
  if (!region) return OTHER_PROVINCE;
  return PROVINCE_BY_REGION.get(key(region)) ?? OTHER_PROVINCE;
}

/** Known provinces in their fixed order, then any others alphabetically, then "Other" last. */
export function compareProvinces(a: string, b: string): number {
  const rank = (name: string) => {
    if (name === OTHER_PROVINCE) return PROVINCE_ORDER.length + 1;
    const index = (PROVINCE_ORDER as readonly string[]).indexOf(name);
    return index === -1 ? PROVINCE_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}
