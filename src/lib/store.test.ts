import { describe, expect, it } from "vitest";
import { getCollectionRankProgress, getRarityProgress } from "./progression";
import { reducer, type Claim } from "./store";
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
  locationError: null,
  muted: false,
  screen: "claim",
  selectedId: null,
  tripId: park.id,
  shareClaimId: null,
  pendingPhoto: "data:image/jpeg;base64,photo",
  focusId: null,
  feedback: null,
};

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
    const rank = getCollectionRankProgress(getRarityProgress(restored.claims, catalogue));

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
          photo: "",
          parkSnapshot: park,
          contentReleaseId: "release-1",
        },
      },
    });

    expect(afterStaleRead.claims[park.id].claimId).toBe("new-claim");
    expect(afterStaleRead.claims[park.id].photo).toBe(readyState.pendingPhoto);
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

    expect(next.progressReady).toBe(false);
    expect(next.screen).toBe("map");
    expect(next.claims).toEqual({});
    expect(next.pendingPhoto).toBeNull();
    expect(next.progressOwnerKey).toBe("account:new-owner");
  });
});
