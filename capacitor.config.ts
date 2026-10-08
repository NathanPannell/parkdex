/// <reference types="@capgo/capacitor-updater" />
import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Over-the-air web bundles come from our own endpoint (`/api/updates`), never Capgo cloud.
 * The channel is baked into each native build when `scripts/cap-sync.mjs` runs `cap sync`:
 * staging field and debug builds use `staging`, `android:aab:production` uses `production`.
 * A sync without a channel turns automatic checks off.
 */
const UPDATE_HOSTS = {
  staging: "https://staging.web.parkdex.app",
  production: "https://web.parkdex.app",
} as const;
type UpdateChannel = keyof typeof UPDATE_HOSTS;

function updateChannel(): UpdateChannel | null {
  const value = process.env.PARKDEX_UPDATE_CHANNEL?.trim();
  if (!value) return null;
  if (value === "staging" || value === "production") return value;
  throw new Error("PARKDEX_UPDATE_CHANNEL must be staging or production");
}

const channel = updateChannel();
// Local QA can point a debug build at a local API; release builds always use the channel's host.
const updateUrl = process.env.PARKDEX_UPDATE_URL?.trim() || (channel ? `${UPDATE_HOSTS[channel]}/api/updates` : "");

const config: CapacitorConfig = {
  appId: "app.parkdex",
  appName: "Parkdex",
  webDir: "dist",
  backgroundColor: "#FF5A1F",
  android: {
    loggingBehavior: "debug",
  },
  server: {
    hostname: "localhost",
    androidScheme: "https",
  },
  plugins: {
    SystemBars: {
      insetsHandling: "native",
      initialViewportFitValueHint: "cover",
    },
    CapacitorUpdater: {
      // The plugin only downloads. The app applies a bundle on the next cold start (src/lib/ota.ts),
      // because applying on background would reload the page while the camera or sign-in is open.
      autoUpdate: channel ? "onlyDownload" : "off",
      defaultChannel: channel ?? undefined,
      allowSetDefaultChannel: false,
      updateUrl,
      statsUrl: "",
      channelUrl: "",
      appReadyTimeout: 15000,
      responseTimeout: 30,
      resetWhenUpdate: true,
      autoDeleteFailed: true,
      autoDeletePrevious: true,
    },
  },
};

export default config;
