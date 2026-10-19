import { defineConfig, devices } from "@playwright/test";

// End-to-end journeys against the production web build (`npm run build` first), served by
// `vite preview`, and the real API on a throwaway PostgreSQL database (e2e/api-server.ts).
// e2e/fixtures.ts serves both to the browser from one HTTPS origin. The only hosted service used
// is the public content CDN, for the pinned, immutable content release and map tiles.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  use: {
    baseURL: "https://parkdex.e2e.test",
    // The service worker would answer fetches before the routing in e2e/fixtures.ts could.
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Pixel 7"],
    launchOptions: { args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] },
  },
  projects: [{ name: "mobile-chromium" }],
  webServer: [
    {
      // Needs a loopback PostgreSQL server in PGHOST, PGPORT, PGUSER and PGPASSWORD.
      command: "npx tsx e2e/api-server.ts",
      url: "http://127.0.0.1:8788/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
    },
    {
      command: "npx vite preview --port 5190 --strictPort",
      url: "http://localhost:5190",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
