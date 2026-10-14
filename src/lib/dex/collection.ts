import type { Park } from "../parks";
import type { PhotoCrop } from "../photoCrop";
import { compareProvinces, OTHER_PROVINCE, provinceFor } from "./regions";

/**
 * My Dex (#174): the parks a player has visited, grouped by province and region, with their own
 * photos as covers. Everything here is pure, so the screen only joins data and draws it.
 */

/** One park's visits as the server lists them (`GET /api/game/dex`). */
export type ServerDexPark = { parkId: string; days: string[]; firstVisitAt: string; lastVisitAt: string; hidden: boolean };

/** A claim saved on this device: an old claim, or a photo taken at a park. */
export type LocalDexClaim = { claimId: string; parkId: string; claimedAt: string; parkSnapshot: Park | null };

/** A photo saved on this device, with the player's display choices. */
export type DexPhoto = {
  claimId: string;
  parkId: string;
  claimedAt: string;
  blob: Blob;
  crop: PhotoCrop | null;
  coverAt: string | null;
  removed: boolean;
};

/** Everything My Dex knows about one visited park. */
export type DexVisit = {
  parkId: string;
  /** Distinct America/Vancouver days with a visit or a claim, oldest first. */
  days: string[];
  firstVisitAt: string;
  lastVisitAt: string;
  hidden: boolean;
  /** The park as it was when claimed, for parks no longer in the catalogue. */
  snapshot: Park | null;
};

export type DexTileImage = { kind: "photo"; photo: DexPhoto } | { kind: "badge" };

export type DexTile = {
  park: Park;
  visit: DexVisit | null;
  /** The photo shown on the tile, or null for the badge frame. */
  cover: DexPhoto | null;
  photos: DexPhoto[];
};

export type DexRegion = {
  /** Province and region, for the per-device collapsed state. */
  key: string;
  name: string;
  province: string;
  /** Visited parks counted in the totals: catalogue parks that are not hidden. */
  visited: number;
  total: number;
  tiles: DexTile[];
};

export type DexProvince = { name: string; visited: number; total: number; regions: DexRegion[] };

export type DexCollection = { provinces: DexProvince[]; visited: number; total: number; visits: number };

const VICTORIA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" });

/** The America/Vancouver calendar day of an instant, as the server counts visit days. */
export function victoriaDay(at: string): string {
  return VICTORIA_DAY.format(new Date(at));
}

/**
 * Joins the server's visits with the claims saved on this device, which may not be backed up
 * yet. One day counts once, so a photo taken during a visit never adds a visit.
 */
export function mergeVisits(server: readonly ServerDexPark[], claims: readonly LocalDexClaim[]): Map<string, DexVisit> {
  const visits = new Map<string, DexVisit>();
  const days = new Map<string, Set<string>>();
  const touch = (parkId: string, at: string, hidden: boolean, snapshot: Park | null, dayList: readonly string[]) => {
    const current = visits.get(parkId);
    const set = days.get(parkId) ?? new Set<string>();
    for (const day of dayList) set.add(day);
    days.set(parkId, set);
    if (!current) {
      visits.set(parkId, { parkId, days: [], firstVisitAt: at, lastVisitAt: at, hidden, snapshot });
      return;
    }
    if (Date.parse(at) < Date.parse(current.firstVisitAt)) current.firstVisitAt = at;
    if (Date.parse(at) > Date.parse(current.lastVisitAt)) current.lastVisitAt = at;
    current.hidden ||= hidden;
    current.snapshot ??= snapshot;
  };
  for (const park of server) {
    touch(park.parkId, park.firstVisitAt, park.hidden, null, park.days);
    touch(park.parkId, park.lastVisitAt, park.hidden, null, []);
  }
  for (const claim of claims) touch(claim.parkId, claim.claimedAt, false, claim.parkSnapshot, [victoriaDay(claim.claimedAt)]);
  for (const [parkId, visit] of visits) visit.days = [...(days.get(parkId) ?? [])].sort();
  return visits;
}

/** Photos the player has not removed, newest first. */
export function visiblePhotos(photos: readonly DexPhoto[]): DexPhoto[] {
  return photos.filter((photo) => !photo.removed)
    .sort((a, b) => Date.parse(b.claimedAt) - Date.parse(a.claimedAt) || b.claimId.localeCompare(a.claimId));
}

/** The cover: the photo most recently chosen as cover, otherwise the newest photo. */
export function coverPhoto(photos: readonly DexPhoto[]): DexPhoto | null {
  const shown = visiblePhotos(photos);
  const chosen = shown.filter((photo) => photo.coverAt)
    .sort((a, b) => Date.parse(b.coverAt!) - Date.parse(a.coverAt!))[0];
  return chosen ?? shown[0] ?? null;
}

