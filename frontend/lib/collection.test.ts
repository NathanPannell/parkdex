import { describe, expect, it } from "vitest";
import { authorityForPlace, collectionFilter, groupByRegion, listRegionForPlace } from "./collection";
import type { Place } from "./places";

const regional = (id: string, sourceName: string): Place => ({ id, name: id, category: "regional", latitude: 0, longitude: 0, region: "Central Island", description: "", sourceName, sourceUrl: "https://example.com" });

describe("collection hierarchy", () => {
  const crd = regional("crd", "Capital Regional District — Park GIS layer");
  const rdn = regional("rdn", "Regional District of Nanaimo — Regional Parks spatial data");

  it("groups places by geographic region across administrators", () => {
    expect(authorityForPlace(crd)).toContain("CRD");
    expect(authorityForPlace(rdn)).toContain("RDN");
    expect(groupByRegion([rdn, crd])).toEqual([{ region: "Southern Vancouver Island", places: [crd, rdn] }]);
  });

  it("consolidates island regions while retaining their original labels", () => {
    const nanaimo = { ...rdn, id: "nanaimo", name: "Nanaimo", latitude: 49.2 };
    const comox = { ...rdn, id: "comox", name: "Comox", latitude: 49.67 };
    const gulf = { ...rdn, id: "gulf", name: "Gulf", region: "Gulf Islands" };
    const discovery = { ...rdn, id: "discovery", name: "Discovery", region: "Discovery Islands" };
    expect(groupByRegion([discovery, comox, gulf, nanaimo])).toEqual([
      { region: "Southern Vancouver Island", places: [gulf, nanaimo] },
      { region: "Northern Vancouver Island", places: [comox, discovery] },
    ]);
    expect(nanaimo.region).toBe("Central Island");
    expect(comox.region).toBe("Central Island");
  });

  it("uses concise mainland regions and keeps unknown regions visible", () => {
    const metro = { ...rdn, id: "metro", region: "South Coast" };
    const coast = { ...rdn, id: "coast", region: "North Coast & Haida Gwaii" };
    const newRegion = { ...rdn, id: "new", region: "New source region" };
    expect(groupByRegion([newRegion, coast, metro]).map((group) => group.region)).toEqual([
      "South Coast", "North Coast & Haida Gwaii", "New source region",
    ]);
    expect(listRegionForPlace(newRegion)).toBe("New source region");
  });

  it("finds places through both collection headings and source regions", () => {
    const coastal = { ...rdn, id: "coastal", region: "Discovery Islands" };
    expect(collectionFilter([coastal], "Northern Vancouver Island", new Set(), new Set(), "all", new Set())).toEqual([coastal]);
    expect(collectionFilter([coastal], "Discovery Islands", new Set(), new Set(), "all", new Set())).toEqual([coastal]);
  });

  it("combines authority and visited filters", () => {
    expect(collectionFilter([crd, rdn], "", new Set(), new Set([authorityForPlace(rdn)]), "visited", new Set(["rdn"]))).toEqual([rdn]);
  });

  it("keeps newly imported regional authorities distinct in the filter", () => {
    const fraser = regional("fraser", "Fraser Valley Regional District via BC Local and Regional Greenspaces");
    const columbia = regional("columbia", "Regional District of Central Kootenay — BC Local and Regional Greenspaces");
    expect(authorityForPlace(fraser)).toBe("Fraser Valley Regional District");
    expect(authorityForPlace(columbia)).toBe("Regional District of Central Kootenay");
    expect(collectionFilter([fraser, columbia], "", new Set(), new Set([authorityForPlace(fraser)]), "all", new Set())).toEqual([fraser]);
  });
});
