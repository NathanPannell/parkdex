import { describe, expect, it } from "vitest";
import { authorityForPlace, collectionFilter, groupByRegion } from "./collection";
import type { Place } from "./places";

const regional = (id: string, sourceName: string): Place => ({ id, name: id, category: "regional", latitude: 0, longitude: 0, region: "Central Island", description: "", sourceName, sourceUrl: "https://example.com" });

describe("collection hierarchy", () => {
  const crd = regional("crd", "Capital Regional District — Park GIS layer");
  const rdn = regional("rdn", "Regional District of Nanaimo — Regional Parks spatial data");

  it("groups places by geographic region across administrators", () => {
    expect(authorityForPlace(crd)).toContain("CRD");
    expect(authorityForPlace(rdn)).toContain("RDN");
    expect(groupByRegion([rdn, crd])).toEqual([{ region: "Central Island", places: [crd, rdn] }]);
  });

  it("combines authority and visited filters", () => {
    expect(collectionFilter([crd, rdn], "", new Set(), new Set([authorityForPlace(rdn)]), "visited", new Set(["rdn"]))).toEqual([rdn]);
  });
});
