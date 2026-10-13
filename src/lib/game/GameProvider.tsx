import { App as CapacitorApp } from "@capacitor/app";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../accounts/AuthProvider";
import { isNative } from "../native";
import { fetchFlags, fetchGameMe, gameErrorMessage, isOfflineError, saveHandle as sendHandle, savePatches as sendPatches, type GameMe, type GamePlayer, type ParkFlag, type ParkFounder } from "./client";

/**
 * The signed-in player's game state from `/api/game/me`. V1 is online only, so this lives
 * in memory: it is fetched on sign-in and on return to the foreground, and never stored.
 */

export type GameStatus = "guest" | "loading" | "ready" | "offline" | "error";
export type FlagsStatus = "loading" | "ready" | "offline" | "error";

/** Flags currently flying, with the server clock they were read against. */
export type FlagBoard = {
  byPark: ReadonlyMap<string, ParkFlag>;
  /** Founded parks and their cover photos, read with the flags. */
  founders: ReadonlyMap<string, ParkFounder>;
  /** Milliseconds to add to this device's clock to get the server's. */
  clockOffset: number;
};

// The map refreshes flags this often while the app is in the foreground.
const FLAG_POLL_MS = 120_000;

type HandleRequest = { onDone?: (player: GamePlayer) => void };

type GameContextValue = {
  status: GameStatus;
  me: GameMe | null;
  error: string | null;
  accountId: string | null;
  refresh: () => Promise<GameMe | null>;
  saveHandle: (handle: string) => Promise<GamePlayer>;
  /** Sews up to 3 unlocked badges onto the player's flag (#175). */
  savePatches: (patches: string[]) => Promise<string[]>;
  flags: FlagBoard | null;
  flagsStatus: FlagsStatus;
  refreshFlags: () => Promise<void>;
  /** The server's current time, for flag ages. */
  serverNow: () => number;
  handleRequest: HandleRequest | null;
  openHandleSheet: (request?: HandleRequest) => void;
  closeHandleSheet: () => void;
};

const GameContext = createContext<GameContextValue | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const accountId = auth.phase === "authenticated" ? auth.account?.id ?? null : null;
  const [me, setMe] = useState<GameMe | null>(null);
  const [status, setStatus] = useState<GameStatus>(accountId ? "loading" : "guest");
  const [error, setError] = useState<string | null>(null);
  const [handleRequest, setHandleRequest] = useState<HandleRequest | null>(null);
  const currentAccount = useRef(accountId);
  currentAccount.current = accountId;
  const inFlight = useRef<Promise<GameMe | null> | null>(null);
  const [flags, setFlags] = useState<FlagBoard | null>(null);
  const [flagsStatus, setFlagsStatus] = useState<FlagsStatus>("loading");
  const flagsInFlight = useRef<Promise<void> | null>(null);

  const refreshFlags = useCallback(async () => {
    if (flagsInFlight.current) return flagsInFlight.current;
    const work = (async () => {
      try {
        const board = await fetchFlags();
        const serverTime = Date.parse(board.serverTime);
        setFlags({
          byPark: new Map(board.flags.map((flag) => [flag.parkId, flag])),
          founders: new Map(board.founders.map((founder) => [founder.parkId, founder])),
          clockOffset: Number.isFinite(serverTime) ? serverTime - Date.now() : 0,
        });
        setFlagsStatus("ready");
      } catch (caught) {
        // Online only: without a fresh answer the map shows parks without flags.
        setFlags(null);
        setFlagsStatus(isOfflineError(caught) ? "offline" : "error");
      } finally {
        flagsInFlight.current = null;
      }
    })();
    flagsInFlight.current = work;
    return work;
  }, []);

  useEffect(() => {
    void refreshFlags();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshFlags();
    }, FLAG_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshFlags();
    };
    const onOnline = () => void refreshFlags();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [refreshFlags]);

  const refresh = useCallback(async () => {
    const owner = currentAccount.current;
    if (!owner) return null;
    if (inFlight.current) return inFlight.current;
    const work = (async () => {
      try {
        const next = await fetchGameMe(owner);
        if (currentAccount.current !== owner) return null;
        setMe(next);
        setStatus("ready");
        setError(null);
        return next;
      } catch (caught) {
        if (currentAccount.current !== owner) return null;
        setStatus(isOfflineError(caught) ? "offline" : "error");
        setError(gameErrorMessage(caught));
        return null;
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = work;
    return work;
  }, []);

  // A different account, or signing out, drops the previous player's state at once.
  useEffect(() => {
    setMe(null);
    setError(null);
    setHandleRequest(null);
    inFlight.current = null;
    if (!accountId) {
      setStatus("guest");
      return;
    }
    setStatus("loading");
    void refresh();
  }, [accountId, refresh]);

  useEffect(() => {
    if (!accountId) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    let removeNative: (() => void) | undefined;
    if (isNative) {
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) void refresh();
      }).then((handle) => { removeNative = () => void handle.remove(); }).catch(() => {});
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      removeNative?.();
    };
  }, [accountId, refresh]);

  const saveHandle = useCallback(async (handle: string) => {
    const owner = currentAccount.current;
    if (!owner) throw new Error("Sign in to pick a handle.");
    const player = await sendHandle(owner, handle);
    if (currentAccount.current === owner) {
      setMe((current) => ({ ...(current ?? { score: 0, parks: [], takeovers: [], visitedToday: [], visitedTodayUntil: null }), player, flagSeed: player.flagSeed }));
      setStatus("ready");
    }
    return player;
  }, []);

  const savePatches = useCallback(async (patches: string[]) => {
    const owner = currentAccount.current;
    if (!owner) throw new Error("Sign in to wear badges.");
    const saved = await sendPatches(owner, patches);
    if (currentAccount.current === owner) setMe((current) => (current ? { ...current, flagPatches: saved } : current));
    // The player's own pins show the new patches.
    void refreshFlags();
    return saved;
  }, [refreshFlags]);

  const value = useMemo<GameContextValue>(() => ({
    status,
    me,
    error,
    accountId,
    refresh,
    saveHandle,
    savePatches,
    flags,
    flagsStatus,
    refreshFlags,
    serverNow: () => Date.now() + (flags?.clockOffset ?? 0),
    handleRequest,
    openHandleSheet: (request = {}) => setHandleRequest(request),
    closeHandleSheet: () => setHandleRequest(null),
  }), [status, me, error, accountId, refresh, saveHandle, savePatches, flags, flagsStatus, refreshFlags, handleRequest]);

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame() {
  const game = useContext(GameContext);
  if (!game) throw new Error("useGame outside GameProvider");
  return game;
}
