import { describe, expect, it } from "vitest";

import { resolveReleaseMetadata } from "./release";

describe("release metadata", () => {
  it("uses a readable local fallback", () => {
    expect(resolveReleaseMetadata({})).toEqual({
      version: "v0.0.000",
      commitSha: "local",
      commitDate: "local build",
    });
  });

  it("preserves the exact values stamped by CI", () => {
    expect(resolveReleaseMetadata({
      version: " v1.0.042 ",
      commitSha: " abc123 ",
      commitDate: " 2026-09-07T12:34:56-07:00 ",
    })).toEqual({
      version: "v1.0.042",
      commitSha: "abc123",
      commitDate: "2026-09-07T12:34:56-07:00",
    });
  });
});
