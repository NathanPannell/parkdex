import { FOUNDER_POINTS } from "./founders";
import type { FoundingDecision, GameMe } from "./game/client";

/**
 * Manual reviews of founding photos (#153), as the app sees them: which park sheets show a
 * pending review, and the decision messages shown once each on the next open.
 */

/** True while the player has a photo for this park waiting for review. */
export function hasPendingReview(me: GameMe | null | undefined, parkId: string): boolean {
  return !!me?.foundingReviews?.pending.some((review) => review.parkId === parkId);
}

export type DecisionMessage = {
  eyebrow: string;
  title: string;
  /** The whole message in one sentence or two, for the body and for screen readers. */
  text: string;
  kip: "cheer" | "think" | "point";
};

/** The operator's reason as a clause after a colon: no final stop, and "The photo" reads "the photo". */
function reasonClause(reason: string): string {
  const clause = reason.trim().replace(/[.!\s]+$/, "");
  // Keep capitals that matter, such as "OK" or a name, by lowering only an ordinary first word.
  return /^[A-Z][a-z]/.test(clause) ? clause[0].toLowerCase() + clause.slice(1) : clause;
}

export function decisionMessage(decision: FoundingDecision): DecisionMessage {
  const park = decision.parkName;
  switch (decision.status) {
    case "approved":
      return { eyebrow: "Photo review", title: `You're the founder of ${park}!`, text: `Your photo was approved. You're the founder of ${park}! +${FOUNDER_POINTS}`, kip: "cheer" };
    case "superseded":
      return { eyebrow: "Photo review", title: decision.founderHandle ? `@${decision.founderHandle} became the founder first` : "Someone else became the founder first", text: `${park} has a founder now. You can still plant your flag there.`, kip: "point" };
    case "rejected": {
      const reason = decision.reason ? reasonClause(decision.reason) : "";
      return {
        eyebrow: "Photo review",
        title: "Not approved this time",
        text: `Your photo for ${park} wasn't approved${reason ? `: ${reason}` : ""}. You can try again next time you're there.`,
        kip: "think",
      };
    }
  }
}

/**
 * The decisions still to show, oldest first, one at a time. Dismissing one hides it at once and
 * tells the server it was seen; if that call fails the decision comes back on the next launch,
 * which is the right outcome offline, but never again in this session.
 */
export function createDecisionQueue(markSeen: (requestIds: string[]) => Promise<void>) {
  const shown = new Set<string>();
  return {
    pending(decided: readonly FoundingDecision[]): FoundingDecision[] {
      return decided
        .filter((decision) => !shown.has(decision.requestId))
        .sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt));
    },
    next(decided: readonly FoundingDecision[]): FoundingDecision | null {
      return this.pending(decided)[0] ?? null;
    },
    async dismiss(requestId: string): Promise<boolean> {
      if (shown.has(requestId)) return true;
      shown.add(requestId);
      try {
        await markSeen([requestId]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type DecisionQueue = ReturnType<typeof createDecisionQueue>;
