import catalogue from "./place-description-sources.catalogue.json";

export type PlaceDescriptionSource = {
  status: "summary" | "no-overview";
  sourceName: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceSection: string;
  reviewedAt: string;
};

const sources: Record<string, PlaceDescriptionSource> = catalogue as Record<string, PlaceDescriptionSource>;

export function getPlaceDescriptionSource(placeId: string): PlaceDescriptionSource | undefined {
  const entry = Object.hasOwn(sources, placeId) ? sources[placeId] : undefined;
  return entry?.sourceUrl.startsWith("https://") ? entry : undefined;
}
