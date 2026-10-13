import { describe, expect, it } from "vitest";
import { PROVINCES } from "../../worker/provinces";
import { CONTENT_AREAS, contentAreaAt, nearestContentArea, type MapPoint } from "./content/contracts";
import { NO_LOCATION_MESSAGE, onboardingStart, OUTSIDE_PROVINCES_MESSAGE, startingMapView, USER_ZOOM } from "./provinces";
import { DEMO_START } from "./store";

const VICTORIA: MapPoint = [-123.3656, 48.4284];
const HALIFAX: MapPoint = [-63.5752, 44.6488];
const TORONTO: MapPoint = [-79.3832, 43.6532];
const SEATTLE: MapPoint = [-122.33, 47.61];

describe("supported provinces", () => {
  it("are the same on the app and the API", () => {
    expect(PROVINCES.map(({ name, box }) => ({ name, box }))).toEqual(CONTENT_AREAS.map(({ name, box }) => ({ name, box })));
  });

  it("name the province that holds a point, and the nearest one elsewhere", () => {
    expect(contentAreaAt(VICTORIA)?.name).toBe("British Columbia");
    expect(contentAreaAt(HALIFAX)?.name).toBe("Nova Scotia");
    expect(contentAreaAt(TORONTO)).toBeNull();
    expect(contentAreaAt([Number.NaN, 44])).toBeNull();
    expect(nearestContentArea(TORONTO).name).toBe("Nova Scotia");
    expect(nearestContentArea(SEATTLE).name).toBe("British Columbia");
    expect(nearestContentArea(HALIFAX).anchor).toEqual(HALIFAX);
  });
});

describe("onboarding start", () => {
  it("uses the player's own position anywhere in BC or Nova Scotia", () => {
    expect(onboardingStart(VICTORIA)).toEqual({ kind: "located", point: VICTORIA });
    expect(onboardingStart(HALIFAX)).toEqual({ kind: "located", point: HALIFAX });
    // Far from Victoria but still inside the provinces: Prince George and Cape Breton.
    expect(onboardingStart([-122.75, 53.92]).kind).toBe("located");
    expect(onboardingStart([-60.65, 46.73]).kind).toBe("located");
  });

  it("uses the demo spot only outside every province, without mentioning the Island", () => {
    expect(onboardingStart(TORONTO)).toEqual({ kind: "demo", message: OUTSIDE_PROVINCES_MESSAGE });
    expect(onboardingStart(null)).toEqual({ kind: "demo", message: NO_LOCATION_MESSAGE });
    for (const message of [OUTSIDE_PROVINCES_MESSAGE, NO_LOCATION_MESSAGE]) {
      expect(message).not.toMatch(/island/i);
      expect(message).toMatch(/demo spot in Victoria/);
    }
    expect(DEMO_START).toEqual(VICTORIA);
  });
});

describe("starting map view", () => {
  it("opens on the player's spot in builds without live GPS", () => {
    expect(startingMapView(false, HALIFAX, VICTORIA)).toEqual({ center: HALIFAX, zoom: 12 });
  });

  it("opens on the last known location inside a province", () => {
    expect(startingMapView(true, DEMO_START, HALIFAX)).toEqual({ center: HALIFAX, zoom: USER_ZOOM });
    expect(startingMapView(true, DEMO_START, VICTORIA)).toEqual({ center: VICTORIA, zoom: USER_ZOOM });
  });

  it("frames British Columbia with no location, and the nearest province from outside them", () => {
    const bc = startingMapView(true, DEMO_START, null);
    expect(bc).toEqual({ center: [-125.5, 53.8], zoom: 4.6 });
    const ns = startingMapView(true, DEMO_START, TORONTO);
    expect(contentAreaAt(ns.center)?.name).toBe("Nova Scotia");
    expect(ns.zoom).toBeLessThan(7);
    expect(startingMapView(true, DEMO_START, SEATTLE)).toEqual(bc);
  });
});
