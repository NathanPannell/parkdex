export function buildBoundaryIndex(collection) {
  const boundsById = {};
  for (const feature of collection.features) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    const visit = (value) => {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
        west = Math.min(west, value[0]);
        south = Math.min(south, value[1]);
        east = Math.max(east, value[0]);
        north = Math.max(north, value[1]);
        return;
      }
      value.forEach(visit);
    };
    visit(feature.geometry.coordinates);
    if (!Number.isFinite(west)) throw new Error(`${feature.properties.id}: geometry has no finite coordinates`);
    boundsById[feature.properties.id] = [[west, south], [east, north]];
  }
  return { version: 1, boundsById };
}

export function serializeBoundaryIndex(index) {
  return `${JSON.stringify(index)}\n`;
}
