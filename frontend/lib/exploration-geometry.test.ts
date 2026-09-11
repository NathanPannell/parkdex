import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import booleanValid from "@turf/boolean-valid";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import {
  distanceKm,
  EXPLORATION_CATEGORY_WEIGHTS,
  nearestWeightedExplorationPoint,
  type ExplorationPoint,
  weightedDistanceScore,
  weightedTerritoryConstraint,
} from "./exploration-geometry";
import { explorationBoundaryFilter } from "./exploration-map-style";

type TerritoryProperties = {
  id?: string;
  category?: string;
  weight?: number;
  ownerA?: string;
  ownerB?: string | null;
  kind: "exploration-scope" | "estimated-territory" | "territory-edge";
};
type TerritoryAsset = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon | GeoJSON.MultiLineString, TerritoryProperties> & {
  metadata: {
    activePlaceCount: number;
    territoryCount: number;
    edgeFeatureCount: number;
    edgeSegmentCount: number;
    coastEdgeSegmentCount: number;
    interiorEdgeSegmentCount: number;
    categoryWeights: typeof EXPLORATION_CATEGORY_WEIGHTS;
  };
};

const point = (
  id: string,
  longitude: number,
  latitude = 49,
  category: ExplorationPoint["category"] = "regional",
): ExplorationPoint => ({ id, longitude, latitude, category });

function catalogue() {
  return JSON.parse(readFileSync(resolve(process.cwd(), "../data/places.json"), "utf8")) as ExplorationPoint[];
}

function territoryAsset() {
  return JSON.parse(readFileSync(resolve(process.cwd(), "public/data/exploration-territories.v1.geojson"), "utf8")) as TerritoryAsset;
}

function boundaryFilterMatches(visitedIds: string[], ownerA: string, ownerB: string | null) {
  const compiled = featureFilter(explorationBoundaryFilter(visitedIds), "layers.test.filter").filter;
  return compiled({ zoom: 5 }, { properties: { kind: "territory-edge", ownerA, ownerB } } as never);
}

function ringContains([x, y]: readonly [number, number], ring: GeoJSON.Position[]) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
    const [currentX, currentY] = ring[current];
    const [previousX, previousY] = ring[previous];
    if ((currentY > y) !== (previousY > y)
      && x < (previousX - currentX) * (y - currentY) / (previousY - currentY) + currentX) inside = !inside;
  }
  return inside;
}

function geometryContains(location: readonly [number, number], geometry: GeoJSON.MultiPolygon) {
  return geometry.coordinates.some((polygon) => (
    ringContains(location, polygon[0]) && !polygon.slice(1).some((hole) => ringContains(location, hole))
  ));
}

