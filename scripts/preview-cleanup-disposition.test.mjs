import assert from "node:assert/strict";
import test from "node:test";

import { cleanupDisposition } from "./preview-cleanup-disposition.mjs";

test("merged PR cleanup remains pending until exact journal cleanup runs", () => {
  const result = cleanupDisposition(28);
  assert.equal(result.outcome, "pending-journal-cleanup");
  assert.equal(result.providerCalls, false);
  assert.match(result.message, /merged PR #28/);
  assert.match(result.message, /exact journal/);
  assert.match(result.message, /verify its recorded provider ownership/);
  assert.match(result.message, /scripts\/local-release\.ps1 -Mode Cleanup -StatePath <exact-journal> -Apply/);
  assert.match(result.message, /verify every recorded resource absent/);
});

test("cleanup disposition rejects invalid PR identities", () => {
  for (const value of [0, -1, 1.5, 1_000_000, Number.NaN]) {
    assert.throws(() => cleanupDisposition(value), /valid pull request number/);
  }
});
