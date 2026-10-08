import { describe, expect, it } from "vitest";
import type { Park } from "./parks";
import { searchParks } from "./parkSearch";

const park = (id: string, name: string, short: string, region = "Capital Region") => ({ id, name, short, region } as Park);
const items = [
  { park: park("a", "Thetis Lake Regional Park", "Thetis Lake"), km: 10 },
  { park: park("b", "Swan Lake Christmas Hill", "Swan Lake"), km: 4 },
  { park: park("c", "Lakeview Park", "Lakeview"), km: 20 },
  { park: park("d", "Goldstream Park", "Goldstream", "Langford"), km: 15 },
];

describe("searchParks", () => {
  it("returns every match, word starts first and nearer parks first", () => {
    expect(searchParks(items, "lake").map((i) => i.park.id)).toEqual(["b", "a", "c"]);
  });

  it("matches all words, ignoring case and accents, and falls back to region", () => {
    expect(searchParks(items, "THÉTIS lake").map((i) => i.park.id)).toEqual(["a"]);
    expect(searchParks(items, "langford").map((i) => i.park.id)).toEqual(["d"]);
  });

  it("returns nothing for a blank query", () => {
    expect(searchParks(items, "   ")).toEqual([]);
  });
});
