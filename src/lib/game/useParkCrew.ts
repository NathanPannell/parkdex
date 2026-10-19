import { useCallback, useEffect, useRef, useState } from "react";
import { fetchParkCrew, type Crew } from "./client";
import { useGame } from "./GameProvider";

export type ParkCrewState = { status: "idle" | "loading" | "ready" | "error"; crew: Crew | null };

/**
 * The crew at one park, read once when a park page or the code sheet opens (#171). Reading a
 * crew with its code records `crew_code_shown` on the server, so this is never polled.
 */
export function useParkCrew(parkId: string | null, active: boolean): ParkCrewState & { reload: () => void } {
  const game = useGame();
  const accountId = game.accountId;
  const [state, setState] = useState<ParkCrewState>({ status: "idle", crew: null });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (!active || !accountId || !parkId) {
      setState({ status: "idle", crew: null });
      return;
    }
    const ticket = latest.current + 1;
    latest.current = ticket;
    setState((current) => ({ status: "loading", crew: current.crew?.parkId === parkId ? current.crew : null }));
    fetchParkCrew(accountId, parkId)
      .then((answer) => {
        if (latest.current === ticket) setState({ status: "ready", crew: answer.crew });
      })
      .catch(() => {
        if (latest.current === ticket) setState((current) => ({ status: "error", crew: current.crew }));
      });
  }, [accountId, active, parkId, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, reload };
}

/** The server's clock, ticking while `active`, for countdowns. */
export function useServerClock(active: boolean, everyMs = 1000): number {
  const game = useGame();
  const serverNow = useRef(game.serverNow);
  serverNow.current = game.serverNow;
  const [now, setNow] = useState(() => game.serverNow());
  useEffect(() => {
    setNow(serverNow.current());
    if (!active) return;
    const timer = window.setInterval(() => setNow(serverNow.current()), everyMs);
    return () => window.clearInterval(timer);
  }, [active, everyMs]);
  return active ? now : game.serverNow();
}

type WakeLockSentinelLike = { release: () => Promise<void> };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> } };

/** Keeps the screen on while `active`, where the browser or WebView offers the Screen Wake Lock API. */
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    const wakeLock = typeof navigator === "undefined" ? undefined : (navigator as WakeLockNavigator).wakeLock;
    if (!active || !wakeLock) return;
    let live = true;
    let lock: WakeLockSentinelLike | null = null;
    const request = () => {
      wakeLock
        .request("screen")
        .then((sentinel) => {
          if (live) lock = sentinel;
          else void sentinel.release().catch(() => undefined);
        })
        .catch(() => undefined);
    };
    // The lock drops when the page is hidden; take it again on return.
    const onVisible = () => {
      if (live && document.visibilityState === "visible") request();
    };
    request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}
