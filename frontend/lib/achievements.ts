import type { Place } from "@/lib/places";

export const JUAN_DE_FUCA_PARK_ID = "provincial-juan-de-fuca-park";

type AchievementContext = {
  places: Place[];
  visited: ReadonlySet<string>;
  visitTimestamps?: Readonly<Record<string, string>>;
};

export type Achievement = {
  id: string;
  name: string;
  species: string;
  description: string;
  requiredPlaceIds?: readonly string[];
  current: number;
  target: number;
  earned: boolean;
  earnedAt?: string;
};

type Definition = Omit<Achievement, "current" | "target" | "earned"> & {
  target: number;
  count: (context: AchievementContext) => number;
};

const total = ({ places, visited }: AchievementContext) => places.filter((place) => visited.has(place.id)).length;
const regionCount = (needle: string) => ({ places, visited }: AchievementContext) =>
  places.filter((place) => visited.has(place.id) && place.region.toLocaleLowerCase().includes(needle)).length;
const placeSetCount = (ids: readonly string[]) => ({ places, visited }: AchievementContext) => {
  const active = new Set(places.map((place) => place.id));
  return ids.filter((id) => active.has(id) && visited.has(id)).length;
};

const bananaSlugPlaces = [JUAN_DE_FUCA_PARK_ID, "provincial-carmanah-walbran-park", "provincial-macmillan-park"] as const;
const blackBearCoastPlaces = ["national-pacific-rim-national-park-reserve", "provincial-cape-scott-park", "provincial-strathcona-park"] as const;
const seaOtterRaftPlaces = ["island-nootka-island", "island-flores-island", "island-vargas-island"] as const;
const orcaLookoutPlaces = ["national-gulf-islands-national-park-reserve", "regional-east-point-regional-park", "regional-brooks-point-regional-park"] as const;
const stellerHighCountryPlaces = ["provincial-strathcona-park", "provincial-schoen-lake-park", "regional-mount-arrowsmith-massif-regional-park"] as const;
const deerSouthIslandPlaces = ["regional-east-sooke-regional-park", "provincial-gowlland-tod-park", "provincial-goldstream-park"] as const;
const treefrogPondHopPlaces = ["regional-elk-beaver-lake-regional-park", "regional-matheson-lake-regional-park", "regional-thetis-lake-regional-park"] as const;
const redLeggedWetlandsPlaces = ["provincial-kennedy-river-bog-park", "regional-coats-marsh-regional-park", "regional-hamilton-marsh-regional-park-and-conservation-area"] as const;
const redcedarRainlinePlaces = ["national-pacific-rim-national-park-reserve", "provincial-carmanah-walbran-park", JUAN_DE_FUCA_PARK_ID] as const;
const arbutusRainshadowPlaces = ["provincial-bodega-ridge-park", "provincial-helliwell-park", "provincial-mount-maxwell-park"] as const;
const swordFernFallsPlaces = ["provincial-elk-falls-park", "provincial-englishman-river-falls-park", "provincial-little-qualicum-falls-park"] as const;
const camasRainshadowPlaces = ["national-gulf-islands-national-park-reserve", "provincial-ruckle-park", "provincial-mount-maxwell-park"] as const;
const heronTidelinePlaces = ["regional-island-view-beach-regional-park", "regional-witty-s-lagoon-regional-park", "regional-little-qualicum-river-estuary-regional-conservation-area"] as const;
const harbourSealShorelinePlaces = ["provincial-rathtrevor-beach-park", "provincial-miracle-beach-park", "provincial-french-beach-park"] as const;

