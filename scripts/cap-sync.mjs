#!/usr/bin/env node
// Runs `cap sync android` with the over-the-air update channel baked into the native config.
// npm scripts cannot set environment variables portably on Windows, so this wrapper does it.
import { spawnSync } from "node:child_process";

const channel = process.argv[2];
if (process.argv.length !== 3 || (channel !== "staging" && channel !== "production")) {
  console.error("Usage: node scripts/cap-sync.mjs <staging|production>");
  process.exit(2);
}

const result = spawnSync("npx", ["cap", "sync", "android"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, PARKDEX_UPDATE_CHANNEL: channel },
});
process.exit(result.status ?? 1);
