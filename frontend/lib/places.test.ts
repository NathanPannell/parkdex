import { describe, expect, it, vi } from "vitest";

import { createCollectionKey, filterPlaces, type Place } from "./places";

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
];

describe("filterPlaces", () => {
  it("combines search and category filters", () => {
    expect(filterPlaces(places, "old growth", new Set(["provincial"]))).toEqual([places[0]]);
    expect(filterPlaces(places, "old growth", new Set(["island"]))).toEqual([]);
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
