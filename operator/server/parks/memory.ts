import type { OsmFeature, OsmRef } from "../../../worker/osmParks.js";
import type { PublishablePark } from "../../../worker/parkPublish.js";
import { HttpError } from "../../../worker/validation.js";
import { SHAPE_FOR_CATEGORY } from "../drafts.js";
import type { MultiPolygon } from "./geometry.js";
import type { LivePark, LiveParkChanges, LiveParkDetail, LiveParkStore } from "./liveParks.js";
import { grow, HISTORY_LIMIT, OUTLINE_LIMIT, sourceOf, type Bbox, type ChangeRow, type CoverInput, type CoverPhoto, type HiddenState, type ParkActivity, type ParkManagerStore, type ParkRow, type ParkStats } from "./manager.js";
import type { CatalogueNeighbour, OsmStore } from "./osm.js";
import type { ParksDependencies } from "./routes.js";

/** In-memory park stores for tests and the local demo server. Never used by a deployment. */

const LIVE_KEYS = ["name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "scene", "blurb"] as const;
type StoredPark = LivePark & { geometry: MultiPolygon | null };

export class MemoryLiveParkStore implements LiveParkStore {
  readonly parks = new Map<string, StoredPark>();
  /** Content changes, oldest first, as the content triggers would record them. */
  readonly changes: (ChangeRow & { entityId: string })[] = [];
  revision = 0;

  /** One content revision with the given changes, like one database transaction. */
  commit(entries: { entity: ChangeRow["entity"]; id: string; operation: ChangeRow["operation"]; value?: Record<string, unknown> | null }[], at = new Date().toISOString()): number {
    this.revision += 1;
    for (const entry of entries) {
      this.changes.push({ revision: this.revision, at, entity: entry.entity, entityId: entry.id, operation: entry.operation, value: entry.entity === "park" && entry.operation === "upsert" ? entry.value ?? null : null });
    }
    return this.revision;
  }

  parkValue(id: string): Record<string, unknown> {
    const { geometry: _geometry, ...park } = this.parks.get(id)!;
    return { ...park };
  }

  async list(): Promise<LivePark[]> {
    return [...this.parks.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ geometry: _geometry, ...park }) => structuredClone(park));
  }

  async regions(): Promise<string[]> {
    return [...new Set([...this.parks.values()].map((park) => park.region).filter(Boolean))].sort();
  }

  async get(id: string): Promise<LiveParkDetail | null> {
    const park = this.parks.get(id);
    return park ? structuredClone(park) : null;
  }

  async update(id: string, expected: LivePark, changes: LiveParkChanges) {
    const park = this.parks.get(id);
    if (!park || LIVE_KEYS.some((key) => park[key] !== expected[key])) {
      throw new HttpError(409, "park_changed", "This park changed since you opened it. Reload it and make your edit again.");
    }
    const { geometry, ...fields } = changes;
    Object.assign(park, fields);
    if (changes.category && changes.category !== expected.category) park.shape = SHAPE_FOR_CATEGORY[changes.category] ?? park.shape;
    if (geometry) park.geometry = geometry;
    const entries: Parameters<MemoryLiveParkStore["commit"]>[0] = [{ entity: "park", id, operation: "upsert", value: this.parkValue(id) }];
    if (geometry || park.biome !== expected.biome) entries.push({ entity: "boundary", id, operation: "upsert" });
    return this.commit(entries);
  }
}

export interface MemoryFounder {
  handle: string | null;
  foundedAt: string;
  source: "osm_new" | "existing";
  photo: CoverPhoto;
  width: number;
  height: number;
}

export interface MemoryVisit {
  parkId: string;
  accountId: string;
  visitedAt: string;
}

export interface MemoryTenure {
  parkId: string;
  handle: string | null;
  startedAt: string;
  lastVisitAt: string;
  endedAt: string | null;
}

const FALL_MS = 720 * 3_600_000;

/** Hiding, deleting and founder moderation over the same parks as MemoryLiveParkStore. */
export class MemoryParkManagerStore implements ParkManagerStore {
  readonly hidden = new Map<string, HiddenState>();
  readonly legacy = new Set<string>();
  readonly proposals = new Set<string>();
  readonly founders = new Map<string, MemoryFounder>();
  readonly enrichment = new Set<string>();
  visits: MemoryVisit[] = [];
  tenures: MemoryTenure[] = [];
  osmOutlines = 0;
  osmNotInParkdex = 0;
  osmSourceDate: string | null = null;

