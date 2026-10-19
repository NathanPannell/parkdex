import { useCallback } from "react";
import { useToast } from "../../components/Toast";
import { useAuth } from "../accounts/AuthProvider";
import { buzz } from "../feedback";
import { useStore } from "../store";
import { crewPhase, formatClockTime, type CrewPhase } from "./crew";
import { useCrew } from "./CrewProvider";
import { useGame } from "./GameProvider";
import { hasVisitedToday, nextVisitStep, parkHolder, visitLabel, visitShortLabel, type ParkHolder } from "./visit";

/** Starts a flag visit from any check-in button: sign in, pick a handle, then plant. */
export function useVisit() {
  const { dispatch } = useStore();
  const auth = useAuth();
  const game = useGame();
  const crew = useCrew();
  const toast = useToast();
  // An account that is offline still counts as signed in; the visit then explains it needs a connection.
  const signedIn = auth.phase === "authenticated" || auth.phase === "offline-account";
  const myHandle = game.me?.player?.handle ?? null;
  const flags = game.flags?.byPark ?? null;
  const heldParks = game.me?.parks ?? null;

  const holderOf = useCallback((parkId: string): ParkHolder => parkHolder(parkId, flags, myHandle, heldParks), [flags, myHandle, heldParks]);
  // One visit per park counts each day, so a second one is never offered.
  const visitedToday = useCallback((parkId: string) => signedIn && hasVisitedToday(game.me, parkId, game.serverNow()), [game, signedIn]);
  // Crews (#171): where the player stands with the park's protected hour, from the map's flags.
  const crewOf = useCallback(
    (parkId: string): CrewPhase => crewPhase({ enabled: crew.enabled && signedIn, flag: flags?.get(parkId), myHandle, me: game.me, now: game.serverNow() }),
    [crew.enabled, flags, game, myHandle, signedIn],
  );
  // A scanned code waits on the join card; standing in its park, the big button joins.
  const joinReady = useCallback((parkId: string) => !!crew.join && (crew.join.parkId === null || crew.join.parkId === parkId), [crew.join]);

  const goPlant = useCallback(
    (parkId: string) => {
      dispatch({ type: "trip", id: parkId });
      dispatch({ type: "select", id: null });
      dispatch({ type: "go", screen: "plant" });
    },
    [dispatch],
  );

  /** Joins a crew from the join card or the big button: sign in, pick a handle, then the join scene. */
  const startJoin = useCallback(
    (parkId: string, code: string) => {
      const join = () => {
        crew.beginJoin(code, parkId);
        goPlant(parkId);
      };
      const step = nextVisitStep(signedIn, game.me);
      if (step === "sign-in") {
        dispatch({ type: "select", id: null });
        dispatch({ type: "go", screen: "account" });
      } else if (step === "pick-handle") {
        game.openHandleSheet({ onDone: join });
      } else {
        join();
      }
    },
    [crew, dispatch, game, goPlant, signedIn],
  );

  const start = useCallback(
    (parkId: string) => {
      if (crew.join && joinReady(parkId)) {
        startJoin(parkId, crew.join.code);
        return;
      }
      if (visitedToday(parkId)) {
        buzz(20);
        toast("You visited this park today. Come back tomorrow.", "kip");
        return;
      }
      const phase = crewOf(parkId);
      if (phase.kind === "outsider" && phase.logged) {
        buzz(20);
        toast(`Visit logged. Come back after ${formatClockTime(phase.until)} to take this park.`, "kip");
        return;
      }
      const step = nextVisitStep(signedIn, game.me);
      if (step === "sign-in") {
        dispatch({ type: "select", id: null });
        dispatch({ type: "go", screen: "account" });
      } else if (step === "pick-handle") {
        game.openHandleSheet({ onDone: () => goPlant(parkId) });
      } else {
        goPlant(parkId);
      }
    },
    [crew.join, crewOf, dispatch, game, goPlant, joinReady, signedIn, startJoin, toast, visitedToday],
  );

  const labelFor = useCallback(
    (parkId: string) => visitLabel(signedIn, holderOf(parkId), visitedToday(parkId), crewOf(parkId)),
    [crewOf, holderOf, signedIn, visitedToday],
  );
  const shortLabelFor = useCallback(
    (parkId: string) =>
      signedIn ? visitShortLabel(holderOf(parkId), visitedToday(parkId), crewOf(parkId), joinReady(parkId)) : joinReady(parkId) ? "Join" : "Plant!",
    [crewOf, holderOf, joinReady, signedIn, visitedToday],
  );

  return { signedIn, holderOf, visitedToday, crewOf, start, startJoin, labelFor, shortLabelFor };
}
