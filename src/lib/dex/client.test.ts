import { describe, expect, it } from "vitest";
import { parseDex } from "./client";

describe("parseDex", () => {
  it("keeps well-formed parks and their visit days", () => {
    expect(parseDex({
      parks: [
        { parkId: "a", visits: 2, days: ["2026-06-01", "bad", 3, "2026-06-03"], firstVisitAt: "2026-06-01T18:00:00.000Z", lastVisitAt: "2026-06-03T18:00:00.000Z", hidden: false },
        { parkId: "h", days: ["2026-06-01"], firstVisitAt: "2026-06-01T18:00:00.000Z", lastVisitAt: "2026-06-01T18:00:00.000Z", hidden: true },
        { parkId: "", firstVisitAt: "2026-06-01T18:00:00.000Z", lastVisitAt: "2026-06-01T18:00:00.000Z" },
        { parkId: "x", firstVisitAt: "never", lastVisitAt: "2026-06-01T18:00:00.000Z" },
        null,
      ],
      serverTime: "2026-06-04T00:00:00.000Z",
    })).toEqual([
      { parkId: "a", days: ["2026-06-01", "2026-06-03"], firstVisitAt: "2026-06-01T18:00:00.000Z", lastVisitAt: "2026-06-03T18:00:00.000Z", hidden: false },
      { parkId: "h", days: ["2026-06-01"], firstVisitAt: "2026-06-01T18:00:00.000Z", lastVisitAt: "2026-06-01T18:00:00.000Z", hidden: true },
    ]);
    expect(() => parseDex({ parks: "no" })).toThrow();
  });
});
