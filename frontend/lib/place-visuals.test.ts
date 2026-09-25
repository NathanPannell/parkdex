import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPlaceVisualIndexCache,
  loadPlaceVisualIndex,
  parsePlaceVisualIndex,
  placeVisualAssetUrls,
  placeVisualIndexUrl,
  type PlaceVisualEntry,
} from "./place-visuals";

const placeId = "provincial-juan-de-fuca-park";
const entry: PlaceVisualEntry = {
  placeId,
  satellite: `${placeId}/satellite.avif`,
  relief: `${placeId}/relief.avif`,
  model: `${placeId}/${placeId}-terrain.glb`,
  attribution: ["Contains modified Copernicus Sentinel data 2025"],
  acquired: ["2025-06-01"],
  needsReview: false,
  reviewFlags: [],
};

function indexWith(...entries: Record<string, unknown>[]) {
  return {
    version: 1,
    places: Object.fromEntries(entries.map((value) => [String(value.placeId), value])),
  };
}

afterEach(() => clearPlaceVisualIndexCache());

describe("place visual index", () => {
  it("accepts schema version 1 and normalizes null review flags", () => {
    const parsed = parsePlaceVisualIndex({
      version: 1,
      places: { [placeId]: { ...entry, reviewFlags: null } },
    });

    expect(parsed.get(placeId)).toEqual({ ...entry, reviewFlags: [] });
  });

  it("preserves only the recognized boundary-free render mode", () => {
    const legacy = parsePlaceVisualIndex({ version: 1, places: { [placeId]: entry } });
    const pointCentered = parsePlaceVisualIndex({
      version: 1,
      places: { [placeId]: { ...entry, renderMode: "point-centered-boundary-free" } },
    });
    const unknown = parsePlaceVisualIndex({
      version: 1,
      places: { [placeId]: { ...entry, renderMode: "point-centered" } },
    });

    expect(legacy.get(placeId)).toEqual(entry);
    expect(pointCentered.get(placeId)?.renderMode).toBe("point-centered-boundary-free");
    expect(unknown.has(placeId)).toBe(false);
  });

  it("rejects an unsupported version and skips unsafe place IDs or asset paths", () => {
    expect(() => parsePlaceVisualIndex({ version: 2, places: {} })).toThrow(/unsupported format/i);
    const parsed = parsePlaceVisualIndex({
      version: 1,
      places: {
        [placeId]: { ...entry, satellite: `${placeId}/../private.avif` },
        "../other-place": { ...entry, placeId: "../other-place" },
        "provincial-rathtrevor-beach-park": {
          ...entry,
          placeId: "provincial-rathtrevor-beach-park",
          satellite: "https://images.example.test/satellite.avif",
          relief: "provincial-rathtrevor-beach-park/relief.avif",
          model: "provincial-rathtrevor-beach-park/provincial-rathtrevor-beach-park-terrain.glb",
        },
      },
    });

    expect(parsed.size).toBe(0);
  });

  it("resolves relative and CDN paths without allowing path overrides", () => {
    expect(placeVisualIndexUrl("/park-visuals-fixture", "https://staging.web.parkdex.app"))
      .toBe("https://staging.web.parkdex.app/park-visuals-fixture/index.json");
    expect(placeVisualAssetUrls(entry, "https://assets.example.test/parkdex/v7", "https://staging.web.parkdex.app")).toEqual({
      satellite: `https://assets.example.test/parkdex/v7/${placeId}/satellite.avif`,
      relief: `https://assets.example.test/parkdex/v7/${placeId}/relief.avif`,
      model: `https://assets.example.test/parkdex/v7/${placeId}/${placeId}-terrain.glb`,
    });
    expect(() => placeVisualAssetUrls({ ...entry, relief: `${placeId}/../escape.avif` }, "/assets", "https://parkdex.app"))
      .toThrow(/entry is invalid/i);
  });

  it("caches a loaded index and clears failed requests so a later open can retry", async () => {
    const response = () => new Response(JSON.stringify(indexWith(entry)), { status: 200 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const first = await loadPlaceVisualIndex("/fixture", fetcher);
    const second = await loadPlaceVisualIndex("/fixture", fetcher);
    expect(first).toBe(second);
    expect(fetcher).toHaveBeenCalledTimes(1);

    clearPlaceVisualIndexCache();
    const retryingFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(response());
    await expect(loadPlaceVisualIndex("/fixture", retryingFetcher)).rejects.toThrow("returned 503");
    await expect(loadPlaceVisualIndex("/fixture", retryingFetcher)).resolves.toHaveProperty("size", 1);
    expect(retryingFetcher).toHaveBeenCalledTimes(2);
  });
});
