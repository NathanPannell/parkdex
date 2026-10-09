import { HttpError } from "../../../worker/validation.js";
import { SHAPE_FOR_CATEGORY } from "../drafts.js";
import type { MultiPolygon } from "./geometry.js";
import type { LivePark, LiveParkChanges, LiveParkDetail, LiveParkStore } from "./liveParks.js";
import type { ParksDependencies } from "./routes.js";

/** In-memory park store for tests and the local demo server. Never used by a deployment. */

const LIVE_KEYS = ["name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "scene", "blurb"] as const;

export class MemoryLiveParkStore implements LiveParkStore {
  readonly parks = new Map<string, LivePark & { geometry: MultiPolygon | null }>();
  revision = 0;

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
    this.revision += 1;
    return this.revision;
  }
}

function square(lng: number, lat: number, size: number): MultiPolygon {
  return { type: "MultiPolygon", coordinates: [[[[lng - size, lat - size], [lng + size, lat - size], [lng + size, lat + size], [lng - size, lat + size], [lng - size, lat - size]]]] };
}

/** Fictional live parks so the section can be explored without a database. */
export function demoParks(): ParksDependencies {
  const live = new MemoryLiveParkStore();
  const samples: Array<[string, string, string, string, number, number, string, string]> = [
    ["beacon-hill-park", "Beacon Hill Park", "Beacon Hill", "municipal", -123.3632, 48.4136, "forest", "uncommon"],
    ["mount-douglas-park", "Mount Douglas Park", "Mount Doug", "regional", -123.3453, 48.4927, "mountain", "rare"],
    ["thetis-lake-park", "Thetis Lake Regional Park", "Thetis Lake", "regional", -123.4642, 48.4646, "lake", "uncommon"],
    ["cattle-point", "Cattle Point", "Cattle Point", "municipal", -123.2985, 48.4383, "coast", "common"],
  ];
  samples.forEach(([id, name, short, category, lng, lat, biome, rarity], index) => {
    live.parks.set(id, {
      id, name, short, category, region: index % 2 ? "Saanich" : "Capital", lat, lng, biome, shape: SHAPE_FOR_CATEGORY[category], rarity, scene: null, seed: 1000 + index,
      blurb: index === 0 ? "Gardens, ponds and a view across the strait to the Olympic Mountains." : "", geometry: square(lng, lat, 0.004 + index * 0.001),
    });
  });
  return { liveParkStore: () => live };
}
