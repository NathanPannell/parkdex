import { describe, expect, it, vi } from "vitest";

import { categoryLabels, createCollectionKey, filterPlaces, isPlaceCategory, type Place } from "./places";

const places: Place[] = [
  {
    id: "forest",
    name: "Forest Park",
    category: "provincial",
    latitude: 49,
    longitude: -124,
    region: "West Coast",
    description: "Old growth trail",
    sourceUrl: "https://example.com",
    sourceName: "Source",
  },
  {
    id: "island",
    name: "Discovery Island",
    category: "island",
    latitude: 49,
    longitude: -124,
    region: "Salish Sea",
    description: "Offshore island",
    sourceUrl: "https://example.com",
    sourceName: "Source",
  },
  {
    id: "municipal",
    name: "Harbour Park",
    category: "municipal",
    latitude: 49,
    longitude: -124,
    region: "Victoria",
    description: "A municipal waterfront park",
    sourceUrl: "https://example.com",
    sourceName: "City of Victoria",
  },
  {
    id: "community",
    name: "Village Green",
    category: "community",
    latitude: 49,
    longitude: -124,
    region: "Coast",
    description: "A community recreation site",
    sourceUrl: "https://example.com",
    sourceName: "Example community",
  },
];

describe("filterPlaces", () => {
  it("combines search and category filters", () => {
    expect(filterPlaces(places, "old growth", new Set(["provincial"]))).toEqual([places[0]]);
    expect(filterPlaces(places, "old growth", new Set(["island"]))).toEqual([]);
  });

  it("filters municipal and community places and exposes their category labels", () => {
    expect(filterPlaces(places, "", new Set(["municipal", "community"]))).toEqual(places.slice(2));
    expect(categoryLabels.municipal).toBe("Municipal");
    expect(categoryLabels.community).toBe("Community");
    expect(isPlaceCategory("municipal")).toBe(true);
    expect(isPlaceCategory("community")).toBe(true);
    expect(isPlaceCategory("local")).toBe(false);
  });
});

describe("createCollectionKey", () => {
  it("creates an API-safe 256-bit key", () => {
    vi.stubGlobal("crypto", { getRandomValues: (value: Uint8Array) => value.fill(23) });
    const key = createCollectionKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    vi.unstubAllGlobals();
  });
});
