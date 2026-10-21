import assert from "node:assert/strict";
import { test } from "node:test";
import { markerPoint, positionInside, toleranceFor, validatePosition } from "./parkLocation.ts";
import { pointInMultiPolygon, type MultiPolygon, type Position } from "./osmParks.ts";
import { HttpError } from "./validation.ts";

const box = (west: number, south: number, east: number, north: number): Position[] => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];
// Paterson Park in Ladner, about 290 m by 245 m, plus a separate far part with a pond.
const PATERSON: MultiPolygon = { type: "MultiPolygon", coordinates: [[box(-123.062, 49.088, -123.058, 49.0902)]] };
const TWO_PARTS: MultiPolygon = {
  type: "MultiPolygon",
  coordinates: [[box(-123.1, 49.07, -123.09, 49.08), box(-123.097, 49.073, -123.093, 49.077)], [box(-123.05, 49.07, -123.049, 49.071)]],
};
// About one metre of longitude at this latitude.
const M_LNG = 1 / (111_320 * Math.cos((49.089 * Math.PI) / 180));

test("the tolerance follows the reported accuracy between 10 and 35 m", () => {
  assert.equal(toleranceFor(0), 10);
  assert.equal(toleranceFor(4), 10);
  assert.equal(toleranceFor(22), 22);
  assert.equal(toleranceFor(35), 35);
  assert.equal(toleranceFor(80), 35);
});

test("inside the outline counts whatever the accuracy", () => {
  assert.deepEqual(positionInside({ lat: 49.089, lng: -123.06, accuracyM: 5 }, PATERSON), { inside: true, distanceM: 0 });
});

test("a position just outside the edge counts only within the accuracy", () => {
  const west = -123.062;
  const outside = (metres: number, accuracyM: number) => positionInside({ lat: 49.089, lng: west - metres * M_LNG, accuracyM }, PATERSON);
  assert.equal(outside(8, 3).inside, true, "8 m out counts with the 10 m floor");
  assert.equal(outside(12, 3).inside, false, "12 m out is too far for a precise fix");
  assert.equal(outside(12, 20).inside, true, "12 m out counts with a 20 m fix");
  assert.equal(outside(30, 60).inside, true, "30 m out counts with the 35 m cap");
  assert.equal(outside(40, 60).inside, false, "40 m out is past the cap");
  assert.ok(Math.abs(outside(30, 60).distanceM - 30) < 1);
});

test("a position in a hole is outside the park", () => {
  assert.equal(positionInside({ lat: 49.075, lng: -123.095, accuracyM: 5 }, TWO_PARTS).inside, false);
});

test("positions are validated strictly and imprecise fixes are refused", () => {
  assert.deepEqual(validatePosition({ lat: 49.089, lng: -123.06, accuracyM: 12.5 }), { lat: 49.089, lng: -123.06, accuracyM: 12.5 });
  assert.deepEqual(validatePosition({ lat: 49.089, lng: -123.06, accuracyM: 100 }).accuracyM, 100);
  for (const bad of [
    null,
    [],
    {},
    { lat: 49, lng: -123 },
    { lat: 49, lng: -123, accuracyM: 5, extra: 1 },
    { lat: "49", lng: -123, accuracyM: 5 },
    { lat: 91, lng: -123, accuracyM: 5 },
    { lat: 49, lng: -181, accuracyM: 5 },
    { lat: 49, lng: -123, accuracyM: -1 },
    { lat: Number.NaN, lng: -123, accuracyM: 5 },
  ]) {
    assert.throws(
      () => validatePosition(bad),
      (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === "invalid_position",
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => validatePosition({ lat: 49, lng: -123, accuracyM: 101 }),
    (error: unknown) => error instanceof HttpError && error.status === 422 && error.code === "location_imprecise" && /not precise enough/.test(error.message),
  );
});

test("a new park's marker is inside the part the founder stands in, and is not the founder's position", () => {
  const founder = { lat: 49.0885, lng: -123.0615 };
  const marker = markerPoint(PATERSON, founder);
  assert.ok(pointInMultiPolygon(marker, PATERSON));
  assert.notDeepEqual(marker, [founder.lng, founder.lat]);
  // In the far part of a two-part park, the marker goes in that part.
  const far = markerPoint(TWO_PARTS, { lat: 49.0705, lng: -123.0495 });
  assert.ok(pointInMultiPolygon(far, { type: "MultiPolygon", coordinates: [TWO_PARTS.coordinates[1]] }));
  // The big part's centroid is in its pond, so the marker moves to a point that is really inside.
  const big = markerPoint(TWO_PARTS, { lat: 49.071, lng: -123.099 });
  assert.ok(pointInMultiPolygon(big, TWO_PARTS));
});
