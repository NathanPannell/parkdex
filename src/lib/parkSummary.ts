import { useEffect, useState } from "react";
import { coverImageUrl, fetchParkSummary, FOUNDER_POINTS, type ParkSummary } from "./founders";

/** A park's founder and visit counts as the park sheet sees them. */
export type SummaryState =
  | { status: "loading"; summary: ParkSummary | null }
  | { status: "ready"; summary: ParkSummary }
  | { status: "error"; summary: ParkSummary | null };

/** What the sheet offers for founding: nothing, the button, or a hint to go there first. */
export type FounderCta = { kind: "hidden" } | { kind: "found"; points: number } | { kind: "hint"; text: string; points: number };

export const FOUNDER_HINT = "Visit the park to become its founder";

/**
 * The cover photo to show instead of the badge: the freshest summary's, else the one the flag
 * board already carries, so a founded park's photo shows before its summary arrives.
 */
export function summaryCover(state: SummaryState, knownCover: string | null = null): string | null {
  if (state.status === "ready") return coverImageUrl(state.summary.coverUrl);
  return coverImageUrl(state.summary?.coverUrl ?? knownCover);
}

/**
 * Parks without a founder or cover photo offer "Become the founder", enabled only inside the
 * park. Until the server answers, and when it cannot, nothing is offered.
 */
export function founderCta(state: SummaryState, inside: boolean, enabled = true): FounderCta {
  if (!enabled || state.status !== "ready") return { kind: "hidden" };
  if (state.summary.founder || state.summary.coverUrl) return { kind: "hidden" };
  return inside ? { kind: "found", points: FOUNDER_POINTS } : { kind: "hint", text: FOUNDER_HINT, points: FOUNDER_POINTS };
}

export type SummaryStats = { founder: string; mine: string; total: string; last30Days: string; pending: boolean; note: string | null };

/** The labels in the sheet's stats block; placeholders while loading and when offline. */
export function summaryStats(state: SummaryState, signedIn: boolean): SummaryStats {
  const summary = state.summary;
  if (!summary) {
    return {
      founder: state.status === "loading" ? "Finding the founder…" : "Founder unknown",
      mine: "–",
      total: "–",
      last30Days: "–",
      pending: state.status === "loading",
      note: state.status === "error" ? "Visit counts need a connection." : null,
    };
  }
  return {
    founder: summary.founder ? (summary.founder.handle ? `Founded by @${summary.founder.handle}` : "Has a founder") : "No founder yet",
    mine: summary.visits.mine === null ? (signedIn ? "–" : "Sign in") : String(summary.visits.mine),
    total: String(summary.visits.total),
    last30Days: String(summary.visits.last30Days),
    pending: false,
    // A remembered answer stays on screen when the refresh fails.
    note: state.status === "error" ? "Counts may be out of date." : null,
  };
}

// The last answer per park and viewer, so reopening a sheet shows it at once while it refreshes.
const remembered = new Map<string, ParkSummary>();
const memoryKey = (parkId: string, accountId: string | null) => `${accountId ?? "guest"}:${parkId}`;

export function rememberSummary(summary: ParkSummary, accountId: string | null): void {
  remembered.set(memoryKey(summary.parkId, accountId), summary);
}

export function forgetSummaries(): void {
  remembered.clear();
}

/** Fetches the park's summary when the sheet opens. */
export function useParkSummary(parkId: string, accountId: string | null): SummaryState {
  const [state, setState] = useState<SummaryState>(() => ({ status: "loading", summary: remembered.get(memoryKey(parkId, accountId)) ?? null }));
  useEffect(() => {
    const controller = new AbortController();
    const known = remembered.get(memoryKey(parkId, accountId)) ?? null;
    setState({ status: "loading", summary: known });
    fetchParkSummary(parkId, accountId, controller.signal)
      .then((summary) => {
        rememberSummary(summary, accountId);
        setState({ status: "ready", summary });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error", summary: known });
      });
    return () => controller.abort();
  }, [parkId, accountId]);
  return state;
}
