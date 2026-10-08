import { App as CapacitorApp } from "@capacitor/app";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../accounts/AuthProvider";
import { isNative } from "../native";
import { fetchGameMe, gameErrorMessage, isOfflineError, saveHandle as sendHandle, type GameMe, type GamePlayer } from "./client";

/**
 * The signed-in player's game state from `/api/game/me`. V1 is online only, so this lives
 * in memory: it is fetched on sign-in and on return to the foreground, and never stored.
 */

export type GameStatus = "guest" | "loading" | "ready" | "offline" | "error";

type HandleRequest = { onDone?: (player: GamePlayer) => void };

type GameContextValue = {
  status: GameStatus;
  me: GameMe | null;
  error: string | null;
  accountId: string | null;
  refresh: () => Promise<GameMe | null>;
  saveHandle: (handle: string) => Promise<GamePlayer>;
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
      setMe((current) => ({ ...(current ?? { score: 0, parks: [], takeovers: [] }), player, flagSeed: player.flagSeed }));
      setStatus("ready");
    }
    return player;
  }, []);

  const value = useMemo<GameContextValue>(() => ({
    status,
    me,
    error,
    accountId,
    refresh,
    saveHandle,
    handleRequest,
    openHandleSheet: (request = {}) => setHandleRequest(request),
    closeHandleSheet: () => setHandleRequest(null),
  }), [status, me, error, accountId, refresh, saveHandle, handleRequest]);

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame() {
  const game = useContext(GameContext);
  if (!game) throw new Error("useGame outside GameProvider");
  return game;
}
