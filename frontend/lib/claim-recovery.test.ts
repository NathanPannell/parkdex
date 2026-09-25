import { describe, expect, it } from "vitest";

import { createClaimRecoveryStore } from "./claim-recovery";
import type { KeyValueStore } from "./platform-storage";

function memoryStore() {
  const values = new Map<string, string>();
  const store: KeyValueStore = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
  };
  return { store, values };
}

describe("claim recovery markers", () => {
  it("persists unresolved creates by owner and place without storing the request token", async () => {
    const storage = memoryStore();
    const recovery = createClaimRecoveryStore(storage.store);

    await recovery.markUnresolvedClaim("account:user-1", "park-a", true);

    expect(await recovery.loadUnresolvedClaim("account:user-1", "park-a")).toMatchObject({ placeId: "park-a", photoExpected: true });
    expect(await recovery.loadUnresolvedClaim("account:user-2", "park-a")).toBeNull();
    expect(await recovery.hasUnresolvedClaim("account:user-1")).toBe(true);
    expect([...storage.values.values()].join(" ")).not.toContain("recommendation-token");
  });

  it("updates photo intent and clears places independently", async () => {
    const recovery = createClaimRecoveryStore(memoryStore().store);
    await recovery.markUnresolvedClaim("account:user-1", "park-a", true);
    await recovery.markUnresolvedClaim("account:user-1", "park-a", false);
    await recovery.markUnresolvedClaim("account:user-1", "park-b", false);

    expect((await recovery.loadUnresolvedClaim("account:user-1", "park-a"))?.photoExpected).toBe(false);
    await recovery.clearUnresolvedClaim("account:user-1", "park-a");
    expect(await recovery.loadUnresolvedClaim("account:user-1", "park-a")).toBeNull();
    expect(await recovery.hasUnresolvedClaim("account:user-1")).toBe(true);
    await recovery.clearUnresolvedClaims("account:user-1");
    expect(await recovery.hasUnresolvedClaim("account:user-1")).toBe(false);
  });
});
