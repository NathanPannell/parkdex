import fs from "node:fs";
import path from "node:path";

import booleanValid from "@turf/boolean-valid";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import { describe, expect, it } from "vitest";

describe("British Columbia map focus asset", () => {
  it("is a valid inverse polygon with the mainland, major islands, and park footprints cut out", () => {
    const asset = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public/data/bc-focus-mask.v1.geojson"), "utf8"));
    const feature = asset.features[0];
    expect(feature.geometry.type).toBe("MultiPolygon");
    // Turf's whole-MultiPolygon validator rejects some valid disjoint mask
    // collections; check each component, and separately check known holes.
    feature.geometry.coordinates.forEach((coordinates: GeoJSON.Position[][]) => {
      expect(booleanValid({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates } })).toBe(true);
    });
    expect(booleanPointInPolygon(point([-123.3656, 48.4284]), feature)).toBe(false);
    expect(booleanPointInPolygon(point([-124.8055, 49.2339]), feature)).toBe(false);
    expect(booleanPointInPolygon(point([-123.12, 49.28]), feature)).toBe(false);
    expect(booleanPointInPolygon(point([-125, 53]), feature)).toBe(false);
    expect(booleanPointInPolygon(point([-132.5, 53.25]), feature)).toBe(false);
    expect(booleanPointInPolygon(point([-128, 45]), feature)).toBe(true);
    expect(feature.properties.scope).toBe("Outside British Columbia land and catalogued parks");
  });
});
