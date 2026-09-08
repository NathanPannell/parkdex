import { describe, expect, it } from "vitest";

import { initialBoundarySourceReadiness, settleBoundarySourceReadiness } from "./boundary-source-status";

describe("boundary source readiness", () => {
  it("waits for both authoritative and display geometry", () => {
    const first = settleBoundarySourceReadiness(initialBoundarySourceReadiness(), "canonical", "ready");
    expect(first.status).toBe("loading");
    const second = settleBoundarySourceReadiness(first.sources, "display", "ready");
    expect(second.status).toBe("ready");
  });

  it("fails when either required source fails and keeps that result terminal", () => {
    const failed = settleBoundarySourceReadiness(initialBoundarySourceReadiness(), "display", "failed");
    expect(failed.status).toBe("failed");
    expect(settleBoundarySourceReadiness(failed.sources, "display", "ready")).toEqual(failed);
    expect(settleBoundarySourceReadiness(failed.sources, "canonical", "ready").status).toBe("failed");
  });
});
