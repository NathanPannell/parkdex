import { afterEach, describe, expect, it, vi } from "vitest";
import { getCollectionRankProgress, getRarityProgress, setRankProgressionEnabled } from "./progression";
import { DEMO_START, load, persistOnboardingPreferences, reducer, type Claim } from "./store";
import type { Park, Rarity } from "./parks";

type StoreState = Parameters<typeof reducer>[0];

const park: Park = {
  id: "park-a",
  name: "Park A",
  short: "Park A",
  category: "regional",
  region: "Victoria",
  lat: 48.4,
  lng: -123.3,
  biome: "forest",
  shape: "circle",
  rarity: "common",
  seed: 1,
  blurb: "A local park.",
  scene: "forest-park-a",
};

const readyState: StoreState = {
  onboarded: true,
  claims: {},
  progressReady: true,
  progressError: null,
  progressOwnerKey: "guest",
  claimRevision: 0,
  claimRevisionByPark: {},
  user: [-123.3656, 48.4284],
  accuracy: null,
  located: null,
  locationError: null,
  muted: false,
  screen: "claim",
  startupReady: true,
  onboardingBuildId: "test-build",
  onboardingPackageIdentity: "app.parkdex:1790000000000:1790000000000:12",
  currentBuildId: "test-build",
  currentPackageIdentity: "app.parkdex:1790000000000:1790000000000:12",
  selectedId: null,
  tripId: park.id,
  pendingPhoto: "data:image/jpeg;base64,photo",
  focusId: null,
  feedback: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function restoredClaim(id: string, rarity: Rarity): Claim {
  const parkSnapshot = { ...park, id, name: id, short: id, rarity };
  return {
    claimId: `claim-${id}`,
    at: "2026-09-28T12:00:00.000Z",
    photo: "",
    parkSnapshot,
    contentReleaseId: "release-1",
  };
}

describe("claim progress hydration", () => {
  it("waits on the splash until the same build and package install are confirmed", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({
        onboarded: true,
        muted: true,
        onboardingBuildId: "source-sha",
        onboardingPackageIdentity: "app.parkdex:1790000000000:1790000000000:12",
      }),
    });

    const loaded = load();
    expect(loaded).toMatchObject({
      onboarded: true,
      muted: true,
      startupReady: false,
      screen: "splash",
      onboardingBuildId: "source-sha",
      onboardingPackageIdentity: "app.parkdex:1790000000000:1790000000000:12",
    });
    expect(reducer(loaded, {
      type: "installReady",
      buildId: "source-sha",
      packageInstallIdentity: "app.parkdex:1790000000000:1790000000000:12",
      native: true,
    })).toMatchObject({ onboarded: true, startupReady: true, screen: "splash" });
  });

  it("keeps the splash for a visitor who has not completed onboarding", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ onboarded: false }),
    });

    expect(load()).toMatchObject({ onboarded: false, startupReady: false, screen: "splash" });
  });

  it("does not let onboarding finish before package identity has been checked", () => {
    const state = load();

    expect(reducer(state, { type: "onboarded" })).toBe(state);
  });

  it("replays onboarding after a build change and keeps hydrated claims and photos", () => {
    const state: StoreState = {
      ...readyState,
      screen: "map",
      onboardingBuildId: "old-source-sha",
      onboardingPackageIdentity: "app.parkdex:1790000000000:1790000000000:12",
      claims: { [park.id]: restoredClaim(park.id, "common") },
      pendingPhoto: "data:image/jpeg;base64,kept-photo",
    };

    const next = reducer(state, {
      type: "installReady",
      buildId: "new-source-sha",
      packageInstallIdentity: "app.parkdex:1790000000000:1790000000000:12",
      native: true,
    });

    expect(next).toMatchObject({ onboarded: false, startupReady: true, screen: "splash" });
    expect(next.claims).toEqual(state.claims);
    expect(next.pendingPhoto).toBe(state.pendingPhoto);
    expect(next.progressOwnerKey).toBe(state.progressOwnerKey);
  });

  it("keeps a web visitor onboarded when they open a newer deploy", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ onboarded: true, muted: false, onboardingBuildId: "old-source-sha", onboardingPackageIdentity: null }),
    });

    expect(reducer(load(), {
      type: "installReady",
      buildId: "new-source-sha",
      packageInstallIdentity: null,
      native: false,
    })).toMatchObject({ onboarded: true, startupReady: true, screen: "splash" });
  });

  it("preserves the legacy claims and other local preferences when saving onboarding identity", () => {
    const stored = new Map([[
      "parkdex-mockup-v1",
      JSON.stringify({ claims: { "park-a": { at: "saved", photo: "old-photo" } }, unrelatedPreference: "keep" }),
    ]]);
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    };

    persistOnboardingPreferences(storage, {
      onboarded: true,
      muted: true,
      currentBuildId: "new-source-sha",
      currentPackageIdentity: "app.parkdex:1790000000000:1790000001000:13",
    });

    expect(JSON.parse(stored.get("parkdex-mockup-v1")!)).toEqual({
      claims: { "park-a": { at: "saved", photo: "old-photo" } },
      unrelatedPreference: "keep",
      onboarded: true,
      muted: true,
      onboardingBuildId: "new-source-sha",
      onboardingPackageIdentity: "app.parkdex:1790000000000:1790000001000:13",
    });
  });

  it("derives the same rank after owner claims are restored", () => {
    const restoredClaims: Record<string, Claim> = {};
    const catalogue: Pick<Park, "id" | "rarity">[] = [];
    for (const [rarity, count] of [["common", 3], ["uncommon", 3]] as const) {
      for (let index = 0; index < count; index += 1) {
        const id = `${rarity}-${index}`;
        restoredClaims[id] = restoredClaim(id, rarity);
        catalogue.push({ id, rarity });
      }
    }

    const restored = reducer({ ...readyState, claims: {}, progressReady: false }, {
      type: "progressLoaded",
      ownerKey: "guest",
      claims: restoredClaims,
    });
    // Ranks only exist while rank progression is switched on (it is off by default).
    setRankProgressionEnabled(true);
    const rank = getCollectionRankProgress(getRarityProgress(restored.claims, catalogue));
    setRankProgressionEnabled(false);

    expect(restored.progressReady).toBe(true);
    expect(rank).toMatchObject({ available: true, visited: 6, rank: { name: "Wayfinder" } });
  });

  it("keeps a ready owner's claim screen mounted during background refresh", () => {
    const next = reducer(readyState, { type: "progressLoading", ownerKey: "guest" });

    expect(next.progressReady).toBe(true);
    expect(next.screen).toBe("claim");
    expect(next.pendingPhoto).toBe(readyState.pendingPhoto);
  });

  it("does not let a read started before a durable claim overwrite that claim", () => {
    const afterClaim = reducer(readyState, {
      type: "claim",
      ownerKey: "guest",
      id: park.id,
      claimId: "new-claim",
      at: "2026-09-27T12:00:00.000Z",
      photo: readyState.pendingPhoto!,
      parkSnapshot: park,
      contentReleaseId: "release-1",
    });
    const afterStaleRead = reducer(afterClaim, {
      type: "progressLoaded",
      ownerKey: "guest",
      claimRevisionAtStart: 0,
      claims: {
        [park.id]: {
          claimId: "old-claim",
          at: "2026-09-26T12:00:00.000Z",
          photo: "old-claim-photo",
          parkSnapshot: park,
          contentReleaseId: "release-1",
        },
      },
    });

    expect(afterStaleRead.claims[park.id].claimId).toBe("new-claim");
    expect(afterStaleRead.claims[park.id].photo).toBe(readyState.pendingPhoto);
  });

  it("keeps a same-claim photo during metadata-only refresh", () => {
    const stateWithPhoto: StoreState = {
      ...readyState,
      claims: {
        [park.id]: {
          claimId: "same-claim",
          at: "2026-09-27T12:00:00.000Z",
          photo: "saved-photo",
          parkSnapshot: park,
          contentReleaseId: "release-1",
        },
      },
    };
    const afterMetadata = reducer(stateWithPhoto, {
      type: "progressLoaded",
      ownerKey: "guest",
      metadataOnly: true,
      claims: {
        [park.id]: {
          claimId: "same-claim",
          at: "2026-09-27T12:00:00.000Z",
          photo: "",
          parkSnapshot: park,
          contentReleaseId: "release-1",
        },
      },
    });

    expect(afterMetadata.progressReady).toBe(true);
    expect(afterMetadata.claims[park.id].photo).toBe("saved-photo");
  });

  it("keeps metadata ready when later photo hydration fails", () => {
    const afterMetadata = reducer({ ...readyState, claims: {}, progressReady: false }, {
      type: "progressLoaded",
      ownerKey: "guest",
      metadataOnly: true,
      claims: { [park.id]: restoredClaim(park.id, "common") },
    });
    const afterPhotoFailure = reducer(afterMetadata, {
      type: "progressFailed",
      ownerKey: "guest",
      message: "Some saved photos could not be opened. Your saved parks are still available.",
    });

    expect(afterPhotoFailure.progressReady).toBe(true);
    expect(afterPhotoFailure.claims[park.id].claimId).toBe(`claim-${park.id}`);
    expect(afterPhotoFailure.progressError).toBe("Some saved photos could not be opened. Your saved parks are still available.");
  });

  it("accepts a newer visit from a read that started after the local claim", () => {
    const afterClaim = reducer(readyState, {
      type: "claim",
      ownerKey: "guest",
      id: park.id,
      claimId: "local-claim",
      at: "2026-09-27T12:00:00.000Z",
      photo: readyState.pendingPhoto!,
      parkSnapshot: park,
      contentReleaseId: "release-1",
    });
    const afterFreshRead = reducer(afterClaim, {
      type: "progressLoaded",
      ownerKey: "guest",
      claimRevisionAtStart: afterClaim.claimRevision,
      claims: {
        [park.id]: {
          claimId: "restored-newer-claim",
          at: "2026-09-27T13:00:00.000Z",
          photo: "restored-photo",
          parkSnapshot: park,
          contentReleaseId: "release-1",
        },
      },
    });

    expect(afterFreshRead.claims[park.id].claimId).toBe("restored-newer-claim");
    expect(afterFreshRead.claims[park.id].photo).toBe("restored-photo");
  });

  it("still clears the old owner's claim screen when ownership changes", () => {
    const next = reducer(readyState, { type: "progressLoading", ownerKey: "account:new-owner" });
    const afterStaleResult = reducer(next, {
      type: "progressLoaded",
      ownerKey: "guest",
      claims: { [park.id]: restoredClaim(park.id, "common") },
    });

    expect(afterStaleResult.progressReady).toBe(false);
    expect(afterStaleResult.screen).toBe("map");
    expect(afterStaleResult.claims).toEqual({});
    expect(afterStaleResult.pendingPhoto).toBeNull();
    expect(afterStaleResult.progressOwnerKey).toBe("account:new-owner");
  });
});

