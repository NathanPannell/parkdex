import { describe, expect, it } from "vitest";
import type { Park } from "../parks";
import { buildCollection, coverPhoto, mergeVisits, tileImage, victoriaDay, visiblePhotos, type DexPhoto, type ServerDexPark } from "./collection";
import { readCollapsed, readOnlyMine, storedOnlyMine, writeCollapsed, writeOnlyMine } from "./prefs";
import { compareProvinces, provinceFor } from "./regions";

function park(id: string, region: string, name = id): Park {
  return {
    id,
    name,
    short: name,
    category: "provincial",
    region,
    lat: 48.4,
    lng: -123.4,
    biome: "forest",
    shape: "circle",
    rarity: "common",
    seed: 1,
    blurb: "A park.",
    scene: null,
  };
}

function server(parkId: string, days: string[], hidden = false): ServerDexPark {
  return { parkId, days, firstVisitAt: `${days[0]}T18:00:00.000Z`, lastVisitAt: `${days[days.length - 1]}T18:00:00.000Z`, hidden };
}

function photo(claimId: string, parkId: string, claimedAt: string, extra: Partial<DexPhoto> = {}): DexPhoto {
  return { claimId, parkId, claimedAt, blob: new Blob([claimId]), crop: null, coverAt: null, removed: false, ...extra };
}

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const CATALOGUE = [
  park("a", "Capital Region", "Alder"),
  park("b", "Capital Region", "Birch"),
  park("c", "Kootenays", "Cedar"),
  park("d", "Halifax Metro", "Dogwood"),
  park("e", "Somewhere New", "Elm"),
];

describe("regions", () => {
  it("maps BC, island and Nova Scotia labels to their province, and anything else to Other", () => {
    expect(provinceFor("Southern Vancouver Island")).toBe("British Columbia");
    expect(provinceFor("Thompson & Okanagan")).toBe("British Columbia");
    expect(provinceFor("Capital Region")).toBe("British Columbia");
    expect(provinceFor(" discovery islands ")).toBe("British Columbia");
    expect(provinceFor("Cape Breton Island")).toBe("Nova Scotia");
    expect(provinceFor("Yarmouth and Acadian Shores")).toBe("Nova Scotia");
    expect(provinceFor("Mars")).toBe("Other");
    expect(provinceFor("")).toBe("Other");
    expect(["Other", "Nova Scotia", "Alberta", "British Columbia"].sort(compareProvinces)).toEqual(["British Columbia", "Nova Scotia", "Alberta", "Other"]);
  });
});

describe("mergeVisits", () => {
  it("counts each Victoria day once across server visits and claims on this device", () => {
    expect(victoriaDay("2026-06-02T06:30:00.000Z")).toBe("2026-06-01");
    const visits = mergeVisits(
      [server("a", ["2026-06-01", "2026-06-03"])],
      [
        // A photo on a visit day, and one on a new day that is not backed up yet.
        { claimId: "1", parkId: "a", claimedAt: "2026-06-03T20:00:00.000Z", parkSnapshot: null },
        { claimId: "2", parkId: "a", claimedAt: "2026-06-05T20:00:00.000Z", parkSnapshot: null },
        { claimId: "3", parkId: "c", claimedAt: "2026-05-01T20:00:00.000Z", parkSnapshot: CATALOGUE[2] },
      ],
    );
    expect(visits.get("a")).toMatchObject({
      days: ["2026-06-01", "2026-06-03", "2026-06-05"],
      firstVisitAt: "2026-06-01T18:00:00.000Z",
      lastVisitAt: "2026-06-05T20:00:00.000Z",
    });
    expect(visits.get("c")).toMatchObject({ days: ["2026-05-01"], snapshot: CATALOGUE[2] });
  });
});