const definitions: Definition[] = [
  { id: "banana-slug-medal", name: "Banana Slug Rainwalk", species: "banana-slug", description: "Visit Juan de Fuca, Carmanah Walbran and Macmillan parks.", requiredPlaceIds: bananaSlugPlaces, target: 3, count: placeSetCount(bananaSlugPlaces) },
  { id: "black-bear-coast", name: "Black Bear Coast", species: "black-bear", description: "Visit Pacific Rim, Cape Scott and Strathcona parks.", requiredPlaceIds: blackBearCoastPlaces, target: 3, count: placeSetCount(blackBearCoastPlaces) },
  { id: "sea-otter-raft", name: "Sea Otter Raft", species: "sea-otter", description: "Visit Nootka, Flores and Vargas islands along the outer coast.", requiredPlaceIds: seaOtterRaftPlaces, target: 3, count: placeSetCount(seaOtterRaftPlaces) },
  { id: "orca-salish-lookouts", name: "Orca Lookout Loop", species: "orca", description: "Visit Gulf Islands National Park Reserve, East Point and Brooks Point.", requiredPlaceIds: orcaLookoutPlaces, target: 3, count: placeSetCount(orcaLookoutPlaces) },
  { id: "river-otter-rookie", name: "River Otter Rookie", species: "river-otter", description: "Collect your first place.", target: 1, count: total },
  { id: "harbour-seal-five", name: "Harbour Seal High Five", species: "harbour-seal", description: "Visit 5 places.", target: 5, count: total },
  { id: "eagle-ten", name: "Bald Eagle Ten", species: "bald-eagle", description: "Visit 10 places.", target: 10, count: total },
  { id: "heron-twenty-five", name: "Heron’s Long Stride", species: "great-blue-heron", description: "Visit 25 places.", target: 25, count: total },
  { id: "kingfisher-fifty", name: "Kingfisher Fifty", species: "belted-kingfisher", description: "Visit 50 places.", target: 50, count: total },
  { id: "hummingbird-century", name: "Hummingbird Century", species: "rufous-hummingbird", description: "Visit 100 places.", target: 100, count: total },
  { id: "steller-high-country", name: "Steller’s Jay High Country", species: "stellers-jay", description: "Visit Strathcona, Schoen Lake and Mount Arrowsmith Massif parks.", requiredPlaceIds: stellerHighCountryPlaces, target: 3, count: placeSetCount(stellerHighCountryPlaces) },
  { id: "deer-south-island", name: "Black-tailed Deer Ramble", species: "black-tailed-deer", description: "Visit East Sooke, Gowlland Tod and Goldstream parks.", requiredPlaceIds: deerSouthIslandPlaces, target: 3, count: placeSetCount(deerSouthIslandPlaces) },
  { id: "treefrog-pond-hop", name: "Treefrog Pond Hop", species: "pacific-treefrog", description: "Visit Elk/Beaver Lake, Matheson Lake and Thetis Lake regional parks.", requiredPlaceIds: treefrogPondHopPlaces, target: 3, count: placeSetCount(treefrogPondHopPlaces) },
  { id: "red-legged-wetlands", name: "Red-legged Wetland Hop", species: "red-legged-frog", description: "Visit Kennedy River Bog, Coats Marsh and Hamilton Marsh.", requiredPlaceIds: redLeggedWetlandsPlaces, target: 3, count: placeSetCount(redLeggedWetlandsPlaces) },
  { id: "douglas-fir-central", name: "Douglas-fir Heartwood", species: "douglas-fir", description: "Visit 8 places in Central Island.", target: 8, count: regionCount("central") },
  { id: "redcedar-rainline", name: "Western Redcedar Rainline", species: "western-redcedar", description: "Visit Pacific Rim, Carmanah Walbran and Juan de Fuca parks.", requiredPlaceIds: redcedarRainlinePlaces, target: 3, count: placeSetCount(redcedarRainlinePlaces) },
  { id: "arbutus-rainshadow", name: "Arbutus Rainshadow", species: "arbutus", description: "Visit Bodega Ridge, Helliwell and Mount Maxwell parks.", requiredPlaceIds: arbutusRainshadowPlaces, target: 3, count: placeSetCount(arbutusRainshadowPlaces) },
  { id: "salal-north", name: "Salal Northbound", species: "salal", description: "Visit 5 places in a northern region.", target: 5, count: regionCount("northern") },
  { id: "sword-fern-falls", name: "Sword Fern Falls", species: "sword-fern", description: "Visit Elk Falls, Englishman River Falls and Little Qualicum Falls.", requiredPlaceIds: swordFernFallsPlaces, target: 3, count: placeSetCount(swordFernFallsPlaces) },
  { id: "camas-rainshadow", name: "Camas Rainshadow", species: "camas", description: "Visit Gulf Islands National Park Reserve, Ruckle and Mount Maxwell parks.", requiredPlaceIds: camasRainshadowPlaces, target: 3, count: placeSetCount(camasRainshadowPlaces) },
  { id: "heron-tideline", name: "Heron Tideline", species: "great-blue-heron", description: "Visit Island View Beach, Witty’s Lagoon and Little Qualicum River Estuary.", requiredPlaceIds: heronTidelinePlaces, target: 3, count: placeSetCount(heronTidelinePlaces) },
  { id: "harbour-seal-shores", name: "Harbour Seal Shoreline", species: "harbour-seal", description: "Visit Rathtrevor Beach, Miracle Beach and French Beach parks.", requiredPlaceIds: harbourSealShorelinePlaces, target: 3, count: placeSetCount(harbourSealShorelinePlaces) },
];

export function achievements(context: AchievementContext): Achievement[] {
  return definitions.map(({ count, target, ...definition }) => {
    const current = Math.min(count(context), target);
    const earned = current >= target;
    const chronology = [...context.visited]
      .map((id) => ({ id, timestamp: context.visitTimestamps?.[id] }))
      .filter((entry): entry is { id: string; timestamp: string } => Boolean(entry.timestamp))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const seen = new Set<string>();
    let earnedAt: string | undefined;
    for (const entry of chronology) {
      seen.add(entry.id);
      if (count({ ...context, visited: seen }) >= target) {
        earnedAt = entry.timestamp;
        break;
      }
    }
    return { ...definition, current, target, earned, ...(earnedAt ? { earnedAt } : {}) };
  });
}

export function newlyEarnedAchievementIds(previous: readonly Achievement[], next: readonly Achievement[]): string[] {
  const previouslyEarned = new Set(previous.filter((badge) => badge.earned).map((badge) => badge.id));
  return next.filter((badge) => badge.earned && !previouslyEarned.has(badge.id)).map((badge) => badge.id);
}
