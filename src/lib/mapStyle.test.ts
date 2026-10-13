import { featureFilter, type Feature } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { contentBoundsEnvelope } from "./content/contracts";
import { DETAIL_BOUNDS, mapStyle } from "./mapStyle";

describe("map style", () => {
  it("draws the water shadow only for polygon water features", () => {
    const shadow = mapStyle("release-v2").layers.find((layer) => layer.id === "water-shadow");
    if (!shadow || shadow.type !== "fill" || !shadow.filter) {
      throw new Error("The detailed water shadow layer must be a filtered fill layer");
    }

    const matches = featureFilter(shadow.filter, "layers[water-shadow].filter").filter;
    const globalProperties = { zoom: 14.3 };
    const lake = { type: 3, properties: { kind: "water", kind_detail: "lake" } } as Feature;
    const stream = { type: 2, properties: { kind: "water", kind_detail: "stream" } } as Feature;

    expect(matches(globalProperties, lake)).toBe(true);
    expect(matches(globalProperties, stream)).toBe(false);
  });

  it("bounds the detailed source by one box around BC and Nova Scotia", () => {
    expect(DETAIL_BOUNDS).toEqual(contentBoundsEnvelope());
    const source = mapStyle("release-v2").sources.protomaps;
    expect(source).toMatchObject({ type: "vector", bounds: [-139.1, 43.3, -59.6, 60.0], maxzoom: 14 });
  });
});