describe("weighted exploration territory", () => {
  it("uses the explicit national, island, provincial, regional influence order", () => {
    expect(EXPLORATION_CATEGORY_WEIGHTS).toEqual({ national: 4, island: 3, provincial: 2, regional: 1 });
    const location = point("query", -124);
    const sameLocation = (["national", "island", "provincial", "regional"] as const)
      .map((category) => point(category, -123.9, 49, category));
    expect(sameLocation.map((place) => weightedDistanceScore(location, place)))
      .toEqual([...sameLocation.map((place) => weightedDistanceScore(location, place))].sort((a, b) => a - b));
    expect(nearestWeightedExplorationPoint(location, sameLocation)?.id).toBe("national");
  });

  it("lets weight expand an accomplishment without defeating a substantially nearer gap", () => {
    const location = point("query", -124);
    const regional = point("regional", -123.86, 49, "regional");
    const nationalWithinInfluence = point("national", -123.74, 49, "national");
    const nationalTooFar = point("national", -123.68, 49, "national");
    expect(nearestWeightedExplorationPoint(location, [regional, nationalWithinInfluence])?.id).toBe("national");
    expect(nearestWeightedExplorationPoint(location, [regional, nationalTooFar])?.id).toBe("regional");
  });

  it("resolves coincident representatives by weight, then stable id", () => {
    const location = point("query", -124);
    expect(nearestWeightedExplorationPoint(location, [
      point("regional", -123.9, 49, "regional"),
      point("national", -123.9, 49, "national"),
    ])?.id).toBe("national");
    expect(nearestWeightedExplorationPoint(location, [
      point("z-place", -123.9),
      point("a-place", -123.9),
    ])?.id).toBe("a-place");
  });

  it("builds complementary straight or curved pair constraints", () => {
    const regional = point("regional", -124, 49, "regional");
    const national = point("national", -123.8, 49, "national");
    expect(weightedTerritoryConstraint(regional, national)).toMatchObject({ kind: "circle", keep: "inside" });
    expect(weightedTerritoryConstraint(national, regional)).toMatchObject({ kind: "circle", keep: "outside" });
    expect(weightedTerritoryConstraint(regional, point("peer", -123.8))).toMatchObject({ kind: "half-plane" });
  });

  it("gives every active catalogue representative its own deterministic nearest score", () => {
    const places = catalogue();
    expect(places).toHaveLength(195);
    places.forEach((place) => expect(nearestWeightedExplorationPoint(place, places)?.id).toBe(place.id));
  });

  it("ships one valid, land-clipped territory for every active place and covers the full scope", () => {
    const places = catalogue();
    const asset = territoryAsset();
    const scope = asset.features.find((feature): feature is GeoJSON.Feature<GeoJSON.MultiPolygon, TerritoryProperties> => (
      feature.properties.kind === "exploration-scope" && feature.geometry.type === "MultiPolygon"
    ));
    const territories = asset.features.filter((feature): feature is GeoJSON.Feature<GeoJSON.MultiPolygon, TerritoryProperties> => (
      feature.properties.kind === "estimated-territory" && feature.geometry.type === "MultiPolygon"
    ));
    expect(scope).toBeDefined();
    expect(statSync(resolve(process.cwd(), "public/data/exploration-territories.v1.geojson")).size).toBeLessThan(3_000_000);
    expect(asset.metadata).toMatchObject({
      activePlaceCount: 195,
      territoryCount: 195,
      categoryWeights: EXPLORATION_CATEGORY_WEIGHTS,
      landSource: "canonical-boundaries-independent-padded",
      explorationPaddingMeters: { park: 180, island: 220 },
    });
    expect(new Set(territories.map((feature) => feature.properties.id)))
      .toEqual(new Set(places.map((place) => place.id)));
    territories.forEach((feature) => expect(booleanValid(feature)).toBe(true));

    // A deterministic land sample catches both offshore fill and gaps/overlaps
    // without running an unstable 195-way polygon boolean in the test process.
    let landSamples = 0;
    for (let latitude = 48.31; latitude <= 50.88; latitude += 0.04) {
      for (let longitude = -128.44; longitude <= -123.04; longitude += 0.04) {
        const location = [longitude + 0.013, latitude + 0.017] as const;
        if (!geometryContains(location, scope!.geometry)) continue;
        landSamples += 1;
        expect(territories.filter((feature) => geometryContains(location, feature.geometry))).toHaveLength(1);
      }
    }
    expect(landSamples).toBeGreaterThan(1_500);
  }, 20_000);

  it("ships a rounded display-edge topology with no shared seam between visited neighbors", () => {
    const places = catalogue();
    const asset = territoryAsset();
    const edges = asset.features.filter((feature): feature is GeoJSON.Feature<GeoJSON.MultiLineString, TerritoryProperties> => (
      feature.properties.kind === "territory-edge" && feature.geometry.type === "MultiLineString"
    ));
    expect(edges).toHaveLength(asset.metadata.edgeFeatureCount);
    expect(asset.metadata.coastEdgeSegmentCount + asset.metadata.interiorEdgeSegmentCount)
      .toBe(asset.metadata.edgeSegmentCount);
    expect(edges.length).toBeGreaterThan(places.length);
    expect(edges.some((edge) => edge.properties.ownerB === null)).toBe(true);

    const allIds = places.map((place) => place.id);
    edges.forEach((edge) => {
      const { ownerA, ownerB } = edge.properties;
      expect(ownerA).toBeTruthy();
      expect(boundaryFilterMatches([], ownerA!, ownerB ?? null)).toBe(false);
      expect(boundaryFilterMatches(allIds, ownerA!, ownerB ?? null)).toBe(ownerB === null);
    });

    const shared = edges.find((edge) => edge.properties.ownerB != null)!;
    const first = shared.properties.ownerA!;
    const second = shared.properties.ownerB!;
    expect(boundaryFilterMatches([first], first, second)).toBe(true);
    expect(boundaryFilterMatches([first, second], first, second)).toBe(false);

    const represented = new Set(edges.flatMap((edge) => [edge.properties.ownerA, edge.properties.ownerB].filter(Boolean)));
    expect(represented).toEqual(new Set(allIds));
  });

  it("calculates Vancouver Island scale distances", () => {
    expect(distanceKm(point("a", -123.3656, 48.4284), point("b", -123.9401, 49.1659))).toBeCloseTo(92.4, 0);
  });
});