  constructor(readonly live: MemoryLiveParkStore) {}

  private park(id: string): StoredPark {
    const park = this.live.parks.get(id);
    if (!park) throw new HttpError(404, "not_found", "That park is not in Parkdex.");
    return park;
  }

  private tombstones(id: string) {
    return (["park", "boundary", "drive"] as const).map((entity) => ({ entity, id, operation: "delete" as const }));
  }

  async rows(): Promise<ParkRow[]> {
    const visits = new Map<string, number>();
    for (const visit of this.visits) visits.set(visit.parkId, (visits.get(visit.parkId) ?? 0) + 1);
    return [...this.live.parks.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((park) => {
      const founder = this.founders.get(park.id);
      return {
        id: park.id, name: park.name, short: park.short, category: park.category, region: park.region, lat: park.lat, lng: park.lng,
        biome: park.biome, rarity: park.rarity, source: sourceOf(park.id, this.legacy.has(park.id), this.proposals.has(park.id)),
        hidden: this.hidden.get(park.id) ?? null,
        founder: founder ? { handle: founder.handle, foundedAt: founder.foundedAt, photoSha256: founder.photo.sha256 } : null,
        visits: visits.get(park.id) ?? 0,
      };
    });
  }

  async stats(): Promise<ParkStats> {
    const total = this.live.parks.size;
    const hidden = [...this.hidden.keys()].filter((id) => this.live.parks.has(id)).length;
    return { live: total - hidden, hidden, founded: this.founders.size, osmOutlines: this.osmOutlines, osmNotInParkdex: this.osmNotInParkdex, osmSourceDate: this.osmSourceDate };
  }

  async outlines(bbox: Bbox) {
    const box = grow(bbox);
    return [...this.live.parks.values()]
      .filter((park) => park.geometry && park.lat >= box.south && park.lat <= box.north && park.lng >= box.west && park.lng <= box.east)
      .slice(0, OUTLINE_LIMIT)
      .map((park) => ({ id: park.id, category: park.category, hidden: this.hidden.has(park.id), geometry: structuredClone(park.geometry!) }));
  }

  async activity(id: string, now: string): Promise<ParkActivity | null> {
    if (!this.live.parks.has(id)) return null;
    const at = Date.parse(now);
    const visits = this.visits.filter((visit) => visit.parkId === id);
    const open = this.tenures.find((tenure) => tenure.parkId === id && tenure.endedAt === null);
    const founder = this.founders.get(id);
    return {
      source: sourceOf(id, this.legacy.has(id), this.proposals.has(id)),
      hidden: this.hidden.get(id) ?? null,
      founder: founder ? {
        handle: founder.handle, foundedAt: founder.foundedAt, source: founder.source, photoSha256: founder.photo.sha256,
        photoWidth: founder.width, photoHeight: founder.height, photoBytes: founder.photo.bytes.byteLength,
      } : null,
      visits: {
        total: visits.length,
        last30Days: visits.filter((visit) => at - Date.parse(visit.visitedAt) < 30 * 86_400_000).length,
        uniquePlayers: new Set(visits.map((visit) => visit.accountId)).size,
      },
      flag: open ? {
        handle: open.handle, since: open.startedAt, lastVisitAt: open.lastVisitAt,
        fallsAt: new Date(Date.parse(open.lastVisitAt) + FALL_MS).toISOString(), up: Date.parse(open.lastVisitAt) + FALL_MS > at,
      } : null,
      tenures: this.tenures.filter((tenure) => tenure.parkId === id).length,
      history: this.live.changes.filter((change) => change.entityId === id && change.entity !== "asset").reverse().slice(0, HISTORY_LIMIT)
        .map(({ entityId: _entityId, ...change }) => structuredClone(change)),
    };
  }

  async hide(id: string, reason: string) {
    this.park(id);
    if (this.hidden.has(id)) throw new HttpError(409, "already_hidden", "This park is already hidden. Reload to see its current state.");
    this.hidden.set(id, { reason, source: "operator", hiddenAt: new Date().toISOString() });
    return this.live.commit(this.tombstones(id));
  }

  async unhide(id: string) {
    this.park(id);
    if (!this.hidden.has(id)) throw new HttpError(409, "not_hidden", "This park is not hidden. Reload to see its current state.");
    this.hidden.delete(id);
    return this.live.commit([
      { entity: "park", id, operation: "upsert", value: this.live.parkValue(id) },
      { entity: "boundary", id, operation: "upsert" },
      { entity: "drive", id, operation: "upsert" },
    ]);
  }

  async remove(id: string) {
    this.park(id);
    if (this.enrichment.has(id)) throw new HttpError(409, "park_in_enrichment", "This park is in the art enrichment queue, so it cannot be deleted. Hide it instead.");
    this.live.parks.delete(id);
    this.hidden.delete(id);
    this.legacy.delete(id);
    this.founders.delete(id);
    return this.live.commit(this.tombstones(id));
  }

  async clearFounder(id: string) {
    if (!this.founders.delete(id)) throw new HttpError(404, "no_founder", "This park has no founder.");
  }

  async replaceCover(id: string, photo: CoverInput) {
    const founder = this.founders.get(id);
    if (!founder) throw new HttpError(404, "no_founder", "This park has no founder, so it has no cover to replace.");
    founder.photo = { bytes: Uint8Array.from(atob(photo.base64), (char) => char.charCodeAt(0)), contentType: "image/jpeg", sha256: photo.sha256 };
    founder.width = photo.width;
    founder.height = photo.height;
  }

  async cover(id: string) {
    return this.founders.get(id)?.photo ?? null;
  }
}

function boxOf(geometry: MultiPolygon): Bbox {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const polygon of geometry.coordinates) for (const ring of polygon) for (const [lng, lat] of ring) {
    west = Math.min(west, lng); east = Math.max(east, lng); south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return { west, south, east, north };
}

/** OpenStreetMap outlines and publishing for tests and the demo. */
export class MemoryOsmStore implements OsmStore {
  readonly features: OsmFeature[] = [];

