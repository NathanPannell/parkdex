import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getVisitorInformation } from "./visitor-information";
import catalogue from "./visitor-information.catalogue.json";
import { collectionFilter } from "./collection";
import { filterPlaces, matchesPlaceSearch, type Place } from "./places";

const places: Place[] = JSON.parse(readFileSync(new URL("../../data/places.json", import.meta.url), "utf8"));

describe("verified visitor information", () => {
  it("keeps checked visitor destinations distinct from source provenance", () => {
    for (const [id, entry] of Object.entries(catalogue)) {
      const place = places.find((item) => item.id === id);
      expect(place, id).toBeTruthy();
      expect(new URL(entry.url).protocol).toBe("https:");
      expect(entry.title.length).toBeGreaterThan(3);
      expect(entry.verifiedAt).toMatch(/^2026-09-12/);
      expect(getVisitorInformation(id)?.url).toBe(entry.url);
    }
    expect(getVisitorInformation("provincial-goldstream-park")?.url).not.toBe(places.find((place) => place.id === "provincial-goldstream-park")?.sourceUrl);
  });
  it.each([
    ["provincial-goldstream-park", "bcparks.ca"],
    ["provincial-elk-falls-park", "bcparks.ca"],
    ["national-pacific-rim-national-park-reserve", "parks.canada.ca"],
    ["national-gulf-islands-national-park-reserve", "parks.canada.ca"],
    ["regional-mount-work-regional-park", "www.crd.ca"],
    ["island-saltspring-island", "www.saltspringchamber.com"],
  ])("offers a verified destination for %s", (id, hostname) => {
    expect(new URL(getVisitorInformation(id)!.url).hostname).toBe(hostname);
  });
  it("does not invent destinations for missing or inherited keys", () => {
    expect(getVisitorInformation("unknown")).toBeUndefined();
    expect(getVisitorInformation("toString")).toBeUndefined();
    expect(getVisitorInformation("regional-sooke-river-regional-park")).toBeUndefined();
  });
});

describe("canonical display-name correction", () => {
  it.each(["Hathayim", "Háthayim", "Von Donop"])("finds one stable park using %s in every search scope", (query) => {
    const id = "provincial-hathayim-marine-park-a-k-a-von-donop-marine-park";
    expect(places.find((place) => place.id === id)).toMatchObject({ name: "Háthayim Marine Park", sourceId: "728" });
    expect(filterPlaces(places, query, new Set()).map((place) => place.id)).toEqual([id]);
    expect(collectionFilter(places, query, new Set(), new Set(), "all", new Set()).map((place) => place.id)).toEqual([id]);
    expect(places.filter((place) => matchesPlaceSearch(place, query)).map((place) => place.id)).toEqual([id]);
  });
});
