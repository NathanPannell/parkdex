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

function withoutFinalStop(reason: string): string {
  return reason.trim().replace(/[.!\s]+$/, "");
}

export function decisionMessage(decision: FoundingDecision): DecisionMessage {
  const park = decision.parkName;
  switch (decision.status) {
    case "approved":
      return { eyebrow: "Photo review", title: `You founded ${park}!`, text: `Your photo was approved. You founded ${park}! +${FOUNDER_POINTS}`, kip: "cheer" };
    case "superseded":
      return { eyebrow: "Photo review", title: decision.founderHandle ? `@${decision.founderHandle} got there first` : "Someone got there first", text: `Someone else founded ${park} first.`, kip: "point" };
    case "rejected": {
      const reason = decision.reason ? withoutFinalStop(decision.reason) : "";
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