  constructor(readonly live: MemoryLiveParkStore, readonly manager: MemoryParkManagerStore) {}

  async inBox(bbox: Bbox, limit: number) {
    return this.features.filter((feature) => {
      const box = boxOf(feature.geometry);
      return box.west <= bbox.east && box.east >= bbox.west && box.south <= bbox.north && box.north >= bbox.south;
    }).sort((a, b) => a.areaM2 - b.areaM2).slice(0, limit).map((feature) => structuredClone(feature));
  }

  async feature(ref: OsmRef) {
    const found = this.features.find((feature) => feature.type === ref.type && feature.id === ref.id);
    return found ? structuredClone(found) : null;
  }

  async catalogue(bbox: Bbox): Promise<CatalogueNeighbour[]> {
    return [...this.live.parks.values()]
      .filter((park) => park.lat >= bbox.south && park.lat <= bbox.north && park.lng >= bbox.west && park.lng <= bbox.east)
      .map((park) => ({ id: park.id, name: park.name, region: park.region, lat: park.lat, lng: park.lng, boundary: park.geometry }));
  }

  async publish(park: PublishablePark) {
    if (this.live.parks.has(park.id)) throw new HttpError(409, "already_in_parkdex", "This outline is already a Parkdex park.");
    this.live.parks.set(park.id, {
      id: park.id, name: park.name, short: park.short, category: park.category, region: park.region, lat: park.lat, lng: park.lng,
      biome: park.biome, shape: park.shape, rarity: park.rarity, scene: null, seed: park.seed, blurb: park.blurb, geometry: park.geometry,
    });
    return this.live.commit([
      { entity: "park", id: park.id, operation: "upsert", value: this.live.parkValue(park.id) },
      { entity: "boundary", id: park.id, operation: "upsert" },
      { entity: "drive", id: park.id, operation: "upsert" },
    ]);
  }
}

/** One set of memory stores that share their parks. */
export function memoryParks() {
  const live = new MemoryLiveParkStore();
  const manager = new MemoryParkManagerStore(live);
  const osm = new MemoryOsmStore(live, manager);
  const dependencies: ParksDependencies = { liveParkStore: () => live, parkManagerStore: () => manager, osmStore: () => osm };
  return { live, manager, osm, dependencies };
}

// ---------------------------------------------------------------- demo data

/** An irregular outline around a point, so the demo map does not look like a grid of squares. */
function blob(lng: number, lat: number, radiusM: number, seed: number, sides = 9): MultiPolygon {
  const ring: [number, number][] = [];
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180), ky = 110_540;
  for (let index = 0; index < sides; index += 1) {
    const angle = (index / sides) * Math.PI * 2;
    const wobble = 0.72 + 0.28 * Math.abs(Math.sin(seed * 7.3 + index * 2.1));
    ring.push([
      Math.round((lng + (Math.cos(angle) * radiusM * wobble) / kx) * 1e6) / 1e6,
      Math.round((lat + (Math.sin(angle) * radiusM * wobble * 0.8) / ky) * 1e6) / 1e6,
    ]);
  }
  ring.push(ring[0]);
  return { type: "MultiPolygon", coordinates: [[ring]] };
}

