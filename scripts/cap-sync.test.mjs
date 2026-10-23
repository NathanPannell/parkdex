import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseCapSyncArgs } from "./cap-sync.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "cap-sync.mjs");

test("takes exactly one platform and one channel", () => {
  assert.deepEqual(parseCapSyncArgs(["android", "staging"]), { platform: "android", channel: "staging" });
  assert.deepEqual(parseCapSyncArgs(["android", "production"]), { platform: "android", channel: "production" });
  assert.deepEqual(parseCapSyncArgs(["ios", "staging"]), { platform: "ios", channel: "staging" });
  assert.deepEqual(parseCapSyncArgs(["ios", "production"]), { platform: "ios", channel: "production" });
});

test("refuses anything else, so no other text reaches the shell", () => {
  for (const args of [
    [],
    ["staging"],
    ["production"],
    ["ios"],
    ["staging", "android"],
    ["web", "staging"],
    ["ios", "main"],
    ["ios", "staging", "extra"],
    ["ios", "staging && calc"],
  ]) {
    assert.equal(parseCapSyncArgs(args), null, JSON.stringify(args));
  }
});

test("prints the usage and exits 2 without running cap", () => {
  const result = spawnSync(process.execPath, [scriptPath, "staging"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node scripts\/cap-sync\.mjs <android\|ios> <staging\|production>/);
});
