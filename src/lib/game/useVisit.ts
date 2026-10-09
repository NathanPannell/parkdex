import { useCallback } from "react";
import { useToast } from "../../components/Toast";
import { useAuth } from "../accounts/AuthProvider";
import { buzz } from "../feedback";
import { useStore } from "../store";
import { useGame } from "./GameProvider";
import { hasVisitedToday, nextVisitStep, parkHolder, visitLabel, type ParkHolder } from "./visit";

/** Starts a flag visit from any check-in button: sign in, pick a handle, then plant. */
export function useVisit() {
  const { dispatch } = useStore();
  const auth = useAuth();
  const game = useGame();
  const toast = useToast();
  // An account that is offline still counts as signed in; the visit then explains it needs a connection.
  const signedIn = auth.phase === "authenticated" || auth.phase === "offline-account";
  const myHandle = game.me?.player?.handle ?? null;
  const flags = game.flags?.byPark ?? null;

  const holderOf = useCallback((parkId: string): ParkHolder => parkHolder(parkId, flags, myHandle), [flags, myHandle]);
  // One visit per park counts each day, so a second one is never offered.
  const visitedToday = useCallback((parkId: string) => signedIn && hasVisitedToday(game.me, parkId, game.serverNow()), [game, signedIn]);

  const start = useCallback((parkId: string) => {
    if (visitedToday(parkId)) {
      buzz(20);
      toast("You visited this park today. Come back tomorrow.", "kip");
      return;
    }
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
  }, [dispatch, game, signedIn, toast, visitedToday]);

  const labelFor = useCallback((parkId: string) => visitLabel(signedIn, holderOf(parkId), visitedToday(parkId)), [holderOf, signedIn, visitedToday]);

  return { signedIn, holderOf, visitedToday, start, labelFor };
}
