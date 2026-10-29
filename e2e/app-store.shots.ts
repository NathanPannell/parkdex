import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "./fixtures";

/**
 * The App Store screenshot set (docs/ios.md): five screens of the real web build, signed out, with
 * sample players on the leaderboard. Nothing here shows Google Play, crews or personal photos.
 */
const OUT = "shots/app-store-6.9";
const SAMPLE_PLAYERS = [
  ["trailmix", 48, 6],
  ["mossyboots", 41, 5],
  ["parkhopper", 33, 4],
  ["salal", 27, 3],
  ["cedar.kid", 19, 2],
  ["tidepool", 12, 1],
].map(([handle, score, parksHeld], index) => ({ rank: index + 1, handle, flagSeed: `sample-${handle}`, score, parksHeld }));

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(1500);
}

async function shoot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

async function dismissTip(page: Page) {
  const gotIt = page.getByRole("dialog").getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible()) await gotIt.click();
}

async function openTab(page: Page, name: "Explore" | "My Dex" | "Leaders") {
  await dismissTip(page);
  await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
  await dismissTip(page);
}

test("App Store screenshots, 6.9-inch", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.route("**/api/game/leaderboard", (route) => route.fulfill({ json: { players: SAMPLE_PLAYERS, serverTime: new Date().toISOString() } }));

  await page.goto("/");
  await expect(page.getByText(/Plant your flag\s*in real parks\./)).toBeVisible();
  await shoot(page, "1-plant-your-flag");

  await page.getByRole("button", { name: /Allow location/ }).click();
  await page.getByRole("button", { name: "Let's go!" }).click();
  await expect(page.getByText("Parks near you")).toBeVisible();
  await dismissTip(page);
  await shoot(page, "2-parks-near-you");

  await page.getByRole("button", { name: "Search parks" }).click();
  await page.getByPlaceholder("Search parks").fill("Gonzales Hill");
  await page
    .getByRole("button", { name: /^Gonzales Hill Regional Park\./ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Gonzales Hill Regional Park", level: 2 })).toBeVisible();
  await dismissTip(page);
  await shoot(page, "3-park-page");
  await page.getByRole("button", { name: "Close" }).first().click();

  await openTab(page, "My Dex");
  await expect(page.getByRole("heading", { name: "My Dex", level: 1 })).toBeVisible();
  await shoot(page, "4-my-dex");

  await openTab(page, "Leaders");
  await expect(page.getByRole("main", { name: "Leaders" }).getByRole("button", { name: /@trailmix/ })).toBeVisible();
  await shoot(page, "5-leaders");
});
