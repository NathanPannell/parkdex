const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("C:/Users/n8tew/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const appUrl = "http://localhost:3127";
const apiPrefix = "/__review_api/api";
const outputDir = __dirname;
const account = { id: "fixture-ranger", email: "fixture-ranger@example.test", emailVerified: true, hasPassword: true };

function response(body, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function loadCatalogue() {
  const places = JSON.parse(await fs.readFile(path.resolve(__dirname, "../../../../data/places.json"), "utf8"));
  return places.filter((place) => ["provincial-goldstream-park", "provincial-strathcona-park", "regional-thetis-lake-regional-park"].includes(place.id));
}

async function installFixture(page, places) {
  const state = {
    visited: new Set(["provincial-goldstream-park"]),
    groups: [],
    nextGroup: 1,
  };
  await page.addInitScript(({ token }) => localStorage.setItem("every-park:account-token:v1", token), { token: "fixture-token" });
  await page.route(`**${apiPrefix}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const suffix = url.pathname.slice(apiPrefix.length);
    const method = request.method();
    if (suffix === "/auth/config") return route.fulfill(response({ googleEnabled: false, emailEnabled: true }));
    if (suffix === "/auth/me") return route.fulfill(response({ account, visitedIds: [...state.visited], visits: [...state.visited].map((placeId) => ({ placeId, visitedAt: "2026-09-11T00:00:00Z" })), completedTrailIds: [] }));
    if (suffix === "/places") return route.fulfill(response({ places, visitedIds: [...state.visited], visits: [...state.visited].map((placeId) => ({ placeId, visitedAt: "2026-09-11T00:00:00Z" })), completedTrailIds: [], coverageNote: "Fixture catalogue" }));
    if (suffix === "/groups" && method === "GET") return route.fulfill(response(state.groups));
    if (suffix === "/groups" && method === "POST") {
      const body = request.postDataJSON();
      const group = { id: `fixture-group-${state.nextGroup++}`, name: body.name, placeIds: [...new Set(body.placeIds ?? [])] };
      state.groups.push(group);
      return route.fulfill(response(group));
    }
    const match = suffix.match(/^\/groups\/([^/]+)(?:\/places)?$/);
    if (!match) return route.fulfill(response({ detail: "Fixture route not found" }, 404));
    const group = state.groups.find((item) => item.id === decodeURIComponent(match[1]));
    if (!group) return route.fulfill(response({ detail: "Fixture group not found" }, 404));
    if (suffix.endsWith("/places")) {
      const body = request.postDataJSON();
      if (method === "POST") group.placeIds = [...new Set([...group.placeIds, ...(body.placeIds ?? [])])];
      if (method === "DELETE") group.placeIds = group.placeIds.filter((id) => !body.placeIds?.includes(id));
      return route.fulfill(response(group));
    }
    if (method === "PATCH") {
      group.name = request.postDataJSON().name;
      return route.fulfill(response(group));
    }
    if (method === "DELETE") {
      state.groups = state.groups.filter((item) => item.id !== group.id);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill(response({ detail: "Fixture route method not found" }, 404));
  });
  return state;
}

async function snapshot(page, name) {
  await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true });
}

async function openTab(page, name) {
  await page.getByRole("button", { name: new RegExp(`^${name}$`, "i") }).last().click();
}

(async () => {
  const places = await loadCatalogue();
  const browser = await chromium.launch({ headless: true });
  const report = { appUrl, account: "synthetic", screenshots: [], checks: [] };
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "en-CA",
      geolocation: { longitude: -123.3656, latitude: 48.4284 },
      permissions: ["geolocation"],
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installFixture(page, places);
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Account" }).last().waitFor();

    await openTab(page, "Account");
    await page.getByRole("heading", { name: "Your account" }).waitFor();
    await snapshot(page, "fixture-mobile-account-photo");
    report.screenshots.push("fixture-mobile-account-photo.png");
    report.checks.push("authenticated account shelf rendered");

    await openTab(page, "Groups");
    await page.getByRole("button", { name: /New group/i }).click();
    await page.getByLabel("Group name").fill("Fixture weekend route");
    await page.getByRole("button", { name: "Save group" }).click();
    await page.getByRole("button", { name: /Rename Fixture weekend route/i }).waitFor();
    await page.getByRole("button", { name: /Rename Fixture weekend route/i }).click();
    await page.getByRole("textbox", { name: "Group name", exact: true }).fill("Fixture renamed route");
    await page.getByRole("button", { name: "Save group name" }).click();
    await page.getByPlaceholder("Search places to add").fill("Strathcona");
    await page.getByRole("button", { name: /^Strathcona Park/i }).click();
    await page.getByRole("button", { name: /Delete Fixture renamed route/i }).click();
    await page.getByRole("dialog", { name: /Delete Fixture renamed route/i }).waitFor();
    await snapshot(page, "fixture-mobile-group-confirmation");
    report.screenshots.push("fixture-mobile-group-confirmation.png");
    await page.getByRole("button", { name: "Cancel" }).click();
    report.checks.push("create-empty, rename, add-by-search, and styled-delete-cancel rendered");

    report.checks.push("fixture mutations remained available for the review run");
    report.pageErrors = errors;
    await fs.writeFile(path.join(outputDir, "fixture-review-report.json"), JSON.stringify(report, null, 2) + "\n");
    if (errors.length) throw new Error(`Browser page errors: ${errors.join("; ")}`);
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
