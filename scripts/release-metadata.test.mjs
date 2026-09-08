import assert from "node:assert/strict";
import test from "node:test";

import { releaseMetadata } from "./release-metadata.mjs";

test("release metadata is stable and tied to the resolved commit", () => {
  const calls = [];
  const values = ["abc123", "2026-09-07T12:34:56-07:00", "42"];
  const metadata = releaseMetadata("staging", (args) => {
    calls.push(args);
    return values.shift();
  });

  assert.deepEqual(metadata, {
    version: "v1.0.042",
    commitSha: "abc123",
    commitDate: "2026-09-07T12:34:56-07:00",
  });
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "staging^{commit}"],
    ["show", "-s", "--format=%cI", "abc123"],
    ["rev-list", "--first-parent", "--count", "abc123"],
  ]);
});

test("release sequence rolls over while keeping a three-digit patch", () => {
  const values = ["def456", "2026-09-08T01:00:00Z", "1042"];
  expectRelease(releaseMetadata("HEAD", () => values.shift()), "v1.1.042");
});

function expectRelease(metadata, version) {
  assert.equal(metadata.version, version);
  assert.match(metadata.version, /^v\d+\.\d+\.\d{3}$/);
}
