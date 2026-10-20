import { GameError, handleProblem, normalizeHandle, type GameMe, type GamePlayer } from "./client";

const KEY = "parkdex-local-handle-v1";

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

export function saveLocalHandle(handle: string, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  const value = normalizeHandle(handle);
  if (!value || handleProblem(value)) return;
  try {
    storage?.setItem(KEY, value);
  } catch {
    // Private windows and full storage only mean the handle is asked for again at sign-in.
  }
}

export function clearLocalHandle(storage: Pick<Storage, "removeItem"> | undefined = safeStorage()): void {
  try {
    storage?.removeItem(KEY);
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
