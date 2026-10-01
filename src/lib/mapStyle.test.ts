import { featureFilter, type Feature } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { mapStyle } from "./mapStyle";

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
});
