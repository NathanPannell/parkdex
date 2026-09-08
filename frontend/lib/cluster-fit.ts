export type ClusterCoordinate = [longitude: number, latitude: number];

export type ClusterFit = {
  bounds: [ClusterCoordinate, ClusterCoordinate];
  center: ClusterCoordinate;
  coincident: boolean;
};

export type ClusterLeafSource = {
  getClusterLeaves: (clusterId: number, limit: number, offset: number) => Promise<GeoJSON.Feature[]>;
};

const LEAF_PAGE_SIZE = 100;

function pointCoordinate(feature: GeoJSON.Feature): ClusterCoordinate | null {
  if (feature.geometry?.type !== "Point") return null;
  const [longitude, latitude] = feature.geometry.coordinates;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return [longitude, latitude];
}

export async function fetchClusterLeaves(
  source: ClusterLeafSource,
  clusterId: number,
  pointCount: number,
): Promise<GeoJSON.Feature[]> {
  const expected = Math.max(0, Math.floor(pointCount));
  const leaves: GeoJSON.Feature[] = [];

  while (leaves.length < expected) {
    const page = await source.getClusterLeaves(
      clusterId,
      Math.min(LEAF_PAGE_SIZE, expected - leaves.length),
      leaves.length,
    );
    if (!page.length) break;
    leaves.push(...page.slice(0, expected - leaves.length));
  }

  return leaves;
}

export function clusterFitForLeaves(leaves: GeoJSON.Feature[]): ClusterFit | null {
  const coordinates = leaves.map(pointCoordinate).filter((coordinate): coordinate is ClusterCoordinate => coordinate !== null);
  if (!coordinates.length) return null;

  let west = coordinates[0][0];
  let east = west;
  let south = coordinates[0][1];
  let north = south;
  coordinates.forEach(([longitude, latitude]) => {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  });

  return {
    bounds: [[west, south], [east, north]],
    center: [(west + east) / 2, (south + north) / 2],
    coincident: west === east && south === north,
  };
}
