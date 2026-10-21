import { GameError, handleProblem, normalizeHandle, type GameMe, type GamePlayer } from "./client";

const KEY = "parkdex-local-handle-v1";
const FLAG_KEY = "parkdex-local-flag-v1";
const FLAG_SEED = /^[0-9a-f]{16}$/;

/**
 * The @handle picked during onboarding, kept on this device until the player signs in. The
 * first signed-in load of the game claims it for the account, so the handle sheet never has to
 * ask again; if someone else already has it, the sheet opens with it filled in.
 */
export function readLocalHandle(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string | null {
  try {
    const value = normalizeHandle(storage?.getItem(KEY) ?? "");
    return value && !handleProblem(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveLocalHandle(handle: string, storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage()): void {
  const value = normalizeHandle(handle);
  if (!value || handleProblem(value)) return;
  try {
    storage?.setItem(KEY, value);
    // The flag that goes with it, shown on the map until sign-in and kept by the account after.
    if (!readLocalFlagSeed(storage)) storage?.setItem(FLAG_KEY, newFlagSeed());
  } catch {
    // Private windows and full storage only mean the handle is asked for again at sign-in.
  }
}

/** The flag picked with the local handle, or null before onboarding saved one. */
export function readLocalFlagSeed(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string | null {
  try {
    const value = storage?.getItem(FLAG_KEY) ?? null;
    return value && FLAG_SEED.test(value) ? value : null;
  } catch {
    return null;
  }
}

function newFlagSeed(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function clearLocalHandle(storage: Pick<Storage, "removeItem"> | undefined = safeStorage()): void {
  try {
    storage?.removeItem(KEY);
    storage?.removeItem(FLAG_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Gives a signed-in player without a handle the one picked during onboarding. A taken or refused
 * handle stays on the device, so the handle sheet opens with it filled in.
 */
export async function claimLocalHandle(
  me: GameMe,
  save: (handle: string) => Promise<GamePlayer>,
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined = safeStorage(),
): Promise<GameMe> {
  if (me.player) {
    clearLocalHandle(storage);
    return me;
  }
  const local = readLocalHandle(storage);
  if (!local) return me;
  try {
    const player = await save(local);
    clearLocalHandle(storage);
    return { ...me, player, flagSeed: player.flagSeed };
  } catch (error) {
    // A refused handle would only be refused again, and each try costs a moderation check.
    if (error instanceof GameError && (error.code === "handle_rejected" || error.code === "invalid_handle")) clearLocalHandle(storage);
    return me;
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
