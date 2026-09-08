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

const definitions: Definition[] = [
  { id: "banana-slug-medal", name: "Banana Slug Rainwalk", species: "banana-slug", description: "Visit Juan de Fuca, Carmanah Walbran and Macmillan parks.", target: 3, count: placeSetCount([JUAN_DE_FUCA_PARK_ID, "provincial-carmanah-walbran-park", "provincial-macmillan-park"]) },
  { id: "black-bear-coast", name: "Black Bear Coast", species: "black-bear", description: "Visit Pacific Rim, Cape Scott and Strathcona parks.", target: 3, count: placeSetCount(["national-pacific-rim-national-park-reserve", "provincial-cape-scott-park", "provincial-strathcona-park"]) },
  { id: "sea-otter-raft", name: "Sea Otter Raft", species: "sea-otter", description: "Visit Nootka, Flores and Vargas islands along the outer coast.", target: 3, count: placeSetCount(["island-nootka-island", "island-flores-island", "island-vargas-island"]) },
  { id: "orca-salish-lookouts", name: "Orca Lookout Loop", species: "orca", description: "Visit Gulf Islands National Park Reserve, East Point and Brooks Point.", target: 3, count: placeSetCount(["national-gulf-islands-national-park-reserve", "regional-east-point-regional-park", "regional-brooks-point-regional-park"]) },
  { id: "river-otter-rookie", name: "River Otter Rookie", species: "river-otter", description: "Collect your first place.", target: 1, count: total },
  { id: "harbour-seal-five", name: "Harbour Seal High Five", species: "harbour-seal", description: "Visit 5 places.", target: 5, count: total },
  { id: "eagle-ten", name: "Bald Eagle Ten", species: "bald-eagle", description: "Visit 10 places.", target: 10, count: total },
  { id: "heron-twenty-five", name: "Heron’s Long Stride", species: "great-blue-heron", description: "Visit 25 places.", target: 25, count: total },
  { id: "kingfisher-fifty", name: "Kingfisher Fifty", species: "belted-kingfisher", description: "Visit 50 places.", target: 50, count: total },
  { id: "hummingbird-century", name: "Hummingbird Century", species: "rufous-hummingbird", description: "Visit 100 places.", target: 100, count: total },
  { id: "steller-high-country", name: "Steller’s Jay High Country", species: "stellers-jay", description: "Visit Strathcona, Schoen Lake and Mount Arrowsmith Massif parks.", target: 3, count: placeSetCount(["provincial-strathcona-park", "provincial-schoen-lake-park", "regional-mount-arrowsmith-massif-regional-park"]) },
  { id: "deer-south-island", name: "Black-tailed Deer Ramble", species: "black-tailed-deer", description: "Visit East Sooke, Gowlland Tod and Goldstream parks.", target: 3, count: placeSetCount(["regional-east-sooke-regional-park", "provincial-gowlland-tod-park", "provincial-goldstream-park"]) },
  { id: "treefrog-pond-hop", name: "Treefrog Pond Hop", species: "pacific-treefrog", description: "Visit Elk/Beaver Lake, Matheson Lake and Thetis Lake regional parks.", target: 3, count: placeSetCount(["regional-elk-beaver-lake-regional-park", "regional-matheson-lake-regional-park", "regional-thetis-lake-regional-park"]) },
  { id: "red-legged-wetlands", name: "Red-legged Wetland Hop", species: "red-legged-frog", description: "Visit Kennedy River Bog, Coats Marsh and Hamilton Marsh.", target: 3, count: placeSetCount(["provincial-kennedy-river-bog-park", "regional-coats-marsh-regional-park", "regional-hamilton-marsh-regional-park-and-conservation-area"]) },
  { id: "douglas-fir-central", name: "Douglas-fir Heartwood", species: "douglas-fir", description: "Visit 8 places in Central Island.", target: 8, count: regionCount("central") },
  { id: "redcedar-rainline", name: "Western Redcedar Rainline", species: "western-redcedar", description: "Visit Pacific Rim, Carmanah Walbran and Juan de Fuca parks.", target: 3, count: placeSetCount(["national-pacific-rim-national-park-reserve", "provincial-carmanah-walbran-park", JUAN_DE_FUCA_PARK_ID]) },
  { id: "arbutus-rainshadow", name: "Arbutus Rainshadow", species: "arbutus", description: "Visit Bodega Ridge, Helliwell and Mount Maxwell parks.", target: 3, count: placeSetCount(["provincial-bodega-ridge-park", "provincial-helliwell-park", "provincial-mount-maxwell-park"]) },
  { id: "salal-north", name: "Salal Northbound", species: "salal", description: "Visit 5 places in a northern region.", target: 5, count: regionCount("northern") },
  { id: "sword-fern-falls", name: "Sword Fern Falls", species: "sword-fern", description: "Visit Elk Falls, Englishman River Falls and Little Qualicum Falls.", target: 3, count: placeSetCount(["provincial-elk-falls-park", "provincial-englishman-river-falls-park", "provincial-little-qualicum-falls-park"]) },
  { id: "camas-rainshadow", name: "Camas Rainshadow", species: "camas", description: "Visit Gulf Islands National Park Reserve, Ruckle and Mount Maxwell parks.", target: 3, count: placeSetCount(["national-gulf-islands-national-park-reserve", "provincial-ruckle-park", "provincial-mount-maxwell-park"]) },
  { id: "heron-tideline", name: "Heron Tideline", species: "great-blue-heron", description: "Visit Island View Beach, Witty’s Lagoon and Little Qualicum River Estuary.", target: 3, count: placeSetCount(["regional-island-view-beach-regional-park", "regional-witty-s-lagoon-regional-park", "regional-little-qualicum-river-estuary-regional-conservation-area"]) },
  { id: "harbour-seal-shores", name: "Harbour Seal Shoreline", species: "harbour-seal", description: "Visit Rathtrevor Beach, Miracle Beach and French Beach parks.", target: 3, count: placeSetCount(["provincial-rathtrevor-beach-park", "provincial-miracle-beach-park", "provincial-french-beach-park"]) },
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
