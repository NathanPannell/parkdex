import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  boundarySourceDescription,
  mergeBoundaryCollections,
  normalizeBoundaryText,
  readScopedBoundaryCollection,
  resolveCatalogueScope,
} from "./catalogue-scope.mjs";

describe("catalogue build scope", () => {
  it("fails closed to canonical unless staging is explicit", () => {
    expect(resolveCatalogueScope()).toBe("canonical");
    expect(resolveCatalogueScope("production")).toBe("canonical");
    expect(resolveCatalogueScope("preview")).toBe("canonical");
    expect(resolveCatalogueScope("staging")).toBe("staging");
    expect(resolveCatalogueScope(" STAGING ")).toBe("staging");
  });

  it("keeps canonical data separate from the explicit Bell Park staging overlay", async () => {
    const canonical = await readScopedBoundaryCollection("canonical");
    const staging = await readScopedBoundaryCollection("staging");
    expect(canonical.collection.features.some((feature) => feature.properties.id === "regional-bell-park")).toBe(false);
    expect(staging.collection.features.some((feature) => feature.properties.id === "regional-bell-park")).toBe(true);
    expect(staging.stagingIds).toEqual(new Set(["regional-bell-park"]));
    expect(staging.collection.features.length).toBe(canonical.collection.features.length + 1);
    expect(boundarySourceDescription(canonical.scope)).toBe("data/boundaries.geojson");
    expect(boundarySourceDescription(staging.scope)).toBe("data/boundaries.geojson + data/staging-field-boundaries.geojson");
  });

  it("uses the reviewed staging place representative rather than a boundary-derived point", async () => {
    const places = JSON.parse(await readFile(fileURLToPath(new URL("../../data/staging-field-places.json", import.meta.url)), "utf8"));
    expect(places).toEqual([expect.objectContaining({
      id: "regional-bell-park",
      name: "Bell Park",
      latitude: 49.0918726,
      longitude: -123.0600868,
      sourceName: "City of Delta",
    })]);
  });

  it("rejects an overlay that silently replaces a canonical boundary", () => {
    const canonical = { type: "FeatureCollection", features: [{ type: "Feature", properties: { id: "a" }, geometry: { type: "Polygon", coordinates: [] } }] };
    const staging = { type: "FeatureCollection", features: [{ type: "Feature", properties: { id: "a" }, geometry: { type: "Polygon", coordinates: [] } }] };
    expect(() => mergeBoundaryCollections(canonical, staging)).toThrow(/already exists in canonical/);
  });

  it("normalizes only line endings when hashing canonical source text", () => {
    expect(normalizeBoundaryText("a\r\nb\r\nc")).toBe("a\nb\nc");
  });
});
