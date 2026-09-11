const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("C:/Users/n8tew/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const outputDir = __dirname;
const environments = [
  ["production", "https://parkdex.app"],
  ["staging", "https://staging.parkdex.app"],
];
const viewports = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

const safeName = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function settle(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);
}

async function screenshot(page, environment, viewport, state) {
  const filename = `${environment}-${viewport}-${safeName(state)}.png`;
  await page.screenshot({ path: path.join(outputDir, filename), fullPage: true });
  return filename;
}

async function firstVisible(page, candidates) {
  for (const candidate of candidates) {
    const locator = candidate(page).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

(async () => {
  await fs.mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = [];
  try {
    for (const [environment, url] of environments) {
      for (const [viewportName, viewport] of viewports) {
        const context = await browser.newContext({
          viewport,
          locale: "en-CA",
          colorScheme: "light",
          geolocation: { longitude: -123.3656, latitude: 48.4284 },
          permissions: ["geolocation"],
        });
        const page = await context.newPage();
        const errors = [];
        page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
        page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await settle(page);
        const entry = {
          environment,
          url: page.url(),
          viewport,
          httpStatus: response?.status() ?? null,
          responseHeaders: response ? await response.allHeaders() : {},
          title: await page.title(),
          screenshots: [],
          unavailable: [],
          visibleVersionText: null,
          errors,
        };

        entry.screenshots.push(await screenshot(page, environment, viewportName, "home"));
        if (viewport.width < 640 && page.url().startsWith("https://www.parkdex.app")) {
          await page.mouse.move(260, 560);
          await page.mouse.down();
          await page.mouse.move(80, 560, { steps: 12 });
          await page.mouse.up();
          await page.waitForTimeout(900);
          entry.screenshots.push(await screenshot(page, environment, viewportName, "map-shifted-no-selection"));
        }

        const findPlacesMode = await firstVisible(page, [
          (p) => p.getByRole("button", { name: /^find places$/i }),
          (p) => p.getByRole("button", { name: /find your first place/i }),
        ]);
        if (findPlacesMode) {
          await findPlacesMode.click();
          await page.waitForTimeout(500);
        }
        const search = await firstVisible(page, [
          (p) => p.getByRole("searchbox"),
          (p) => p.getByPlaceholder(/search/i),
          (p) => p.getByPlaceholder(/find a park/i),
          (p) => p.getByRole("button", { name: /search/i }),
        ]);
        if (search) {
          if (await search.evaluate((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
            await search.click();
            await search.pressSequentially("Goldstream", { delay: 35 });
          } else {
            await search.click();
            const input = await firstVisible(page, [
              (p) => p.getByRole("searchbox"),
              (p) => p.getByPlaceholder(/find a park|search/i),
            ]);
            if (input) {
              await input.click();
              await input.pressSequentially("Goldstream", { delay: 35 });
            }
          }
          await page.waitForTimeout(1200);
          entry.screenshots.push(await screenshot(page, environment, viewportName, "search-goldstream"));
          const result = await firstVisible(page, [
            (p) => p.getByRole("button", { name: /Goldstream/i }),
            (p) => p.getByText(/Goldstream Provincial Park/i),
            (p) => p.getByText(/Goldstream/i),
          ]);
          if (result) {
            await result.click();
            await page.waitForTimeout(1600);
            entry.screenshots.push(await screenshot(page, environment, viewportName, "selected-goldstream"));
          } else if (viewport.width >= 1000) {
            // Desktop search filters the map to one canvas marker rather than rendering a result row.
            await page.mouse.click(viewport.width * 0.78, viewport.height * 0.845);
            await page.waitForTimeout(1600);
            if (await page.getByText(/Goldstream Park/i).first().isVisible().catch(() => false)) {
              entry.screenshots.push(await screenshot(page, environment, viewportName, "selected-goldstream"));
            } else entry.unavailable.push("selected park: filtered Goldstream marker did not open");
          } else entry.unavailable.push("selected park: Goldstream result not visible");
        } else entry.unavailable.push("search control");

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await settle(page);
        const places = await firstVisible(page, [
          (p) => p.getByRole("button", { name: /find places/i }),
          (p) => p.getByRole("link", { name: /find places/i }),
          (p) => p.getByRole("button", { name: /^places$/i }),
          (p) => p.getByRole("link", { name: /^places$/i }),
          (p) => p.getByText(/^Places$/i),
        ]);
        if (places) {
          await places.click();
          await page.waitForTimeout(1000);
          entry.screenshots.push(await screenshot(page, environment, viewportName, "places"));
        } else entry.unavailable.push("Places navigation");

        const nearby = await firstVisible(page, [
          (p) => p.getByRole("button", { name: /nearby|near me|location/i }),
          (p) => p.getByText(/nearby/i),
        ]);
        if (nearby) {
          await nearby.click();
          await page.waitForTimeout(900);
          entry.screenshots.push(await screenshot(page, environment, viewportName, "nearby-victoria-simulated"));
        } else entry.unavailable.push("nearby control");

        const groups = await firstVisible(page, [
          (p) => p.getByRole("button", { name: /groups/i }),
          (p) => p.getByRole("link", { name: /groups/i }),
          (p) => p.getByText(/^Groups$/i),
        ]);
        if (groups) {
          await groups.click();
          await page.waitForTimeout(650);
          entry.screenshots.push(await screenshot(page, environment, viewportName, "groups-guest"));
        } else entry.unavailable.push("groups guest navigation");

        const bodyText = await page.locator("body").innerText();
        entry.visibleVersionText = bodyText.split("\n").find((line) => /(?:build|version|commit)\s*[:#]?\s*[a-f0-9]{7,}/i.test(line)) ?? null;
        report.push(entry);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  await fs.writeFile(path.join(outputDir, "capture-report.json"), JSON.stringify(report, null, 2) + "\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
