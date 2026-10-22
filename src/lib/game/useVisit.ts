import { useCallback } from "react";
import { useToast } from "../../components/Toast";
import { useAuth } from "../accounts/AuthProvider";
import { buzz } from "../feedback";
import { useStore } from "../store";
import { formatClockTime, protectionPhase, type ProtectionPhase } from "./protection";
import { useGame } from "./GameProvider";
import { hasVisitedToday, nextVisitStep, parkHolder, visitLabel, visitShortLabel, type ParkHolder } from "./visit";

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
  const heldParks = game.me?.parks ?? null;

  const holderOf = useCallback((parkId: string): ParkHolder => parkHolder(parkId, flags, myHandle, heldParks), [flags, myHandle, heldParks]);
  // One visit per park counts each day, so a second one is never offered.
  const visitedToday = useCallback((parkId: string) => signedIn && hasVisitedToday(game.me, parkId, game.serverNow()), [game, signedIn]);
  // Where the player stands with the park's protected hour (#170, every build), from the map's flags.
  const protectionOf = useCallback(
    (parkId: string): ProtectionPhase => protectionPhase({ flag: flags?.get(parkId), myHandle, me: signedIn ? game.me : null, now: game.serverNow() }),
    [flags, game, myHandle, signedIn],
  );

  const goPlant = useCallback(
    (parkId: string) => {
      dispatch({ type: "trip", id: parkId });
      dispatch({ type: "select", id: null });
      dispatch({ type: "go", screen: "plant" });
    },
    [dispatch],
  );

  const start = useCallback(
    (parkId: string) => {
      if (visitedToday(parkId)) {
        buzz(20);
        toast("You visited this park today. Come back tomorrow.", "kip");
        return;
      }
      const phase = protectionOf(parkId);
      if (phase.kind === "outsider" && phase.logged) {
        buzz(20);
        toast(`Visit logged. Come back after ${formatClockTime(phase.until)} to take this park.`, "kip");
        return;
      }
      const step = nextVisitStep(signedIn, game.me);
      if (step === "sign-in") {
        // After signing in, the map picks the visit up again.
        dispatch({ type: "signInFor", resume: { kind: "visit", parkId } });
      } else if (step === "pick-handle") {
        game.openHandleSheet({ onDone: () => goPlant(parkId) });
      } else {
        goPlant(parkId);
      }
    },
    [protectionOf, dispatch, game, goPlant, signedIn, toast, visitedToday],
  );

  const labelFor = useCallback(
    (parkId: string) => visitLabel(signedIn, holderOf(parkId), visitedToday(parkId), protectionOf(parkId)),
    [protectionOf, holderOf, signedIn, visitedToday],
  );
  const shortLabelFor = useCallback(
    (parkId: string) => (signedIn ? visitShortLabel(holderOf(parkId), visitedToday(parkId), protectionOf(parkId)) : "Plant!"),
    [protectionOf, holderOf, signedIn, visitedToday],
  );

  return { signedIn, holderOf, visitedToday, protectionOf, start, labelFor, shortLabelFor };
}
