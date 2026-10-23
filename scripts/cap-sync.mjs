#!/usr/bin/env node
// Runs `cap sync <platform>` with the over-the-air update channel baked into the native config.
// npm scripts cannot set environment variables portably on Windows, so this wrapper does it.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PLATFORMS = ["android", "ios"];
const CHANNELS = ["staging", "production"];
const USAGE = "Usage: node scripts/cap-sync.mjs <android|ios> <staging|production>";

/** The platform and channel from the command line, or null when they are not exactly one of each. */
export function parseCapSyncArgs(args) {
  if (args.length !== 2) return null;
  const [platform, channel] = args;
  if (!PLATFORMS.includes(platform) || !CHANNELS.includes(channel)) return null;
  return { platform, channel };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseCapSyncArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    process.exit(2);
  }

  // A fixed command line from the allowlists above: npx is a .cmd shim on Windows and needs a shell.
  const result = spawnSync(`npx cap sync ${parsed.platform}`, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, PARKDEX_UPDATE_CHANNEL: parsed.channel, PARKDEX_NATIVE_PLATFORM: parsed.platform },
  });
  process.exit(result.status ?? 1);
}
