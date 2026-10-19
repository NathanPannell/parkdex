import { describe, expect, it, vi } from "vitest";

vi.mock("./accounts/authClient", () => ({
  fetchAuthenticated: vi.fn(),
  fetchAccountApi: vi.fn(),
  accountApiUrl: (path: string) => new URL(path, "https://api.example.test/").href,
}));

const { createDecisionQueue, decisionMessage, hasPendingReview } = await import("./foundingReviews");
type FoundingDecision = import("./game/client").FoundingDecision;
type GameMe = import("./game/client").GameMe;

function decision(overrides: Partial<FoundingDecision> & { requestId: string }): FoundingDecision {
  return {
    status: "approved",
    parkId: "p",
    parkName: "Paterson Park",
    reason: null,
    coverUrl: null,
    founderHandle: null,
    decidedAt: "2026-10-10T03:00:00Z",
    ...overrides,
  };
}

const me = (pending: { parkId: string | null }[]): GameMe => ({
  player: null,
  score: 0,
  parks: [],
  takeovers: [],
  flagSeed: null,
  foundingReviews: {
    pending: pending.map((item, index) => ({ requestId: `r${index}`, parkName: "P", createdAt: "2026-10-10T00:00:00Z", ...item })),
    decided: [],
  },
});

describe("decisionMessage", () => {
  it("celebrates an approval with the bonus", () => {
    expect(decisionMessage(decision({ requestId: "a" }))).toMatchObject({
      title: "You're the founder of Paterson Park!",
      text: "Your photo was approved. You're the founder of Paterson Park! +24",
      kip: "cheer",
    });
  });

  it("gives the operator's reason for a rejection, without doubling its full stop", () => {
    expect(decisionMessage(decision({ requestId: "b", status: "rejected", parkName: "Beacon Hill", reason: "Too dark or blurry." })).text).toBe(
      "Your photo for Beacon Hill wasn't approved: too dark or blurry. You can try again next time you're there.",
    );
    expect(decisionMessage(decision({ requestId: "b2", status: "rejected", parkName: "Beacon Hill", reason: "The photo is too dark or blurry." })).text).toBe(
      "Your photo for Beacon Hill wasn't approved: the photo is too dark or blurry. You can try again next time you're there.",
    );
    expect(decisionMessage(decision({ requestId: "b3", status: "rejected", parkName: "Beacon Hill", reason: "OK sign visible!" })).text).toContain(
      "wasn't approved: OK sign visible. You can",
    );
    expect(decisionMessage(decision({ requestId: "c", status: "rejected", parkName: "Beacon Hill", reason: null })).text).toBe(
      "Your photo for Beacon Hill wasn't approved. You can try again next time you're there.",
    );
  });

  it("says when someone else became the founder first", () => {
    expect(decisionMessage(decision({ requestId: "d", status: "superseded" }))).toMatchObject({
      title: "Someone else became the founder first",
      text: "Paterson Park has a founder now. You can still plant your flag there.",
    });
    expect(decisionMessage(decision({ requestId: "e", status: "superseded", founderHandle: "sam" })).title).toBe("@sam became the founder first");
  });

  it("uses the noun founder, never the verb found, which also reads as discovered", () => {
    for (const status of ["approved", "rejected", "superseded"] as const) {
      for (const founderHandle of [null, "sam"]) {
        const message = decisionMessage(decision({ requestId: `${status}-${founderHandle}`, status, founderHandle, reason: "There are people in the photo." }));
        for (const text of [message.eyebrow, message.title, message.text]) expect(text).not.toMatch(/\bfound(ed|ing|s)?\b/i);
      }
    }
  });
});

describe("createDecisionQueue", () => {
  const list = [
    decision({ requestId: "late", decidedAt: "2026-10-10T05:00:00Z" }),
    decision({ requestId: "early", status: "rejected", decidedAt: "2026-10-10T01:00:00Z" }),
  ];

  it("shows the oldest decision first, then the next once it is dismissed, and marks each seen", async () => {
    const markSeen = vi.fn().mockResolvedValue(undefined);
    const queue = createDecisionQueue(markSeen);
    expect(queue.next(list)?.requestId).toBe("early");
    await expect(queue.dismiss("early")).resolves.toBe(true);
    expect(markSeen).toHaveBeenLastCalledWith(["early"]);
    expect(queue.next(list)?.requestId).toBe("late");
    await queue.dismiss("late");
    expect(markSeen).toHaveBeenLastCalledWith(["late"]);
    expect(queue.next(list)).toBeNull();
  });

  it("never shows a decision twice in a session, even when the server still lists it", async () => {
    const queue = createDecisionQueue(vi.fn().mockRejectedValue(new Error("offline")));
    await expect(queue.dismiss("early")).resolves.toBe(false);
    // The refreshed state still has it because the seen call failed.
    expect(queue.next(list)?.requestId).toBe("late");
    expect(queue.pending(list).map((item) => item.requestId)).toEqual(["late"]);
  });

  it("sends seen only once per decision", async () => {
    const markSeen = vi.fn().mockResolvedValue(undefined);
    const queue = createDecisionQueue(markSeen);
    await queue.dismiss("early");
    await queue.dismiss("early");
    expect(markSeen).toHaveBeenCalledTimes(1);
  });

  it("has nothing to show without decisions", () => {
    expect(createDecisionQueue(vi.fn()).next([])).toBeNull();
  });
});

describe("hasPendingReview", () => {
  it("matches a pending review on this park only", () => {
    expect(hasPendingReview(me([{ parkId: "beacon-hill" }]), "beacon-hill")).toBe(true);
    expect(hasPendingReview(me([{ parkId: "beacon-hill" }, { parkId: null }]), "blueberry")).toBe(false);
    expect(hasPendingReview(null, "beacon-hill")).toBe(false);
    expect(hasPendingReview({ ...me([]), foundingReviews: undefined }, "beacon-hill")).toBe(false);
  });
});