describe("player location", () => {
  const storage = (lastLocation: unknown) => ({
    getItem: (key: string) => (key === "parkdex-last-location-v1" ? JSON.stringify(lastLocation) : JSON.stringify({ onboarded: true })),
  });

  it("starts from the last real position inside a province instead of the demo spot", () => {
    vi.stubGlobal("localStorage", storage([-63.5752, 44.6488]));
    expect(load()).toMatchObject({ user: [-63.5752, 44.6488], located: [-63.5752, 44.6488], accuracy: null });
  });

  it("starts from the demo spot without a saved position, or with one outside every province", () => {
    vi.stubGlobal("localStorage", storage(null));
    expect(load()).toMatchObject({ user: DEMO_START, located: null });
    vi.stubGlobal("localStorage", storage([-79.38, 43.65]));
    expect(load()).toMatchObject({ user: DEMO_START, located: null });
  });

  it("remembers real fixes but not demo moves", () => {
    const located = reducer(readyState, { type: "move", user: [-63.57, 44.62], accuracy: 12 });
    expect(located.located).toEqual([-63.57, 44.62]);
    const teleported = reducer(located, { type: "move", user: [-63.6, 44.7], accuracy: null });
    expect(teleported.user).toEqual([-63.6, 44.7]);
    expect(teleported.located).toEqual([-63.57, 44.62]);
  });
});

describe("flag visits", () => {
  it("returns a plant screen to the map when the account changes", () => {
    const planting = { ...reducer(load(), { type: "trip", id: "blueberry" }), progressOwnerKey: "guest", screen: "plant" as const };
    const next = reducer(planting, { type: "progressLoading", ownerKey: "account:new-owner" });
    expect(next.screen).toBe("map");
    expect(next.tripId).toBeNull();
  });
});
