import catalogue from "./visitor-information.catalogue.json";

export type VisitorInformation = { url: string; title: string; authority: string; verifiedAt: string; evidenceUrl: string };
const visitorPages: Record<string, VisitorInformation> = catalogue;

/** An absent entry means no place-specific visitor page has been verified. */
export function getVisitorInformation(placeId: string): VisitorInformation | undefined {
  const entry = Object.hasOwn(visitorPages, placeId) ? visitorPages[placeId] : undefined;
  if (!entry || !entry.url.startsWith("https://")) return undefined;
  return entry;
}