/** What a tile shows: the player's cover photo, or the park's badge frame without one. */
export function tileImage(tile: Pick<DexTile, "cover">): DexTileImage {
  return tile.cover ? { kind: "photo", photo: tile.cover } : { kind: "badge" };
}

export type BuildCollectionInput = {
  /** Every park the catalogue shows, which leaves hidden parks out already. */
  parks: readonly Park[];
  visits: ReadonlyMap<string, DexVisit>;
  photos: readonly DexPhoto[];
  /** On: only visited parks, and empty regions are hidden. Off: every park. */
  onlyMine: boolean;
};

/**
 * Groups parks by province, then region. Totals count catalogue parks that are not hidden;
 * a visited park that is hidden or no longer in the catalogue still shows from its saved
 * snapshot but counts in no total. Visited parks come first, latest visit first.
 */
export function buildCollection({ parks, visits, photos, onlyMine }: BuildCollectionInput): DexCollection {
  const photosByPark = new Map<string, DexPhoto[]>();
  for (const photo of photos) photosByPark.set(photo.parkId, [...(photosByPark.get(photo.parkId) ?? []), photo]);
  const regions = new Map<string, DexRegion>();
  const regionFor = (park: Park) => {
    const province = provinceFor(park.region);
    const name = park.region?.trim() || OTHER_PROVINCE;
    const key = `${province}/${name}`;
    let region = regions.get(key);
    if (!region) {
      region = { key, name, province, visited: 0, total: 0, tiles: [] };
      regions.set(key, region);
    }
    return region;
  };
  const tileFor = (park: Park, visit: DexVisit | null): DexTile => {
    const parkPhotos = visit ? visiblePhotos(photosByPark.get(park.id) ?? []) : [];
    return { park, visit, cover: coverPhoto(parkPhotos), photos: parkPhotos };
  };

  const listed = new Set<string>();
  for (const park of parks) {
    listed.add(park.id);
    const visit = visits.get(park.id) ?? null;
    const counted = !visit?.hidden;
    const region = regionFor(park);
    if (counted) region.total += 1;
    if (visit && counted) region.visited += 1;
    if (visit || !onlyMine) region.tiles.push(tileFor(park, visit));
  }
  // Visited parks the catalogue no longer shows (hidden or retired) keep their saved snapshot.
  for (const visit of visits.values()) {
    if (listed.has(visit.parkId) || !visit.snapshot) continue;
    regionFor(visit.snapshot).tiles.push(tileFor(visit.snapshot, visit));
  }

  // Totals cover every region, including the empty ones "Only my visits" hides.
  const byProvince = new Map<string, DexRegion[]>();
  const totals = new Map<string, { visited: number; total: number }>();
  for (const region of regions.values()) {
    const sum = totals.get(region.province) ?? { visited: 0, total: 0 };
    sum.visited += region.visited;
    sum.total += region.total;
    totals.set(region.province, sum);
    if (onlyMine && region.tiles.length === 0) continue;
    region.tiles.sort((a, b) => {
      if (a.visit && b.visit) return Date.parse(b.visit.lastVisitAt) - Date.parse(a.visit.lastVisitAt) || a.park.name.localeCompare(b.park.name);
      if (a.visit || b.visit) return a.visit ? -1 : 1;
      return a.park.name.localeCompare(b.park.name);
    });
    byProvince.set(region.province, [...(byProvince.get(region.province) ?? []), region]);
  }
  const provinces = [...byProvince.entries()]
    .sort(([a], [b]) => compareProvinces(a, b))
    .map(([name, list]) => {
      const sorted = list.sort((a, b) => (a.name === OTHER_PROVINCE ? 1 : b.name === OTHER_PROVINCE ? -1 : a.name.localeCompare(b.name)));
      return { name, regions: sorted, ...totals.get(name)! };
    });
  let visitCount = 0;
  for (const visit of visits.values()) visitCount += visit.days.length;
  let visited = 0;
  let total = 0;
  for (const sum of totals.values()) {
    visited += sum.visited;
    total += sum.total;
  }
  return { provinces, visited, total, visits: visitCount };
}

/** "12 / 550 visited". */
export function visitedLabel(visited: number, total: number): string {
  return `${visited.toLocaleString("en-CA")} / ${total.toLocaleString("en-CA")} visited`;
}

/** "1 visit", "3 visits". */
export function visitCountLabel(count: number): string {
  return `${count} ${count === 1 ? "visit" : "visits"}`;
}
