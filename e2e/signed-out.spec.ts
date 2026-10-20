import { expect, finishOnboarding, test, type Page } from "./fixtures";

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
  await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);
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
  await expect(page.getByText("No founder yet")).toBeVisible();
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
  const board = page.getByRole("main", { name: "Leaderboard" });
  await expect(board.getByRole("heading", { name: "Leaderboard", level: 1 })).toBeVisible();
  await expect(board.getByRole("heading", { name: "No flags yet" })).toBeVisible();
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
