import { test as base, expect, type Page } from "@playwright/test";

/** The address `vite preview` serves the production build on (playwright.config.ts). */
export const PREVIEW_ORIGIN = "http://localhost:5190";
/** The real API against a throwaway PostgreSQL database (e2e/api-server.ts). */
export const API_ORIGIN = "http://127.0.0.1:8788";
/**
 * The browser loads the app from this HTTPS origin, because the web build only reads content
 * from a secure origin on the default port. Playwright answers every request to it: `/api` from
 * the e2e API server and everything else from `vite preview`, as Vercel routes the real hosts.
 */
export const APP_ORIGIN = "https://parkdex.e2e.test";

async function serveApp(page: Page) {
  await page.route(`${APP_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const upstream = url.pathname.startsWith("/api/") ? API_ORIGIN : PREVIEW_ORIGIN;
    const target = { url: upstream + url.pathname + url.search };
    let response;
    try {
      response = await route.fetch(target);
    } catch (error) {
      // A reused keep-alive socket can be closed by the server just as a request is sent. Like a
      // browser, send an idempotent request once more on a fresh connection.
      const idempotent = ["GET", "HEAD"].includes(route.request().method());
      if (!idempotent || !/ECONNRESET|socket hang up/.test(String(error))) throw error;
      response = await route.fetch(target);
    }
    await route.fulfill({ response });
  });
}

type Fixtures = { pageErrors: string[] };

// Every test is served the app and fails on an uncaught page error.
export const test = base.extend<Fixtures>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await serveApp(page);
      await use(errors);
      // Requests still in flight when the test ends would otherwise fail the teardown.
      await page.unrouteAll({ behavior: "ignoreErrors" });
      expect(errors, "uncaught page errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
export type { Page };

/** First launch: decline location for now, leave the handle for sign-in and start. */
export async function finishOnboarding(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("button", { name: "Let's go!" }).click();
}
