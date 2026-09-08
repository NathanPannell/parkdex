import fs from "node:fs";
import path from "node:path";

import booleanValid from "@turf/boolean-valid";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import { describe, expect, it } from "vitest";

describe("Vancouver Island map focus asset", () => {
  it("is a valid inverse polygon with the main island, nearby islands, and excursion parks cut out", () => {
    const asset = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public/data/vancouver-island-focus-mask.v1.geojson"), "utf8"));
    const feature = asset.features[0];
    expect(booleanValid(feature)).toBe(true);
    expect(feature.geometry.type).toBe("MultiPolygon");
    expect(booleanPointInPolygon(point([-123.3656, 48.4284]), feature)).toBe(false);
    expect(booleanPointInPolygon(point([-124.8055, 49.2339]), feature)).toBe(false);
    expect(booleanPointInPolygon(point([-125.244, 50.024]), feature)).toBe(false);
    expect(booleanPointInPolygon(point([-123.12, 49.28]), feature)).toBe(true);
    expect(booleanPointInPolygon(point([-128, 55]), feature)).toBe(true);
    expect(booleanPointInPolygon(point([-128, 45]), feature)).toBe(true);
    expect(feature.properties.scope).toBe("Outside Vancouver Island and supported major islands");
  });
});
