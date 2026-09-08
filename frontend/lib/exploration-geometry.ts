export type ExplorationCategory = "national" | "island" | "provincial" | "regional";

export type ExplorationPoint = {
  id: string;
  longitude: number;
  latitude: number;
  category: ExplorationCategory;
};

export const EXPLORATION_CATEGORY_WEIGHTS: Readonly<Record<ExplorationCategory, number>> = Object.freeze({
  national: 4,
  island: 3,
  provincial: 2,
  regional: 1,
});

const EARTH_RADIUS_KM = 6371.0088;
export const EXPLORATION_PROJECTION_ORIGIN = Object.freeze({ longitude: -125.5, latitude: 49.6 });

function radians(degrees: number) {
  return degrees * Math.PI / 180;
}

export function isExplorationPoint(point: ExplorationPoint) {
  return point.id.length > 0
    && Number.isFinite(point.longitude)
    && Number.isFinite(point.latitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && point.longitude >= -180
    && point.longitude <= 180
    && Object.hasOwn(EXPLORATION_CATEGORY_WEIGHTS, point.category);
}

export function distanceKm(
  a: Pick<ExplorationPoint, "longitude" | "latitude">,
  b: Pick<ExplorationPoint, "longitude" | "latitude">,
) {
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function projectExplorationLocation(location: Pick<ExplorationPoint, "longitude" | "latitude">): [number, number] {
  const originLatitude = radians(EXPLORATION_PROJECTION_ORIGIN.latitude);
  return [
    EARTH_RADIUS_KM * radians(location.longitude - EXPLORATION_PROJECTION_ORIGIN.longitude) * Math.cos(originLatitude),
    EARTH_RADIUS_KM * radians(location.latitude - EXPLORATION_PROJECTION_ORIGIN.latitude),
  ];
}

export function unprojectExplorationLocation([x, y]: readonly [number, number]): [number, number] {
  const originLatitude = radians(EXPLORATION_PROJECTION_ORIGIN.latitude);
  return [
    EXPLORATION_PROJECTION_ORIGIN.longitude + (x / (EARTH_RADIUS_KM * Math.cos(originLatitude))) * 180 / Math.PI,
    EXPLORATION_PROJECTION_ORIGIN.latitude + (y / EARTH_RADIUS_KM) * 180 / Math.PI,
  ];
}

/**
 * Display-only completion score used by the precomputed territory partition.
 * It approximates influence rather than ground travelled: lower is closer, and
 * the 4/3/2/1 category weight lets larger collection achievements own more land.
 */
export function weightedDistanceScore(
  location: Pick<ExplorationPoint, "longitude" | "latitude">,
  place: ExplorationPoint,
) {
  const [locationX, locationY] = projectExplorationLocation(location);
  const [placeX, placeY] = projectExplorationLocation(place);
  return ((locationX - placeX) ** 2 + (locationY - placeY) ** 2)
    / EXPLORATION_CATEGORY_WEIGHTS[place.category];
}

export type WeightedTerritoryConstraint =
  | { kind: "all" | "empty" }
  | { kind: "half-plane"; x: number; y: number; limit: number }
  | { kind: "circle"; center: readonly [number, number]; radius: number; keep: "inside" | "outside" };

/** Returns the analytic Apollonius constraint where owner beats competitor. */
export function weightedTerritoryConstraint(
  owner: ExplorationPoint,
  competitor: ExplorationPoint,
): WeightedTerritoryConstraint {
  const [ownerX, ownerY] = projectExplorationLocation(owner);
  const [competitorX, competitorY] = projectExplorationLocation(competitor);
  const ownerWeight = EXPLORATION_CATEGORY_WEIGHTS[owner.category];
  const competitorWeight = EXPLORATION_CATEGORY_WEIGHTS[competitor.category];
  const deltaX = competitorX - ownerX;
  const deltaY = competitorY - ownerY;
  if (Math.hypot(deltaX, deltaY) < 1e-9) {
    if (ownerWeight !== competitorWeight) return { kind: ownerWeight > competitorWeight ? "all" : "empty" };
    return { kind: owner.id < competitor.id ? "all" : "empty" };
  }
  if (ownerWeight === competitorWeight) {
    return {
      kind: "half-plane",
      x: 2 * deltaX,
      y: 2 * deltaY,
      limit: competitorX ** 2 + competitorY ** 2 - ownerX ** 2 - ownerY ** 2,
    };
  }
  const denominator = competitorWeight - ownerWeight;
  const centerX = (competitorWeight * ownerX - ownerWeight * competitorX) / denominator;
  const centerY = (competitorWeight * ownerY - ownerWeight * competitorY) / denominator;
  const constant = competitorWeight * (ownerX ** 2 + ownerY ** 2)
    - ownerWeight * (competitorX ** 2 + competitorY ** 2);
  const radiusSquared = centerX ** 2 + centerY ** 2 - constant / denominator;
  return {
    kind: "circle",
    center: [centerX, centerY],
    radius: Math.sqrt(Math.max(0, radiusSquared)),
    keep: denominator > 0 ? "inside" : "outside",
  };
}

/** Picks a stable owner for a territory sample. Equal scores resolve by id. */
export function nearestWeightedExplorationPoint(
  location: Pick<ExplorationPoint, "longitude" | "latitude">,
  input: readonly ExplorationPoint[],
) {
  let winner: ExplorationPoint | undefined;
  let winnerScore = Number.POSITIVE_INFINITY;
  for (const point of input) {
    if (!isExplorationPoint(point)) continue;
    const score = weightedDistanceScore(location, point);
    if (score < winnerScore - Number.EPSILON
      || (Math.abs(score - winnerScore) <= Number.EPSILON && (!winner || point.id < winner.id))) {
      winner = point;
      winnerScore = score;
    }
  }
  return winner;
}
