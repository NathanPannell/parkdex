// Builds the mockup's park catalogue from the parkdex repo's verified place data.
// Output: src/data/parks.json (points + badge traits) and public/boundaries.geojson.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "..", "parkdex", "data");
const places = JSON.parse(readFileSync(join(source, "places.json"), "utf8"));
const boundaries = JSON.parse(readFileSync(join(source, "boundaries.geojson"), "utf8"));

const VICTORIA = [48.4284, -123.3656];

const BIOME_RULES = [
  ["waterfall", /falls/i],
  ["cave", /cave/i],
  ["heritage", /petroglyph|historic|colliery/i],
  ["marsh", /marsh|bog/i],
  ["lake", /lake/i],
  ["mountain", /mount|hill|ridge|escarpment|ski|plateau|alpine|massif|mountain|erskine/i],
  ["river", /river|creek|potholes|estuary|stream/i],
  ["coast", /\b(beach|bay|cove|spit|point|lagoon|harbour|inlet|passage|marine|sands|islands?|peninsula|arm|narrows|scott|rim|gulf|sea|flores|vargas|nuchatlitz|juan de fuca|sooke|landing|carmanah)\b/i],
];

// Hand-written copy for the parks a Victoria tester is most likely to reach first.
const BLURBS = {
  "regional-gonzales-hill-regional-park": "A pocket summit with a 360 view of the Olympics, Oak Bay and every ferry sliding past. Ten minutes up, zero excuses.",
  "regional-mill-hill-regional-park": "Garry oak meadows and a wildflower-lined climb to the Langford lookout. Spring here is ridiculous.",
  "regional-francis-king-regional-park": "Old-growth Douglas fir, cedar boardwalks and the kind of quiet that makes you whisper.",
  "regional-thetis-lake-regional-park": "Two lakes, cliff-jump rumours and a forest loop that ends in a swim. Summer's favourite badge.",
  "provincial-goldstream-park": "Salmon run, giant cedars and Niagara Falls (the little one). Go in November and bring a thermos.",
  "regional-elk-beaver-lake-regional-park": "A flat 10 km lap around twin lakes. Paddlers at dawn, joggers at noon, otters whenever they feel like it.",
  "regional-mount-work-regional-park": "Rocky bluffs, arbutus and the highest point in Saanich. The badge the locals brag about.",
  "regional-east-sooke-regional-park": "Wild coast, petroglyphs and a rugged cliffside trail. Seals watch you more than you watch them.",
  "regional-witty-s-lagoon-regional-park": "Sitting Lady Falls, a salt marsh full of herons and a sandy spit at the end. Three badges' worth of scenery.",
  "regional-island-view-beach-regional-park": "Long driftwood beach, sand dunes and a big-sky look at Mount Baker. Sunrise is the move.",
  "regional-albert-head-lagoon-regional-park": "A cobble beach with swans, a lagoon and pebbles that sing when the waves pull back.",
  "provincial-gowlland-tod-park": "Ridge trails high above Finlayson Arm. Earn this one with your calves.",
  "provincial-juan-de-fuca-park": "Tide pools, sea stacks and the start of a legendary marine trail. China Beach sunsets are unreal.",
  "provincial-french-beach-park": "Grey whales cruise past in spring. Pebble beach, big logs, bigger ocean.",
  "regional-matheson-lake-regional-park": "A calm, green-glass lake loop tucked into the Metchosin hills. Lily pads optional.",
  "regional-mount-wells-regional-park": "A short, steep scramble to a bald summit with a front-row seat over Sooke Hills.",
  "provincial-sooke-potholes-park": "Emerald pools carved in rock. The river does the sculpting, you do the swimming.",
  "regional-sooke-potholes-regional-park": "Emerald pools carved in rock. The river does the sculpting, you do the swimming.",
  "regional-horth-hill-regional-park": "A mossy forest climb to a view over the Gulf Islands. Short, sweet, badge-worthy.",
  "regional-lone-tree-hill-regional-park": "Yes, there is a lone tree. And a sweeping view of the Highlands to go with it.",
  "provincial-elk-falls-park": "A suspension bridge swinging over a 25 m waterfall. The Island's most photogenic wobble.",
  "provincial-little-qualicum-falls-park": "Tumbling falls in a deep canyon, and a lake for cooling off afterwards.",
  "provincial-rathtrevor-beach-park": "At low tide the beach goes on for a kilometre. Sandcastle territory.",
  "national-pacific-rim-national-park-reserve": "Surf, rainforest and Long Beach. The legendary badge of the West Coast.",
  "national-gulf-islands-national-park-reserve": "Arbutus bluffs and orca-watching headlands scattered across the islands. Island-hopper's grail.",
  "provincial-strathcona-park": "BC's oldest provincial park: glaciers, alpine lakes and Della Falls. A lifetime badge.",
  "provincial-cape-scott-park": "The wild northwest tip. Nels Bight's white sand takes a real trek to earn.",
  "provincial-horne-lake-caves-park": "Crawl, climb and squeeze through limestone caves. Headlamp required, grin guaranteed.",
  "provincial-petroglyph-park": "Ancient carvings in sandstone left by the Snuneymuxw people. Look closely and respectfully.",
};

