import type { Place, PlaceCategory } from "@/lib/places";

export const TRAILS = [
  { id: "west_coast_trail", name: "West Coast Trail" },
  { id: "juan_de_fuca_trail", name: "Juan de Fuca Trail" },
] as const;

type AchievementContext = {
  places: Place[];
  visited: ReadonlySet<string>;
  completedTrails: ReadonlySet<string>;
};

export type Achievement = {
  id: string;
  name: string;
  species: string;
  description: string;
  current: number;
  target: number;
  earned: boolean;
};

type Definition = Omit<Achievement, "current" | "target" | "earned"> & {
  target: number;
  count: (context: AchievementContext) => number;
};

const categoryCount = (category: PlaceCategory) => ({ places, visited }: AchievementContext) =>
  places.filter((place) => place.category === category && visited.has(place.id)).length;
const total = ({ visited }: AchievementContext) => visited.size;
const regionCount = (needle: string) => ({ places, visited }: AchievementContext) =>
  places.filter((place) => visited.has(place.id) && place.region.toLocaleLowerCase().includes(needle)).length;

const definitions: Definition[] = [
  { id: "banana-slug-medal", name: "Banana Slug Medal", species: "banana-slug", description: "Complete both the West Coast Trail and Juan de Fuca Trail.", target: 2, count: ({ completedTrails }) => TRAILS.filter((trail) => completedTrails.has(trail.id)).length },
  { id: "black-bear-pair", name: "Black Bear Double", species: "black-bear", description: "Visit both national park reserves.", target: 2, count: ({ visited }) => ["national-gulf-islands-national-park-reserve", "national-pacific-rim-national-park-reserve"].filter((id) => visited.has(id)).length },
  { id: "sea-otter-islander", name: "Sea Otter Islander", species: "sea-otter", description: "Visit 5 major islands.", target: 5, count: categoryCount("island") },
  { id: "orca-four-realms", name: "Orca Four Realms", species: "orca", description: "Visit a national, provincial, regional park and a major island.", target: 4, count: ({ places, visited }) => new Set(places.filter((place) => visited.has(place.id)).map((place) => place.category)).size },
  { id: "river-otter-rookie", name: "River Otter Rookie", species: "river-otter", description: "Collect your first place.", target: 1, count: total },
  { id: "harbour-seal-five", name: "Harbour Seal High Five", species: "harbour-seal", description: "Visit 5 places.", target: 5, count: total },
  { id: "eagle-ten", name: "Bald Eagle Ten", species: "bald-eagle", description: "Visit 10 places.", target: 10, count: total },
  { id: "heron-twenty-five", name: "Heron’s Long Stride", species: "great-blue-heron", description: "Visit 25 places.", target: 25, count: total },
  { id: "kingfisher-fifty", name: "Kingfisher Fifty", species: "belted-kingfisher", description: "Visit 50 places.", target: 50, count: total },
  { id: "hummingbird-century", name: "Hummingbird Century", species: "rufous-hummingbird", description: "Visit 100 places.", target: 100, count: total },
  { id: "steller-regional", name: "Steller’s Jay Circuit", species: "stellers-jay", description: "Visit 10 regional parks.", target: 10, count: categoryCount("regional") },
  { id: "deer-provincial", name: "Black-tailed Deer Trail", species: "black-tailed-deer", description: "Visit 10 provincial parks.", target: 10, count: categoryCount("provincial") },
  { id: "red-squirrel-provincial", name: "Red Squirrel Cache", species: "red-squirrel", description: "Visit 25 provincial parks.", target: 25, count: categoryCount("provincial") },
  { id: "raccoon-islands", name: "Raccoon Archipelago", species: "raccoon", description: "Visit 10 major islands.", target: 10, count: categoryCount("island") },
  { id: "treefrog-capital", name: "Treefrog Capital Hop", species: "pacific-treefrog", description: "Visit 5 places in the Capital Region.", target: 5, count: regionCount("capital") },
  { id: "red-legged-cowichan", name: "Red-legged Cowichan Leap", species: "red-legged-frog", description: "Visit 3 places in Cowichan Valley.", target: 3, count: regionCount("cowichan") },
  { id: "douglas-fir-central", name: "Douglas-fir Heartwood", species: "douglas-fir", description: "Visit 8 places in Central Island.", target: 8, count: regionCount("central") },
  { id: "redcedar-west", name: "Western Redcedar Rainline", species: "western-redcedar", description: "Visit 5 places on the West Coast.", target: 5, count: regionCount("west coast") },
  { id: "arbutus-gulf", name: "Arbutus Gulf Glow", species: "arbutus", description: "Visit 5 places in the Gulf Islands.", target: 5, count: regionCount("gulf island") },
  { id: "salal-north", name: "Salal Northbound", species: "salal", description: "Visit 5 places in a northern region.", target: 5, count: regionCount("northern") },
  { id: "sword-fern-regional", name: "Sword Fern Steward", species: "sword-fern", description: "Visit 25 regional parks.", target: 25, count: categoryCount("regional") },
  { id: "camas-island", name: "Camas Island Bloom", species: "camas", description: "Visit 15 major islands.", target: 15, count: categoryCount("island") },
];

export function achievements(context: AchievementContext): Achievement[] {
  return definitions.map(({ count, target, ...definition }) => {
    const current = Math.min(count(context), target);
    return { ...definition, current, target, earned: current >= target };
  });
}
