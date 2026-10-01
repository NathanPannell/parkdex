import { describe, expect, it } from "vitest";
import { estimateTrip, finalWalk, formatTrip } from "./drive";
import type { DriveData } from "./content/contracts";
import type { Park } from "./parks";

const park: Park = {
  id: "regional-unknown-access-park",
  name: "Unknown Access Park",
  short: "Unknown Park",
  category: "regional",
  region: "South Island",
  lat: 48.4,
  lng: -123.3,
  biome: "coast",
  shape: "circle",
  rarity: "common",
  seed: 1,
  blurb: "A test park.",
  scene: null,
};

const hubs = [{ name: "Victoria", lng: -123.3, lat: 48.4 }];
const unknownDrive: DriveData = {
  hubs,
  parks: { [park.id]: { drive: [null], walkM: 0 } },
};

describe("park access estimates", () => {
  it("treats the all-null legacy route sentinel as unknown before the nearby walking estimate", () => {
    const trip = estimateTrip([-123.301, 48.4], park, unknownDrive);

    expect(trip.mode).toBe("unknown");
    expect(trip.minutes).toBe(0);
    expect(formatTrip(trip)).toBe("Access details unavailable");
    expect(finalWalk(park, unknownDrive)).toEqual({ label: "Unavailable", minutes: null });
  });

  it("keeps all-null routes unknown even when an older row has a nonzero walk value", () => {
    const olderData: DriveData = {
      hubs,
      parks: { [park.id]: { drive: [null], walkM: 10_388 } },
    };

    expect(estimateTrip([-123.4, 48.4], park, olderData).mode).toBe("unknown");
    expect(finalWalk(park, olderData)).toEqual({ label: "Unavailable", minutes: null });
  });

  it("treats missing access records as unavailable instead of inventing a boat or roadside route", () => {
    expect(estimateTrip([-123.4, 48.4], park).mode).toBe("unknown");
    expect(finalWalk(park)).toEqual({ label: "Unavailable", minutes: null });
  });

  it("preserves numeric road and final-walk estimates", () => {
    const knownDrive: DriveData = {
      hubs,
      parks: { [park.id]: { drive: [[12, 20]], walkM: 150 } },
    };
    const trip = estimateTrip([-123.33, 48.4], park, knownDrive);

    expect(trip.mode).toBe("drive");
    expect(trip.minutes).toBeGreaterThan(0);
    expect(formatTrip(trip)).toMatch(/ drive$/);
    expect(finalWalk(park, knownDrive)).toEqual({ label: "2 min", minutes: 2 });
  });

  it("keeps a numeric zero final walk as roadside when road access is known", () => {
    const knownDrive: DriveData = {
      hubs,
      parks: { [park.id]: { drive: [[12, 20]], walkM: 0 } },
    };

    expect(finalWalk(park, knownDrive)).toEqual({ label: "Roadside", minutes: 0 });
  });

  it("returns unavailable for a null final-walk value encountered at runtime", () => {
    const missingWalk = {
      hubs,
      parks: { [park.id]: { drive: [[12, 20]], walkM: null } },
    } as unknown as DriveData;

    expect(finalWalk(park, missingWalk)).toEqual({ label: "Unavailable", minutes: null });
  });
});
