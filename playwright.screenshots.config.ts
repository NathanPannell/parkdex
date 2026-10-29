import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// App Store screenshots for 6.9-inch iPhones (1320 x 2868 portrait): the production web build in
// WebKit, the engine of the iOS app's web view, at 440 x 956 points and 3x scale. Same servers as
// the e2e journeys. Run `npm run build`, then `npm run ios:screenshots`; files land in
// shots/app-store-6.9/. See docs/ios.md.
export default defineConfig({
  ...base,
  testMatch: "app-store.shots.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: "list",
  use: {
    ...base.use,
    browserName: "webkit",
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    // Victoria, BC, beside Beacon Hill Park.
    geolocation: { latitude: 48.4115, longitude: -123.3656, accuracy: 10 },
    permissions: ["geolocation"],
    launchOptions: undefined,
    trace: "off",
    screenshot: "off",
  },
  projects: [{ name: "app-store-6.9" }],
});
