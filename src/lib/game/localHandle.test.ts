import { describe, expect, it } from "vitest";
import { GameError, type GameMe, type GamePlayer } from "./client";
import { claimLocalHandle, clearLocalHandle, readLocalHandle, saveLocalHandle } from "./localHandle";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("local handle", () => {
  it("keeps a normalized handle until it is cleared", () => {
    const storage = memoryStorage();
    saveLocalHandle(" @Fern_Walker ", storage);
    expect(readLocalHandle(storage)).toBe("fern_walker");
    clearLocalHandle(storage);
    expect(readLocalHandle(storage)).toBeNull();
  });

  it("ignores handles the server would refuse by shape", () => {
    const storage = memoryStorage();
    saveLocalHandle("ab", storage);
    expect(readLocalHandle(storage)).toBeNull();
    storage.setItem("parkdex-local-handle-v1", "no spaces here");
    expect(readLocalHandle(storage)).toBeNull();
  });

  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveLocalHandle("fern", broken)).not.toThrow();
    expect(readLocalHandle(broken)).toBeNull();
    expect(() => clearLocalHandle(broken)).not.toThrow();
  });
});

describe("claiming the local handle at sign-in", () => {
  const me = { player: null, flagSeed: "seed-1" } as unknown as GameMe;
  const fern = { handle: "fern_walker", flagSeed: "seed-1" } as GamePlayer;

  it("saves it for a player without a handle and forgets it", async () => {
    const storage = memoryStorage();
    saveLocalHandle("fern_walker", storage);
    const saved: string[] = [];
    const next = await claimLocalHandle(
      me,
      async (handle) => {
        saved.push(handle);
        return fern;
      },
      storage,
    );
    expect(saved).toEqual(["fern_walker"]);
    expect(next.player).toBe(fern);
    expect(readLocalHandle(storage)).toBeNull();
  });

  it("keeps it for the handle sheet when the server refuses it", async () => {
    const storage = memoryStorage();
    saveLocalHandle("fern_walker", storage);
    const next = await claimLocalHandle(me, () => Promise.reject(new Error("handle_taken")), storage);
    expect(next.player).toBeNull();
    expect(readLocalHandle(storage)).toBe("fern_walker");
  });

  it("forgets a handle the server refused, so it isn't sent on every launch", async () => {
    const storage = memoryStorage();
    saveLocalHandle("fern_walker", storage);
    const next = await claimLocalHandle(me, () => Promise.reject(new GameError("handle_rejected", 422, "Refused.")), storage);
    expect(next.player).toBeNull();
    expect(readLocalHandle(storage)).toBeNull();
  });

  it("leaves a player who already has a handle alone", async () => {
    const storage = memoryStorage();
    saveLocalHandle("fern_walker", storage);
    const named = { ...me, player: fern } as GameMe;
    const next = await claimLocalHandle(named, () => Promise.reject(new Error("not called")), storage);
    expect(next).toBe(named);
    expect(readLocalHandle(storage)).toBeNull();
  });

  it("does nothing without a local handle", async () => {
    const next = await claimLocalHandle(me, () => Promise.reject(new Error("not called")), memoryStorage());
    expect(next).toBe(me);
  });
});