/** A small landscape card in place of a founder's photo, so the demo needs no image files. */
function demoCover(seed: number): CoverPhoto {
  const hues = [[150, 200], [28, 205], [95, 190], [190, 45], [130, 215]][seed % 5];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hues[1]} 70% 78%)"/><stop offset="1" stop-color="hsl(${hues[1] - 20} 60% 92%)"/></linearGradient></defs>
<rect width="640" height="420" fill="url(#s)"/><circle cx="${470 - seed * 23}" cy="96" r="38" fill="hsl(45 95% 70%)"/>
<path d="M0 290 L120 180 L230 270 L350 150 L470 260 L640 170 L640 420 L0 420 Z" fill="hsl(${hues[0]} 28% 48%)"/>
<path d="M0 330 Q160 270 320 320 T640 300 L640 420 L0 420 Z" fill="hsl(${hues[0]} 45% 34%)"/>
${Array.from({ length: 9 }, (_, index) => `<path d="M${40 + index * 68} 360 l16 -52 l16 52 z" fill="hsl(${hues[0]} 50% ${22 + (index % 3) * 4}%)"/>`).join("")}
</svg>`;
  const bytes = new TextEncoder().encode(svg);
  let hash = 0;
  for (const byte of bytes) hash = (Math.imul(hash, 31) + byte) >>> 0;
  return { bytes, contentType: "image/svg+xml", sha256: hash.toString(16).padStart(8, "0").repeat(8) };
}

type DemoPark = [id: string, name: string, category: string, region: string, lng: number, lat: number, biome: string, rarity: string, radiusM: number];

const DEMO_PARKS: DemoPark[] = [
  ["beacon-hill-park", "Beacon Hill Park", "municipal", "Capital", -123.3632, 48.4136, "forest", "uncommon", 520],
  ["mount-douglas-park", "Mount Douglas Park", "municipal", "Saanich", -123.3453, 48.4927, "mountain", "rare", 700],
  ["thetis-lake-park", "Thetis Lake Regional Park", "regional", "Capital", -123.4642, 48.4646, "lake", "uncommon", 1100],
  ["cattle-point", "Cattle Point", "municipal", "Oak Bay", -123.2985, 48.4383, "coast", "common", 180],
  ["mount-tolmie-park", "Mount Tolmie Park", "municipal", "Saanich", -123.3258, 48.4589, "mountain", "common", 260],
  ["elk-beaver-lake", "Elk/Beaver Lake Regional Park", "regional", "Capital", -123.3936, 48.5236, "lake", "rare", 1500],
  ["goldstream-park", "Goldstream Provincial Park", "provincial", "Capital", -123.5545, 48.4794, "river", "epic", 1600],
  ["east-sooke-park", "East Sooke Regional Park", "regional", "Capital", -123.6608, 48.3487, "coast", "rare", 2000],
  ["fort-rodd-hill", "Fort Rodd Hill", "national", "Capital", -123.4598, 48.4337, "heritage", "legendary", 420],
  ["gonzales-beach", "Gonzales Beach Park", "community", "Capital", -123.3236, 48.4127, "coast", "common", 120],
  ["cuthbert-holmes-park", "Cuthbert Holmes Park", "municipal", "Saanich", -123.4067, 48.4687, "river", "common", 380],
  ["francis-king-park", "Francis/King Regional Park", "regional", "Capital", -123.4508, 48.4952, "forest", "uncommon", 760],
  ["newcastle-island", "Newcastle Island Marine Park", "provincial", "Nanaimo", -123.9273, 49.1806, "coast", "rare", 900],
  ["pipers-lagoon", "Pipers Lagoon Park", "municipal", "Nanaimo", -123.9548, 49.2234, "coast", "common", 260],
  ["osm-way-24051833", "Summit Park", "municipal", "Capital", -123.3567, 48.4441, "mountain", "common", 240],
  ["osm-way-39912017", "Swan Lake Nature Sanctuary", "municipal", "Saanich", -123.3812, 48.4672, "marsh", "uncommon", 420],
  ["osm-relation-6012450", "Highrock Park", "municipal", "Capital", -123.4205, 48.4426, "mountain", "common", 200],
  ["proposed-uplands-park", "Uplands Park", "municipal", "Oak Bay", -123.2952, 48.4459, "forest", "common", 300],
];

/** Fictional live parks, visits, founders and OSM outlines so the section can be explored without a database. */
export function demoParks(): ParksDependencies {
  const { live, manager, osm, dependencies } = memoryParks();
  const now = Date.now();
  const ago = (days: number, hours = 0) => new Date(now - days * 86_400_000 - hours * 3_600_000).toISOString();
  DEMO_PARKS.forEach(([id, name, category, region, lng, lat, biome, rarity, radiusM], index) => {
    live.parks.set(id, {
      id, name, short: name.replace(/\s+(Regional|Provincial|Marine|Nature)?\s*(Park|Sanctuary)$/i, "").trim() || name, category, region, lat, lng, biome,
      shape: SHAPE_FOR_CATEGORY[category], rarity, scene: null, seed: 1000 + index * 37,
      blurb: index === 0 ? "Gardens, ponds and a view across the strait to the Olympic Mountains." : index % 3 === 0 ? "" : `${name} in ${region}.`,
      geometry: blob(lng, lat, radiusM, index),
    });
    live.commit([
      { entity: "park", id, operation: "upsert", value: live.parkValue(id) },
      { entity: "boundary", id, operation: "upsert" },
      { entity: "drive", id, operation: "upsert" },
    ], ago(60 - index, index));
  });
  // A later description fix, so the history shows more than the first publication.
  live.parks.get("beacon-hill-park")!.blurb = "Gardens, ponds, peacocks and a view across the strait to the Olympic Mountains.";
  live.commit([{ entity: "park", id: "beacon-hill-park", operation: "upsert", value: live.parkValue("beacon-hill-park") }], ago(9, 4));

  manager.legacy.add("newcastle-island").add("pipers-lagoon");
  manager.proposals.add("proposed-uplands-park");
  manager.hidden.set("pipers-lagoon", { reason: "Legacy BC municipal and community parks are hidden for now.", source: "category", hiddenAt: ago(2) });
  manager.hidden.set("gonzales-beach", { reason: "Beach access closed for shoreline repairs.", source: "operator", hiddenAt: ago(5, 3) });
  live.commit([{ entity: "park", id: "gonzales-beach", operation: "delete" }, { entity: "boundary", id: "gonzales-beach", operation: "delete" }, { entity: "drive", id: "gonzales-beach", operation: "delete" }], ago(5, 3));
  manager.enrichment.add("fort-rodd-hill");

  const founders: Array<[string, string, number, "osm_new" | "existing"]> = [
    ["osm-way-24051833", "summit_sam", 6, "osm_new"],
    ["osm-way-39912017", "marsh_wren", 11, "osm_new"],
    ["osm-relation-6012450", "rocky_r", 3, "osm_new"],
    ["mount-tolmie-park", "kip_fan_22", 14, "existing"],
    ["cattle-point", "tidepool_t", 1, "existing"],
  ];
  founders.forEach(([parkId, handle, days, source], index) => {
    manager.founders.set(parkId, { handle, foundedAt: ago(days, index * 2), source, photo: demoCover(index), width: 1280, height: 840 });
  });

  const handles = ["summit_sam", "marsh_wren", "rocky_r", "kip_fan_22", "tidepool_t", "trail_tia", "fern_gully", "owl_eyes"];
  DEMO_PARKS.forEach(([id], index) => {
    const count = Math.round(Math.abs(Math.sin(index * 1.7 + 0.4)) * 46) + (index < 3 ? 30 : 0);
    for (let visit = 0; visit < count; visit += 1) {
      manager.visits.push({ parkId: id, accountId: `demo-${(visit * 7 + index * 3) % 23}`, visitedAt: ago((visit * 5 + index) % 75, visit % 12) });
    }
    if (count > 8 && index % 4 !== 3) {
      const holder = handles[(index * 3) % handles.length];
      manager.tenures.push({ parkId: id, handle: handles[(index + 1) % handles.length], startedAt: ago(40, index), lastVisitAt: ago(33, index), endedAt: ago(20, index) });
      manager.tenures.push({ parkId: id, handle: holder, startedAt: ago(20, index), lastVisitAt: ago(index === 5 ? 31 : index % 9, 2), endedAt: null });
    }
  });

  // OpenStreetMap outlines: most demo parks have one, plus parks that are not in Parkdex yet.
  let osmId = 51_000_000;
  for (const [id, name, , , lng, lat, , , radiusM] of DEMO_PARKS) {
    if (id === "proposed-uplands-park") continue;
    const ref = /^osm-(way|relation)-(\d+)$/.exec(id);
    osm.features.push({
      type: (ref?.[1] as "way" | "relation") ?? "way", id: ref ? Number(ref[2]) : osmId += 17, name, kind: "leisure=park",
      tags: { leisure: "park", name }, geometry: blob(lng + 0.0004, lat - 0.0003, radiusM * 0.95, osmId), areaM2: Math.round(Math.PI * radiusM * radiusM * 0.7),
    });
  }
  const missing: Array<[string | null, string, number, number, number, Record<string, string>]> = [
    ["Gonzales Hill Regional Park", "leisure=park", -123.3227, 48.4199, 180, { leisure: "park", operator: "Capital Regional District" }],
    ["Hollywood Park", "leisure=park", -123.3278, 48.4187, 110, { leisure: "park" }],
    ["Glenlyon Garden", "leisure=garden", -123.3336, 48.4369, 70, { leisure: "garden" }],
    ["Haliburton Farm", "landuse=recreation_ground", -123.3725, 48.5011, 160, { landuse: "recreation_ground" }],
    ["Panama Flats", "leisure=nature_reserve", -123.4021, 48.4847, 520, { leisure: "nature_reserve" }],
    ["Royal Roads Woods", "boundary=protected_area", -123.4888, 48.4344, 640, { boundary: "protected_area", protection_title: "Park" }],
    ["Layritz Park", "leisure=park", -123.4071, 48.4934, 330, { leisure: "park" }],
    ["Lochside Dog Park", "leisure=dog_park", -123.3741, 48.4806, 90, { leisure: "dog_park" }],
    ["Rogers Elementary Field", "leisure=recreation_ground", -123.3598, 48.4706, 120, { leisure: "recreation_ground" }],
    ["Mill Hill Regional Park", "leisure=park", -123.4912, 48.4542, 520, { leisure: "park", operator: "CRD" }],
    [null, "leisure=park", -123.3489, 48.4561, 70, { leisure: "park" }],
    ["Bowker Creek Greenway", "leisure=park", -123.3359, 48.4462, 140, { leisure: "park" }],
    ["Pacific Rim Nature Reserve", "leisure=nature_reserve", -123.5021, 48.3992, 900, { leisure: "nature_reserve" }],
  ];
  missing.forEach(([name, kind, lng, lat, radiusM, tags], index) => {
    osm.features.push({
      type: index % 4 === 3 ? "relation" : "way", id: (osmId += 29), name, kind, tags: name ? { ...tags, name } : tags,
      geometry: blob(lng, lat, radiusM, index + 40, 7 + (index % 4)), areaM2: Math.round(Math.PI * radiusM * radiusM * 0.7),
    });
  });

  // The whole BC table is far bigger than the demo layer; the totals say so.
  manager.osmOutlines = 13_856;
  manager.osmNotInParkdex = 12_131;
  manager.osmSourceDate = "2026-10-05T20:21:03.000Z";
  return dependencies;
}
