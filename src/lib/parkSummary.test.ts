import { describe, expect, it, vi } from "vitest";

vi.mock("./accounts/authClient", () => ({
  fetchAuthenticated: vi.fn(),
  fetchAccountApi: vi.fn(),
  accountApiUrl: (path: string) => new URL(path, "https://api.example.test/").href,
}));

const { FOUNDER_HINT, REVIEW_PENDING_TEXT, founderCta, summaryCover, summaryStats } = await import("./parkSummary");
type ParkSummary = import("./founders").ParkSummary;

const open: ParkSummary = { parkId: "p", founder: null, coverUrl: null, visits: { total: 4, last30Days: 2, mine: 1 } };
const founded: ParkSummary = { parkId: "p", founder: { handle: "robin", foundedAt: null }, coverUrl: "/api/parks/p/cover/abc.jpg", visits: { total: 9, last30Days: 3, mine: null } };

describe("founderCta", () => {
  it("offers founding inside a park with no founder, and a hint outside", () => {
    expect(founderCta({ status: "ready", summary: open }, true)).toEqual({ kind: "found", points: 10 });
    expect(founderCta({ status: "ready", summary: open }, false)).toEqual({ kind: "hint", text: FOUNDER_HINT, points: 10 });
  });

  it("offers nothing for a founded park, while loading, offline or when switched off", () => {
    expect(founderCta({ status: "ready", summary: founded }, true).kind).toBe("hidden");
    expect(founderCta({ status: "ready", summary: { ...open, coverUrl: "/c.jpg" } }, true).kind).toBe("hidden");
    expect(founderCta({ status: "loading", summary: null }, true).kind).toBe("hidden");
    expect(founderCta({ status: "error", summary: open }, true).kind).toBe("hidden");
    expect(founderCta({ status: "ready", summary: open }, true, false).kind).toBe("hidden");
  });

  it("shows a pending review instead of the offer, inside or outside, even before the summary loads", () => {
    const pending = { kind: "pending", text: REVIEW_PENDING_TEXT };
    expect(REVIEW_PENDING_TEXT).toBe("Your photo is waiting for review");
    expect(founderCta({ status: "ready", summary: open }, true, true, true)).toEqual(pending);
    expect(founderCta({ status: "ready", summary: open }, false, true, true)).toEqual(pending);
    expect(founderCta({ status: "loading", summary: null }, true, true, true)).toEqual(pending);
    expect(founderCta({ status: "error", summary: null }, true, true, true)).toEqual(pending);
  });

  it("drops the pending row once the park has a founder, or when founding is off", () => {
    expect(founderCta({ status: "ready", summary: founded }, true, true, true).kind).toBe("hidden");
    expect(founderCta({ status: "loading", summary: founded }, true, true, true).kind).toBe("hidden");
    expect(founderCta({ status: "ready", summary: open }, true, false, true).kind).toBe("hidden");
  });
});

describe("summaryStats", () => {
  it("shows the founder and the three visit counts", () => {
    expect(summaryStats({ status: "ready", summary: open }, true)).toEqual({ founder: "No founder yet", mine: "1", total: "4", last30Days: "2", pending: false, note: null });
    expect(summaryStats({ status: "ready", summary: founded }, false)).toMatchObject({ founder: "Founder: @robin", mine: "Sign in", total: "9", last30Days: "3" });
  });

  it("shows placeholders while loading and a note offline", () => {
    expect(summaryStats({ status: "loading", summary: null }, true)).toMatchObject({ mine: "–", total: "–", pending: true, note: null });
    expect(summaryStats({ status: "error", summary: null }, true)).toMatchObject({ founder: "Founder unknown", pending: false, note: "Visit counts need a connection." });
    expect(summaryStats({ status: "error", summary: open }, true)).toMatchObject({ total: "4", note: "Counts may be out of date." });
  });
});

describe("summaryCover", () => {
  it("uses the remembered cover while a refresh runs", () => {
    expect(summaryCover({ status: "loading", summary: founded })).toBe("https://api.example.test/api/parks/p/cover/abc.jpg");
    expect(summaryCover({ status: "ready", summary: open })).toBeNull();
  });

  it("falls back on the flag board's cover until the summary answers", () => {
    expect(summaryCover({ status: "loading", summary: null }, "/api/parks/p/cover/def.jpg")).toBe("https://api.example.test/api/parks/p/cover/def.jpg");
    expect(summaryCover({ status: "error", summary: null }, "/api/parks/p/cover/def.jpg")).toBe("https://api.example.test/api/parks/p/cover/def.jpg");
    expect(summaryCover({ status: "ready", summary: open }, "/api/parks/p/cover/def.jpg")).toBeNull();
  });
});
