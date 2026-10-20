import { expect, finishOnboarding, test, type Page } from "./fixtures";

/** How long to wait for content that comes from the e2e API, which can answer slowly while it warms up. */
const API_TIMEOUT = 15_000;

/** Kip's Tips open over a screen the first time it is shown. */
async function dismissTip(page: Page) {
  const gotIt = page.getByRole("dialog").getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible()) await gotIt.click();
}

async function openTab(page: Page, name: "Explore" | "My Dex" | "Leaders" | "Settings") {
  await dismissTip(page);
  await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
  await dismissTip(page);
}

test("first launch onboards a visitor and lists parks near them", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Plant your flag\s*in real parks\./)).toBeVisible();
  await finishOnboarding(page);
  await expect(page.getByRole("region", { name: "Map" })).toBeVisible();
  await expect(page.getByText("Parks near you")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Gonzales Hill Regional Park\. No flag yet\./ })).toBeVisible();
  await expect(page.getByText("Park guides couldn’t be loaded.")).toHaveCount(0);
});

test("a returning visitor goes straight to the map", async ({ page }) => {
  await finishOnboarding(page);
  await expect(page.getByText("Parks near you")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Parks near you")).toBeVisible();
  await expect(page.getByRole("button", { name: "Not now" })).toHaveCount(0);
});

test("search finds a park and opens its page", async ({ page }) => {
  await finishOnboarding(page);
  await page.getByRole("button", { name: "Search parks" }).click();
  await page.getByPlaceholder("Search parks").fill("Elk Falls");
  await page.getByRole("button", { name: /^Elk Falls Park\./ }).click();
  await expect(page.getByRole("heading", { name: "Elk Falls Park", level: 2 })).toBeVisible();
  await expect(page.getByText("Provincial Park · North Island")).toBeVisible();
  await expect(page.getByRole("region", { name: "Flag" })).toContainText("No flag yet");
  // Founding happens inside a park, so a park far away shows only its founder line.
  // The founder line waits for the park summary from the API, whose first answer can be slow on a cold server.
  await expect(page.getByText("No founder yet")).toBeVisible({ timeout: API_TIMEOUT });
  await expect(page.getByRole("button", { name: /^Become the founder/ })).toHaveCount(0);
});

test("My Dex shows the whole catalogue before the first visit", async ({ page }) => {
  await finishOnboarding(page);
  await openTab(page, "My Dex");
  const dex = page.getByRole("main", { name: "My Dex" });
  await expect(dex.getByRole("heading", { name: "My Dex", level: 1 })).toBeVisible();
  await expect(dex).toContainText(/0 visits\s*of 122 parks/);
  // With no visits yet there is nothing to filter to, so every park shows, still to find.
  await expect(dex.getByRole("switch")).not.toBeChecked();
  await expect(dex.getByText("Your Dex is empty. Go visit a park!")).toHaveCount(0);
  await expect(dex.getByText("Not visited").first()).toBeVisible();
});

test("the leaderboard loads from the API", async ({ page }) => {
  await finishOnboarding(page);
  await openTab(page, "Leaders");
  const board = page.getByRole("main", { name: "Leaders" });
  await expect(board.getByRole("heading", { name: "Leaders", level: 1 })).toBeVisible();
  await expect(board.getByRole("heading", { name: "No flags yet" })).toBeVisible({ timeout: API_TIMEOUT });
});

test("tapping a player on the leaderboard opens their sheet", async ({ page }) => {
  const players = ["sam", "riley", "jo", "kai"].map((handle, index) => ({
    rank: index + 1,
    handle,
    flagSeed: `seed-${handle}`,
    score: 40 - index * 10,
    parksHeld: 4 - index,
  }));
  // Registered after the fixture's route, so it answers the leaderboard before the e2e API does.
  await page.route("**/api/game/leaderboard", (route) => route.fulfill({ json: { players, serverTime: new Date().toISOString() } }));
  await finishOnboarding(page);
  await openTab(page, "Leaders");
  const board = page.getByRole("main", { name: "Leaders" });

  await board.getByRole("button", { name: /@kai/ }).click();
  const sheet = page.getByRole("dialog", { name: "@kai" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Rank 4");
  await expect(sheet).toContainText(/Points\s*10/);
  await expect(sheet).toContainText(/Park held\s*1/);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);

  await board.getByRole("button", { name: /^Rank 1, @sam/ }).click();
  await expect(page.getByRole("dialog", { name: "@sam" })).toContainText(/Parks held\s*4/);
});

test("settings offer sign-in to a signed-out visitor", async ({ page }) => {
  await finishOnboarding(page);
  await openTab(page, "Settings");
  const settings = page.getByRole("main", { name: "Settings" });
  await expect(settings.getByRole("button", { name: /^Your flag Sign in to get your own flag/ })).toBeVisible();
  await settings.getByRole("button", { name: /^Account & backup/ }).click();
  await dismissTip(page);
  await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
});
