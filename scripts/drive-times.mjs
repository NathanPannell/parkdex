// Precomputes driving distance and time from a few origin hubs to every park using the
// public OSRM demo router, so the app can estimate drive times fully offline.
// Also records how far the nearest drivable road is from each park boundary,
// which becomes the "final walk" estimate.
// Usage: node scripts/drive-times.mjs   (run after scripts/build-data.mjs)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const parks = JSON.parse(readFileSync(join(root, "src", "data", "parks.json"), "utf8"));
const boundaries = JSON.parse(readFileSync(join(root, "public", "boundaries.geojson"), "utf8"));
const byId = new Map(boundaries.features.map((f) => [f.properties.id, f.geometry]));

// Where visitors are likely to set out from. The app picks the best hub for the visitor's position.
const HUBS = [
  ["Downtown Victoria", -123.3656, 48.4284],
  ["Saanich", -123.3765, 48.4535],
  ["Oak Bay", -123.3137, 48.4263],
  ["Langford", -123.5058, 48.4497],
  ["Sidney", -123.3986, 48.6506],
  ["Sooke", -123.736, 48.374],
  ["Duncan", -123.7079, 48.7787],
  ["Nanaimo", -123.9401, 49.1659],
];
const CHUNK = 60;
const OSRM = process.env.OSRM_URL ?? "https://router.project-osrm.org";

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Metres from a road point to the park boundary (0 when the road is inside the park).
function toBoundaryM(point, geometry) {
  const polys = geometry.coordinates.map((p) => p[0]);
  if (polys.some((r) => inRing(point, r))) return 0;
  const kx = 111320 * Math.cos((point[1] * Math.PI) / 180);
  const ky = 110540;
  let best = Infinity;
  for (const ring of polys)
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = (ring[i][0] - point[0]) * kx;
      const ay = (ring[i][1] - point[1]) * ky;
      const dx = (ring[i + 1][0] - ring[i][0]) * kx;
      const dy = (ring[i + 1][1] - ring[i][1]) * ky;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  return best;
}

const out = { hubs: HUBS.map(([name, lng, lat]) => ({ name, lng, lat })), parks: {} };

for (let i = 0; i < parks.length; i += CHUNK) {
  const chunk = parks.slice(i, i + CHUNK);
  const coords = [...HUBS.map(([, lng, lat]) => [lng, lat]), ...chunk.map((p) => [p.lng, p.lat])];
  const sources = HUBS.map((_, k) => k).join(";");
  const destinations = chunk.map((_, k) => HUBS.length + k).join(";");
  const url = `${OSRM}/table/v1/driving/${coords.map((c) => c.join(",")).join(";")}?sources=${sources}&destinations=${destinations}&annotations=duration,distance`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.code !== "Ok") throw new Error(`OSRM ${json.code}: ${json.message}`);
  chunk.forEach((park, k) => {
    const snapped = json.destinations[k].location;
    const walkM = Math.round(toBoundaryM(snapped, byId.get(park.id)));
    out.parks[park.id] = {
      // [km, minutes] from each hub, in HUBS order; null when OSRM found no route (ferry-only).
      drive: HUBS.map((_, h) => {
        const d = json.distances[h][k];
        const t = json.durations[h][k];
        return d == null || t == null ? null : [+(d / 1000).toFixed(1), Math.round(t / 60)];
      }),
      walkM,
    };
  });
  console.log(`routed ${Math.min(i + CHUNK, parks.length)}/${parks.length}`);
  await new Promise((r) => setTimeout(r, 1200));
}

writeFileSync(join(root, "src", "data", "drive.json"), JSON.stringify(out));
const sample = [
  "regional-gonzales-hill-regional-park",
  "provincial-goldstream-park",
  "regional-east-sooke-regional-park",
  "national-pacific-rim-national-park-reserve",
];
for (const id of sample) console.log(id, JSON.stringify(out.parks[id].drive[0]), `walk ${out.parks[id].walkM} m`);
