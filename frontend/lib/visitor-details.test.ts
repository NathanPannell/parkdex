import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";

import { parsePlaceVisitorDetails } from "./visitor-details";

describe("parsePlaceVisitorDetails", () => {
  it("accepts all 1,030 checked-in reviewed records without changing their public values", () => {
    const reviewed = JSON.parse(readFileSync(new URL("../../data/park-details.reviewed.json", import.meta.url), "utf8")) as {
      places: Array<{ placeId: string; visitorDetails: unknown }>;
    };
    const mismatches: string[] = [];

    for (const place of reviewed.places) {
      const parsed = parsePlaceVisitorDetails(place.visitorDetails);
      if (!isDeepStrictEqual(parsed, place.visitorDetails)) mismatches.push(place.placeId);
    }

    expect(reviewed.places).toHaveLength(1030);
    expect(mismatches).toEqual([]);
  });
});
