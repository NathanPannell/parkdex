import { useCallback } from "react";
import { useAuth } from "../accounts/AuthProvider";
import { useStore } from "../store";
import { useGame } from "./GameProvider";
import { nextVisitStep, parkHolder, visitLabel, type ParkHolder } from "./visit";

/** Starts a flag visit from any check-in button: sign in, pick a handle, then plant. */
export function useVisit() {
  const { dispatch } = useStore();
  const auth = useAuth();
  const game = useGame();
  // An account that is offline still counts as signed in; the visit then explains it needs a connection.
  const signedIn = auth.phase === "authenticated" || auth.phase === "offline-account";
  const myHandle = game.me?.player?.handle ?? null;
  const flags = game.flags?.byPark ?? null;

  const holderOf = useCallback((parkId: string): ParkHolder => parkHolder(parkId, flags, myHandle), [flags, myHandle]);

  const start = useCallback((parkId: string) => {
    const plant = () => {
      dispatch({ type: "trip", id: parkId });
      dispatch({ type: "select", id: null });
      dispatch({ type: "go", screen: "plant" });
    };
    const step = nextVisitStep(signedIn, game.me);
    if (step === "sign-in") {
      dispatch({ type: "select", id: null });
      dispatch({ type: "go", screen: "account" });
    } else if (step === "pick-handle") {
      game.openHandleSheet({ onDone: plant });
    } else {
      plant();
    }
  }, [dispatch, game, signedIn]);

  const labelFor = useCallback((parkId: string) => visitLabel(signedIn, holderOf(parkId)), [holderOf, signedIn]);

  return { signedIn, holderOf, start, labelFor };
}