describe("buildCollection", () => {
  const visits = mergeVisits(
    [server("a", ["2026-06-01"]), server("d", ["2026-06-02", "2026-06-04"])],
    [{ claimId: "x", parkId: "e", claimedAt: "2026-06-03T18:00:00.000Z", parkSnapshot: null }],
  );

  it("shows only visited parks by default, grouped by province then region, hiding empty regions", () => {
    const collection = buildCollection({ parks: CATALOGUE, visits, photos: [], onlyMine: readOnlyMine(new MemoryStorage()) });
    expect(collection.provinces.map((province) => province.name)).toEqual(["British Columbia", "Nova Scotia", "Other"]);
    const bc = collection.provinces[0];
    expect(bc.regions.map((region) => [region.name, region.visited, region.total, region.tiles.map((tile) => tile.park.id)])).toEqual([
      ["Capital Region", 1, 2, ["a"]],
    ]);
    // Kootenays has no visits, so it is hidden but still counted.
    expect(bc).toMatchObject({ visited: 1, total: 3 });
    expect(collection.provinces[2].regions[0]).toMatchObject({ name: "Somewhere New", visited: 1, total: 1 });
    expect(collection).toMatchObject({ visited: 3, total: 5, visits: 4 });
  });

  it("shows every park with the switch off, visited first, unvisited as their own tiles", () => {
    const collection = buildCollection({ parks: CATALOGUE, visits, photos: [], onlyMine: false });
    const capital = collection.provinces[0].regions.find((region) => region.name === "Capital Region")!;
    expect(capital.tiles.map((tile) => [tile.park.id, !!tile.visit])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(collection.provinces[0].regions.map((region) => region.name)).toEqual(["Capital Region", "Kootenays"]);
  });

  it("leaves hidden parks out of totals but keeps showing a visited one from its snapshot", () => {
    const hiddenPark = park("h", "Kootenays", "Hemlock");
    const withHidden = mergeVisits(
      [server("a", ["2026-06-01"]), server("h", ["2026-06-01"], true), server("gone", ["2026-06-01"])],
      [{ claimId: "y", parkId: "h", claimedAt: "2026-06-01T18:00:00.000Z", parkSnapshot: hiddenPark }],
    );
    // The catalogue leaves hidden parks out; a park the server marks hidden is never counted.
    const collection = buildCollection({
      parks: [...CATALOGUE, park("s", "Kootenays", "Stale")],
      visits: new Map([...withHidden, ["s", { ...withHidden.get("a")!, parkId: "s", hidden: true }]]),
      photos: [],
      onlyMine: true,
    });
    const kootenays = collection.provinces[0].regions.find((region) => region.name === "Kootenays")!;
    expect(kootenays.tiles.map((tile) => tile.park.id).sort()).toEqual(["h", "s"]);
    expect(kootenays).toMatchObject({ visited: 0, total: 1 });
    expect(collection.visited).toBe(1);
    // A visit to a park with no catalogue entry and no saved snapshot has nothing to draw.
    expect(
      collection.provinces
        .flatMap((province) => province.regions)
        .flatMap((region) => region.tiles)
        .some((tile) => tile.park.id === "gone"),
    ).toBe(false);
  });

  it("puts several photos per park on its tile and picks the cover", () => {
    const photos = [
      photo("p1", "a", "2026-06-01T18:00:00.000Z"),
      photo("p2", "a", "2026-06-03T18:00:00.000Z"),
      photo("p3", "a", "2026-06-04T18:00:00.000Z", { removed: true }),
      photo("p4", "b", "2026-06-04T18:00:00.000Z"),
    ];
    const collection = buildCollection({ parks: CATALOGUE, visits, photos, onlyMine: false });
    const capital = collection.provinces[0].regions[0];
    const alder = capital.tiles.find((tile) => tile.park.id === "a")!;
    expect(alder.photos.map((item) => item.claimId)).toEqual(["p2", "p1"]);
    expect(alder.cover?.claimId).toBe("p2");
    expect(tileImage(alder)).toEqual({ kind: "photo", photo: alder.photos[0] });
    // An unvisited park never shows a stray photo.
    expect(tileImage(capital.tiles.find((tile) => tile.park.id === "b")!)).toEqual({ kind: "badge" });
  });
});

describe("cover selection", () => {
  it("uses the latest chosen cover, else the newest photo, and never a removed one", () => {
    const old = photo("old", "a", "2026-06-01T18:00:00.000Z", { coverAt: "2026-06-05T10:00:00.000Z" });
    const newer = photo("newer", "a", "2026-06-03T18:00:00.000Z", { coverAt: "2026-06-04T10:00:00.000Z" });
    const newest = photo("newest", "a", "2026-06-06T18:00:00.000Z");
    expect(coverPhoto([newest, newer, old])?.claimId).toBe("old");
    expect(coverPhoto([newest, newer])?.claimId).toBe("newer");
    expect(coverPhoto([photo("1", "a", "2026-06-01T18:00:00.000Z"), newest])?.claimId).toBe("newest");
    expect(coverPhoto([{ ...old, removed: true }, newest])?.claimId).toBe("newest");
    expect(coverPhoto([{ ...old, removed: true }])).toBeNull();
    expect(visiblePhotos([old, newest, newer]).map((item) => item.claimId)).toEqual(["newest", "newer", "old"]);
    expect(tileImage({ cover: null })).toEqual({ kind: "badge" });
  });
});

describe("per-device choices", () => {
  it("follows the player's progress until they choose, then remembers the switch and collapsed regions", () => {
    const storage = new MemoryStorage();
    expect(storedOnlyMine(storage)).toBeNull();
    expect(readOnlyMine(storage)).toBe(true);
    expect(readOnlyMine(storage, false)).toBe(false);
    expect(readOnlyMine(null)).toBe(true);
    writeOnlyMine(true, storage);
    expect(readOnlyMine(storage, false)).toBe(true);
    writeOnlyMine(false, storage);
    expect(readOnlyMine(storage)).toBe(false);
    writeOnlyMine(true, storage);
    expect(readOnlyMine(storage)).toBe(true);
    expect([...readCollapsed(storage)]).toEqual([]);
    writeCollapsed(new Set(["British Columbia/Kootenays"]), storage);
    expect([...readCollapsed(storage)]).toEqual(["British Columbia/Kootenays"]);
    storage.setItem("parkdex-dex-collapsed", "not json");
    expect([...readCollapsed(storage)]).toEqual([]);
  });
});
