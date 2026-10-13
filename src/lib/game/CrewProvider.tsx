import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isFeatureEnabled } from "../appConfig";
import { createVisitId } from "./client";
import type { CrewCodeTarget } from "./crew";
import { useGame } from "./GameProvider";

/**
 * Crew UI state (#171), behind the `crews` feature flag: the scanner, the join card for a code
 * that was scanned, typed or opened from a link, the crew code sheet, and the join the plant
 * screen is about to send. The crew rules themselves run on the server for every build.
 */

export type CrewJoinTarget = CrewCodeTarget & { source: "scan" | "typed" | "link" };
/** A join on its way to the plant screen. The visit ID stays the same across retries. */
export type CrewJoining = { code: string; parkId: string; visitId: string };

type CrewContextValue = {
  enabled: boolean;
  /** The scanner, open for a park's page (or from anywhere, with null). */
  scanner: { parkId: string | null } | null;
  openScanner: (parkId: string | null) => void;
  closeScanner: () => void;
  /** The join card's code, until the player joins or cancels. */
  join: CrewJoinTarget | null;
  offerJoin: (target: CrewJoinTarget) => void;
  dismissJoin: () => void;
  joining: CrewJoining | null;
  beginJoin: (code: string, parkId: string) => CrewJoining;
  endJoin: () => void;
  /** The park whose crew code sheet is open. */
  codeSheet: string | null;
  openCodeSheet: (parkId: string) => void;
  closeCodeSheet: () => void;
};

const CrewContext = createContext<CrewContextValue | null>(null);

export function CrewProvider({ children }: { children: ReactNode }) {
  const enabled = isFeatureEnabled("crews");
  const game = useGame();
  const [scanner, setScanner] = useState<{ parkId: string | null } | null>(null);
  const [join, setJoin] = useState<CrewJoinTarget | null>(null);
  const [joining, setJoining] = useState<CrewJoining | null>(null);
  const [codeSheet, setCodeSheet] = useState<string | null>(null);

  // Another account gets none of the previous player's sheets. A code from a link stays, so it
  // can be joined after signing in.
  useEffect(() => {
    setScanner(null);
    setJoining(null);
    setCodeSheet(null);
  }, [game.accountId]);

  const beginJoin = useCallback((code: string, parkId: string) => {
    const next = { code, parkId, visitId: createVisitId() };
    setJoining(next);
    setJoin(null);
    setScanner(null);
    return next;
  }, []);

  const value = useMemo<CrewContextValue>(() => ({
    enabled,
    scanner: enabled ? scanner : null,
    openScanner: (parkId) => setScanner({ parkId }),
    closeScanner: () => setScanner(null),
    join: enabled ? join : null,
    offerJoin: (target) => {
      setScanner(null);
      setJoin(target);
    },
    dismissJoin: () => setJoin(null),
    joining: enabled ? joining : null,
    beginJoin,
    endJoin: () => setJoining(null),
    codeSheet: enabled ? codeSheet : null,
    openCodeSheet: (parkId) => setCodeSheet(parkId),
    closeCodeSheet: () => setCodeSheet(null),
  }), [enabled, scanner, join, joining, beginJoin, codeSheet]);

  return <CrewContext.Provider value={value}>{children}</CrewContext.Provider>;
}

export function useCrew() {
  const crew = useContext(CrewContext);
  if (!crew) throw new Error("useCrew outside CrewProvider");
  return crew;
}