const BIOME_BLURBS = {
  coast: "Salt air, driftwood and tide pools. Bring a jacket and look for seals.",
  forest: "Moss, big trees and trails that smell like rain. A classic Island badge.",
  mountain: "A climb with a view as the prize. Pack snacks and aim for the top.",
  lake: "Still water and shoreline trails. Perfect for a swim or a quiet paddle.",
  waterfall: "Follow the sound of rushing water to a cascade worth the walk.",
  river: "A river corridor of pools, rapids and shady banks.",
  cave: "Something wild waits underground. Bring a headlamp.",
  marsh: "Reeds, birdsong and boardwalks. Herons are the locals here.",
  heritage: "A place with deep history. Walk slowly and look closely.",
};

const hash = (s) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

const km = ([aLat, aLng], [bLat, bLng]) => {
  const r = Math.PI / 180;
  const x = (bLng - aLng) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};

const shortName = (name) =>
  name
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\b(Regional Park and Conservation Area|Regional Conservation Area|Regional Park|National Park Reserve|Marine Park|Nature Park|Historic Park|Provincial Park|Park)\b/g, "")
    .replace(/\s+a k a.*$/i, "")
    .trim();

const biomeOf = (name) => BIOME_RULES.find(([, re]) => re.test(name))?.[0] ?? "forest";

const shapeOf = (p) => {
  if (p.category === "national") return "seal";
  const options = p.category === "provincial" ? ["shield", "arch"] : ["circle", "hex"];
  return options[hash(p.id) % options.length];
};

const rarityOf = (p, distance) => {
  if (p.category === "national") return "legendary";
  if (distance > 250) return "epic";
  if (distance > 110) return "rare";
  if (distance > 35) return "uncommon";
  return "common";
};

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
};

// Thin dense rings so the whole island's boundaries stay a light download.
const thin = (ring) => {
  const step = Math.max(1, Math.floor(ring.length / 160));
  const out = ring.filter((_, i) => i % step === 0).map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
  out.push(out[0]);
  return out;
};

const outerRings = (geometry) =>
  geometry.type === "Polygon" ? [geometry.coordinates[0]] : geometry.coordinates.map((poly) => poly[0]);

const boundaryById = new Map(boundaries.features.map((f) => [f.properties.id, f]));
const parks = [];
const features = [];

for (const p of places) {
  if (p.category === "island") continue;
  const boundary = boundaryById.get(p.id);
  if (!boundary) continue;
  const distance = km(VICTORIA, [p.latitude, p.longitude]);
  const rings = outerRings(boundary.geometry)
    .filter((r) => ringArea(r) > 1e-7)
    .sort((a, b) => ringArea(b) - ringArea(a))
    .slice(0, 12)
    .map(thin);
  const biome = biomeOf(p.name);
  parks.push({
    id: p.id,
    name: p.name,
    short: shortName(p.name),
    category: p.category,
    region: p.region,
    lat: +p.latitude.toFixed(5),
    lng: +p.longitude.toFixed(5),
    biome,
    shape: shapeOf(p),
    rarity: rarityOf(p, distance),
    seed: hash(p.id) % 1000,
    blurb: BLURBS[p.id] ?? BIOME_BLURBS[biome],
  });
  features.push({
    type: "Feature",
    properties: { id: p.id, biome },
    geometry: { type: "MultiPolygon", coordinates: rings.map((r) => [r]) },
  });
}

writeFileSync(join(root, "src", "data", "parks.json"), JSON.stringify(parks));
writeFileSync(join(root, "public", "boundaries.geojson"), JSON.stringify({ type: "FeatureCollection", features }));
const tally = parks.reduce((t, p) => ({ ...t, [p.biome]: (t[p.biome] ?? 0) + 1 }), {});
console.log(`${parks.length} parks`, tally);
