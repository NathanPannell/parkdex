import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import booleanValid from "@turf/boolean-valid";
import { describe, expect, it } from "vitest";

import { geometryBounds, parseBoundaryCollection } from "./boundaries";

const publicDirectory = resolve(process.cwd(), "public/data");
const displayText = readFileSync(resolve(publicDirectory, "boundaries-display.v1.geojson"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(publicDirectory, "boundaries-display.v1.manifest.json"), "utf8"));
const display = parseBoundaryCollection(JSON.parse(displayText));
const canonical = parseBoundaryCollection(JSON.parse(readFileSync(resolve(publicDirectory, "boundaries.v1.geojson"), "utf8")));
const canonicalInputText = readFileSync(resolve(process.cwd(), "../data/boundaries.geojson"), "utf8");

function polygonParts(feature: (typeof display.features)[number]) {
  if (feature.geometry.type === "Polygon") return [feature];
  return feature.geometry.coordinates.map((coordinates) => ({
    type: "Feature" as const,
    properties: feature.properties,
    geometry: { type: "Polygon" as const, coordinates },
  }));
}

describe("softened boundary display asset", () => {
  it("matches the reproducible checksum manifest and canonical feature ids", () => {
    expect(createHash("sha256").update(displayText).digest("hex")).toBe(manifest.outputSha256);
    expect(createHash("sha256").update(canonicalInputText.replace(/\r\n/g, "\n")).digest("hex")).toBe(manifest.inputSha256);
    expect(display.features).toHaveLength(manifest.featureCount);
    expect(display.features.map((feature) => feature.properties.id).sort())
      .toEqual(canonical.features.map((feature) => feature.properties.id).sort());
  });

  it("normalizes canonical line endings before hashing for Windows and CI parity", () => {
    const normalized = canonicalInputText.replace(/\r\n/g, "\n");
    const simulatedWindowsCheckout = normalized.replace(/\n/g, "\r\n");
    expect(createHash("sha256").update(simulatedWindowsCheckout.replace(/\r\n/g, "\n")).digest("hex"))
      .toBe(createHash("sha256").update(normalized).digest("hex"));
  });

  it("has valid topology in every polygon part", () => {
    const invalidIds = display.features
      .filter((feature) => !polygonParts(feature).every((part) => booleanValid(part)))
      .map((feature) => feature.properties.id);
    expect(invalidIds).toEqual([]);
  });

  it("slightly expands representative boundary extents while retaining polygon geometry", () => {
    const canonicalFeature = canonical.features.find((feature) => feature.properties.id === "provincial-strathcona-park");
    const displayFeature = display.features.find((feature) => feature.properties.id === "provincial-strathcona-park");
    expect(canonicalFeature).toBeDefined();
    expect(displayFeature).toBeDefined();
    const canonicalBounds = geometryBounds(canonicalFeature!.geometry)!;
    const displayBounds = geometryBounds(displayFeature!.geometry)!;
    expect(displayBounds[0][0]).toBeLessThan(canonicalBounds[0][0]);
    expect(displayBounds[0][1]).toBeLessThan(canonicalBounds[0][1]);
    expect(displayBounds[1][0]).toBeGreaterThan(canonicalBounds[1][0]);
    expect(displayBounds[1][1]).toBeGreaterThan(canonicalBounds[1][1]);
    expect(["Polygon", "MultiPolygon"]).toContain(displayFeature!.geometry.type);
  });
});
