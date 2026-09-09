import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageName = process.env.ANDROID_SMOKE_PACKAGE || "app.parkdex";
const activityName = process.env.ANDROID_SMOKE_ACTIVITY || ".MainActivity";
const artifactDirectory = path.resolve(process.env.ANDROID_SMOKE_ARTIFACT_DIR || "android-smoke-artifacts");
const timeoutMs = Number(process.env.ANDROID_SMOKE_TIMEOUT_MS || 30_000);
const smokeMode = process.env.ANDROID_SMOKE_MODE || "isolated";
const smokeApiBaseUrl = (process.env.ANDROID_SMOKE_API_BASE_URL || "").replace(/\/$/, "");
const readinessBaseUrl = (process.env.ANDROID_SMOKE_READY_URL || smokeApiBaseUrl).replace(/\/$/, "");
const expectedCommitSha = process.env.ANDROID_SMOKE_EXPECTED_SHA || "";
const claimFixture = process.env.ANDROID_SMOKE_CLAIM_FIXTURE || "";

if (!["isolated", "online", "preview-online", "local-runtime"].includes(smokeMode)) {
  throw new Error("ANDROID_SMOKE_MODE must be isolated, online, preview-online, or local-runtime.");
}
if (smokeMode === "preview-online" && !isAllowedPreviewApiUrl(smokeApiBaseUrl)) {
  throw new Error("preview-online requires ANDROID_SMOKE_API_BASE_URL to be an HTTPS api-pr-20 Railway origin.");
}
if (smokeMode === "local-runtime" && !isAllowedLocalRuntimeEndpoints(smokeApiBaseUrl, readinessBaseUrl)) {
  throw new Error("local-runtime requires the exact emulator API and runner readiness HTTPS endpoints.");
}
if (["preview-online", "local-runtime"].includes(smokeMode) && !isFullCommitSha(expectedCommitSha)) {
  throw new Error(`${smokeMode} requires ANDROID_SMOKE_EXPECTED_SHA to be a full lowercase 40-character commit SHA.`);
}
if (["preview-online", "local-runtime"].includes(smokeMode) && !isAllowedClaimFixture(claimFixture)) {
  throw new Error(`${smokeMode} requires ANDROID_SMOKE_CLAIM_FIXTURE=inside-goldstream.`);
}

function adb(...args) {
  return execFileSync("adb", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function parseWebViewSocket(unixSockets, pid) {
  const expected = `webview_devtools_remote_${pid}`;
  return unixSockets.split(/\r?\n/).find((line) => line.includes(`@${expected}`)) ? expected : undefined;
}

export function chooseWebViewTarget(targets) {
  return targets.find((target) => target.type === "page" && target.url?.startsWith("https://localhost"))
    ?? targets.find((target) => target.type === "page");
}

export function sanitizedUrl(value) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function isAllowedPreviewApiUrl(value) {
  return /^https:\/\/api-pr-20-[a-z0-9]+(?:-[a-z0-9]+)*\.up\.railway\.app$/.test(value);
}

export function isAllowedLocalRuntimeEndpoints(apiBaseUrl, readyBaseUrl) {
  return apiBaseUrl === "https://10.0.2.2:8443" && readyBaseUrl === "https://127.0.0.1:8443";
}

export function isAllowedClaimFixture(value) {
  return value === "inside-goldstream";
}

export function isTrackedApplicationUrl(value) {
  return /(^https:\/\/localhost|\.up\.railway\.app|^https:\/\/10\.0\.2\.2:8443)/.test(value);
}

export function isFullCommitSha(value) {
  return /^[0-9a-f]{40}$/.test(value);
}

export function syntheticAccountEmail(identifier = randomUUID()) {
  return `android-smoke-${identifier}@example.com`;
}

export function previewReadyMatches(readiness, expectedSha) {
  return readiness?.status === "ready" && readiness?.commit === expectedSha;
}

export function releaseFooterMatches(text, expectedSha) {
  return isFullCommitSha(expectedSha) && new RegExp(`(?:^|\\s)${expectedSha.slice(0, 7)}(?:\\s|$)`).test(text);
}

export function blockingDiagnostics(diagnostics) {
  return [
    ...diagnostics.exceptions.map((failure) => `JavaScript exception: ${failure}`),
    ...diagnostics.responses
      .filter(({ status, url }) => status >= 500 && isTrackedApplicationUrl(url))
      .map(({ status, url }) => `HTTP ${status}: ${url}`),
    ...diagnostics.failedRequests
      .filter(({ errorText, url }) => errorText !== "net::ERR_ABORTED"
        && isTrackedApplicationUrl(url))
      .map(({ errorText, url }) => `${errorText}: ${url}`),
  ];
}

export function hasExpectedOfflineCatalogueResponse(diagnostics) {
  return diagnostics.responses.some(({ status, url }) => (
    status === 408 && url === "https://api-staging-882c.up.railway.app/api/places"
  ));
}

export function hasPreviewAuthJourney(diagnostics, apiBaseUrl) {
  const expected = new Map([
    [`${apiBaseUrl}/api/auth/register`, 201],
    [`${apiBaseUrl}/api/auth/me`, 200],
  ]);
  for (const { status, url } of diagnostics.responses) {
    if (expected.get(url) === status) expected.delete(url);
  }
  return expected.size === 0;
}

export function hasLiveClaimImportJourney(diagnostics, apiBaseUrl) {
  const expected = new Map([
    [`${apiBaseUrl}/api/claim-recommendations`, 200],
    [`${apiBaseUrl}/api/claims`, 200],
    [`${apiBaseUrl}/api/account/import-guest`, 200],
  ]);
  for (const { status, url } of diagnostics.responses) {
    if (expected.get(url) === status) expected.delete(url);
  }
  return expected.size === 0;
}

export function countEndpointResponses(diagnostics, endpointUrl) {
  return diagnostics.responses.filter(({ status, url }) => url === endpointUrl && status !== 204).length;
}

export function hasNewEndpointResponse(diagnostics, endpointUrl, previousCount) {
  return countEndpointResponses(diagnostics, endpointUrl) > previousCount;
}

class DevToolsSession {
  constructor(socket, diagnostics, isolatedOffline = false) {
    this.socket = socket;
    this.diagnostics = diagnostics;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.requests = new Map();
    this.captureDiagnostics = smokeMode !== "isolated";
    this.isolatedOffline = isolatedOffline;
    socket.addEventListener("message", ({ data }) => this.onMessage(String(data)));
    socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("WebView DevTools connection closed."));
      this.pending.clear();
    });
  }

  onMessage(rawMessage) {
    const message = JSON.parse(rawMessage);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    const waiters = this.eventWaiters.get(message.method);
    if (waiters?.length) {
      this.eventWaiters.delete(message.method);
      for (const resolve of waiters) resolve(params);
    }
    if (message.method === "Runtime.exceptionThrown" && this.captureDiagnostics) {
      this.diagnostics.exceptions.push("Runtime exception");
    } else if (message.method === "Runtime.consoleAPICalled" && this.captureDiagnostics) {
      this.diagnostics.console.push({ category: "runtime-console", level: params.type ?? "unknown" });
    } else if (message.method === "Log.entryAdded" && this.captureDiagnostics) {
      this.diagnostics.console.push({ category: "browser-log", level: params.entry?.level ?? "unknown" });
    } else if (message.method === "Network.requestWillBeSent" && this.captureDiagnostics) {
      this.requests.set(params.requestId, sanitizedUrl(params.request?.url ?? ""));
    } else if (message.method === "Network.responseReceived" && this.captureDiagnostics) {
      this.diagnostics.responses.push({
        status: params.response?.status ?? 0,
        url: sanitizedUrl(params.response?.url ?? ""),
      });
    } else if (message.method === "Network.loadingFailed" && this.captureDiagnostics) {
      this.diagnostics.failedRequests.push({
        errorText: params.errorText ?? "Unknown network failure",
        url: this.requests.get(params.requestId) ?? "",
      });
    } else if (message.method === "Fetch.requestPaused") {
      void this.fulfillIsolatedApiRequest(params).catch(() => {
        this.diagnostics.exceptions.push("Isolated API fulfillment failed");
      });
    }
  }

  beginDiagnostics() {
    this.requests.clear();
    this.captureDiagnostics = true;
  }

  async fulfillIsolatedApiRequest(params) {
    const url = new URL(params.request.url);
    const commonHeaders = [
      { name: "Access-Control-Allow-Origin", value: "https://localhost" },
      { name: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, X-Collection-Key" },
      { name: "Access-Control-Allow-Methods", value: "GET, PUT, DELETE, OPTIONS" },
      { name: "Content-Type", value: "application/json" },
    ];
    let responseCode = 404;
    let body = JSON.stringify({ detail: "Not available in isolated Android smoke mode." });
    if (params.request.method === "OPTIONS") {
      responseCode = 204;
      body = "";
    } else if (this.isolatedOffline) {
      responseCode = 408;
      body = JSON.stringify({ detail: "Expected offline phase of the Android smoke test." });
    } else if (params.request.method === "GET" && url.pathname === "/api/places") {
      responseCode = 200;
      body = JSON.stringify({
        places: [{
          id: "android-smoke-park",
          name: "Android Smoke Park",
          category: "regional",
          latitude: 48.4284,
          longitude: -123.3656,
          region: "Vancouver Island",
          description: "An isolated fixture for the native persistence journey.",
          sourceUrl: "https://example.invalid/android-smoke-park",
          sourceName: "Android smoke fixture",
        }],
        visitedIds: [],
        visits: [],
        completedTrailIds: [],
        coverageNote: "Isolated Android smoke fixture",
      });
    } else if (params.request.method === "PUT" && url.pathname === "/api/visits/android-smoke-park") {
      responseCode = 200;
      body = JSON.stringify({ visitedAt: "2026-01-01T00:00:00.000Z" });
    }
    await this.send("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode,
      responseHeaders: commonHeaders,
      body: Buffer.from(body).toString("base64"),
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
      const wrappedResolve = (params) => { clearTimeout(timer); resolve(params); };
      this.eventWaiters.set(method, [...(this.eventWaiters.get(method) ?? []), wrappedResolve]);
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "Browser evaluation failed.");
    return response.result?.value;
  }

  async screenshot(fileName) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    writeFileSync(path.join(artifactDirectory, fileName), Buffer.from(data, "base64"));
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(description, operation) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : "."}`);
}

async function waitForPid() {
  return waitFor("Parkdex process", async () => adb("shell", "pidof", packageName).split(/\s+/)[0]);
}

async function connectWebView(diagnostics, isolatedOffline = false) {
  const pid = await waitForPid();
  const socketName = await waitFor("debuggable Parkdex WebView", async () => (
    parseWebViewSocket(adb("shell", "cat", "/proc/net/unix"), pid)
  ));
  const port = adb("forward", "tcp:0", `localabstract:${socketName}`);
  try {
    const target = await waitFor("Parkdex DevTools page", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return undefined;
      return chooseWebViewTarget(await response.json());
    });
    const socket = new WebSocket(target.webSocketDebuggerUrl.replace("localhost", "127.0.0.1"));
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to WebView DevTools.")), { once: true });
    });
    const session = new DevToolsSession(socket, diagnostics, isolatedOffline);
    await Promise.all([
      session.send("Log.enable"),
      session.send("Network.enable"),
      session.send("Page.enable"),
      session.send("Runtime.enable"),
    ]);
    if (smokeMode === "isolated") {
      await session.send("Fetch.enable", { patterns: [{ urlPattern: "*api*", requestStage: "Request" }] });
      session.beginDiagnostics();
      const loaded = session.waitForEvent("Page.loadEventFired");
      await session.send("Page.reload", { ignoreCache: true });
      await loaded;
    }
    return { session, port };
  } catch (error) {
    removeForward(port);
    throw error;
  }
}

function launchApp() {
  adb("shell", "am", "start", "-W", "-n", `${packageName}/${activityName}`);
}

function removeForward(port) {
  try { adb("forward", "--remove", `tcp:${port}`); } catch { /* best-effort cleanup */ }
}

async function waitForParkdex(session) {
  await waitFor("rendered Parkdex UI", () => session.evaluate(`
    document.querySelector(".expedition-header h1")?.textContent?.trim() === "Parkdex"
      && !document.querySelector(".native-bootstrap")
  `));
}

async function openFixturePlace(session) {
  await session.evaluate(`
    [...document.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Search places")?.click()
  `);
  await session.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Search places"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "Android Smoke Park");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await waitFor("guest search result", () => session.evaluate("Boolean(document.querySelector('.search-results button'))"));
  await session.evaluate(`(() => {
    document.querySelector(".search-results button")?.click();
  })()`);
  await waitFor("Android Smoke Park details", () => session.evaluate(
    "document.querySelector('.place-sheet h2')?.textContent?.trim() === 'Android Smoke Park'",
  ));
}

async function searchForPlace(session, name) {
  await session.evaluate(`
    [...document.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Search places")?.click()
  `);
  await session.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Search places"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await waitFor(`${name} search result`, () => session.evaluate("Boolean(document.querySelector('.search-results button'))"));
  await session.evaluate("document.querySelector('.search-results button')?.click()");
  await waitFor(`${name} details`, () => session.evaluate(
    `document.querySelector('.place-sheet h2')?.textContent?.trim() === ${JSON.stringify(name)}`,
  ));
}

function configureCoarseEmulatorLocation() {
  adb("shell", "pm", "grant", packageName, "android.permission.ACCESS_COARSE_LOCATION");
  try { adb("shell", "pm", "revoke", packageName, "android.permission.ACCESS_FINE_LOCATION"); } catch { /* may already be denied */ }
  try { adb("shell", "appops", "set", packageName, "android:fine_location", "ignore"); } catch { /* platform spelling varies */ }
  const packageState = adb("shell", "dumpsys", "package", packageName);
  const coarseGranted = /android\.permission\.ACCESS_COARSE_LOCATION: granted=true/.test(packageState);
  const fineGranted = /android\.permission\.ACCESS_FINE_LOCATION: granted=true/.test(packageState);
  if (!coarseGranted || fineGranted) throw new Error("Could not establish coarse-only location permission on the emulator.");
  adb("emu", "geo", "fix", "-123.542431", "48.475557");
}

async function exerciseCoarseNativeLocation(session, diagnostics) {
  await searchForPlace(session, "Goldstream Park");
  const recommendationUrl = `${smokeApiBaseUrl}/api/claim-recommendations`;
  const responsesBeforeLocate = countEndpointResponses(diagnostics, recommendationUrl);
  await session.evaluate(`
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Check if I can claim a park"))?.click()
  `);
  const accuracyMeters = await waitFor("coarse Capacitor location sample", () => session.evaluate(`(() => {
    const text = document.querySelector(".claim-sample")?.textContent ?? "";
    const value = Number(text.match(/±(\\d+)/)?.[1]);
    return Number.isFinite(value) && value >= 0 ? value : false;
  })()`));
  await waitFor("settled coarse location recommendation", async () => {
    const checking = await session.evaluate(`
      [...document.querySelectorAll("button")]
        .some((button) => button.textContent?.includes("Checking your boundary"))
    `);
    return !checking && hasNewEndpointResponse(diagnostics, recommendationUrl, responsesBeforeLocate);
  });
  diagnostics.emulatorLocation = {
    permission: "coarse-only",
    source: "adb-emulator-geo-fix-through-capacitor",
    requestedLatitude: 48.475557,
    requestedLongitude: -123.542431,
    accuracyMeters,
  };
}

async function claimGoldstreamWithNamedFixture(session) {
  const recommendationUrl = `${smokeApiBaseUrl}/api/claim-recommendations`;
  const responsesBeforeFixture = countEndpointResponses(session.diagnostics, recommendationUrl);
  const selected = await session.evaluate(`(() => {
    const fixture = document.querySelector(".claim-fixture select");
    if (!fixture) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(fixture, ${JSON.stringify(claimFixture)});
    fixture.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  if (!selected) throw new Error("The APK was not built with the guarded claim fixture UI enabled.");
  await waitFor("distinct enabled Goldstream fixture recommendation", async () => {
    if (!hasNewEndpointResponse(session.diagnostics, recommendationUrl, responsesBeforeFixture)) return false;
    return session.evaluate(`(() => {
      const button = [...document.querySelectorAll(".claim-recommendation button")]
        .find((candidate) => candidate.textContent?.trim() === "Claim this park");
      return Boolean(button && !button.disabled);
    })()`);
  });
  await session.evaluate(`
    [...document.querySelectorAll(".claim-recommendation button")]
      .find((button) => button.textContent?.trim() === "Claim this park")?.click()
  `);
  await waitFor("claimed guest Goldstream postcard", () => session.evaluate(
    "Boolean(document.querySelector('.place-sheet .visit-postcard[aria-label*=\"Goldstream Park\"]'))",
  ));
  await session.evaluate(`
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Claim my badge"))?.click()
  `);
}

async function assertGoldstreamPostcard(session) {
  await waitFor("imported Goldstream postcard", () => session.evaluate(`
    Boolean(document.querySelector('.postcard-journal .visit-postcard[aria-label*="Goldstream Park"]'))
  `));
}

async function importGuestClaim(session) {
  const importButton = await waitFor("guest progress import action", () => session.evaluate(`(() => {
    const button = [...document.querySelectorAll(".import-card button")]
      .find((candidate) => candidate.textContent?.trim() === "Add guest progress");
    return Boolean(button && !button.disabled);
  })()`));
  if (!importButton) throw new Error("Guest progress was not offered for account import.");
  await session.evaluate(`
    [...document.querySelectorAll(".import-card button")]
      .find((button) => button.textContent?.trim() === "Add guest progress")?.click()
  `);
  await assertGoldstreamPostcard(session);
  await waitFor("completed guest progress import", () => session.evaluate(
    "!document.querySelector('.import-card')",
  ));
}

async function fillLabeledInput(session, label, value) {
  const updated = await session.evaluate(`(() => {
    const field = [...document.querySelectorAll("label")]
      .find((candidate) => candidate.textContent?.trim().startsWith(${JSON.stringify(label)}))
      ?.querySelector("input");
    if (!field) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  if (!updated) throw new Error(`Could not find the ${label.toLowerCase()} registration field.`);
}

async function registerPreviewAccount(session, email, password) {
  await session.evaluate(`
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Account")?.click()
  `);
  await waitFor("preview account registration form", () => session.evaluate("Boolean(document.querySelector('.auth-form'))"));
  await fillLabeledInput(session, "Email", email);
  await fillLabeledInput(session, "Password", password);
  await session.evaluate("document.querySelector('.auth-form')?.requestSubmit()");
  await waitFor("registered preview account", () => session.evaluate(
    "document.querySelector('.feature-account h2')?.textContent?.trim() === 'Your account'",
  ));
}

async function assertPreviewApiIdentity(diagnostics) {
  const response = await fetch(`${readinessBaseUrl}/ready`, { redirect: "error" });
  if (!response.ok) throw new Error(`The live smoke readiness check returned HTTP ${response.status}.`);
  const readiness = await response.json();
  if (!previewReadyMatches(readiness, expectedCommitSha)) {
    throw new Error("The live smoke API commit does not match ANDROID_SMOKE_EXPECTED_SHA.");
  }
  diagnostics.liveIdentity = { expectedCommitSha, apiCommitSha: readiness.commit, runtime: smokeMode };
}

async function assertPreviewUiIdentity(session) {
  await session.evaluate(`
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Account")?.click()
  `);
  await waitFor("matching APK release footer", () => session.evaluate(`(() => {
    const footer = document.querySelector(".feature-account .release-footer");
    return Boolean(footer?.offsetParent)
      && (footer?.textContent ?? "").split("·").some((part) => part.trim() === ${JSON.stringify(expectedCommitSha.slice(0, 7))});
  })()`));
  await session.evaluate("document.querySelector('.feature-account .release-footer')?.scrollIntoView({ block: 'center' })");
}

async function assertPreviewAccountRestored(session, email) {
  await session.evaluate(`
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Account")?.click()
  `);
  await waitFor("preview account restored from native credentials", () => session.evaluate(
    `document.querySelector('.feature-account h2')?.textContent?.trim() === "Your account"
      && document.querySelector('.feature-account .panel-heading p')?.textContent?.trim() === ${JSON.stringify(email)}`,
  ));
}

async function maskPreviewAccountIdentity(session) {
  await session.evaluate(`(() => {
    const identity = document.querySelector('.feature-account .panel-heading p');
    if (identity) identity.textContent = "Synthetic preview account";
    for (const input of document.querySelectorAll("input")) input.value = "";
  })()`);
}

async function runPreviewOnlineSmoke(diagnostics) {
  let connection;
  const email = syntheticAccountEmail();
  const password = `Pkd!${randomBytes(18).toString("base64url")}`;
  try {
    await assertPreviewApiIdentity(diagnostics);
    configureCoarseEmulatorLocation();
    launchApp();
    connection = await connectWebView(diagnostics);
    await waitForParkdex(connection.session);
    await assertPreviewUiIdentity(connection.session);
    await connection.session.screenshot("preview-release-identity.png");
    await connection.session.evaluate(`
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Map")?.click()
    `);
    await exerciseCoarseNativeLocation(connection.session, diagnostics);
    await claimGoldstreamWithNamedFixture(connection.session);
    await connection.session.screenshot("preview-guest-claim.png");
    await registerPreviewAccount(connection.session, email, password);
    await importGuestClaim(connection.session);
    await maskPreviewAccountIdentity(connection.session);
    await connection.session.screenshot("preview-account-before-restart.png");
    connection.session.close();
    removeForward(connection.port);

    adb("shell", "am", "force-stop", packageName);
    launchApp();
    connection = await connectWebView(diagnostics);
    await waitForParkdex(connection.session);
    await assertPreviewAccountRestored(connection.session, email);
    await assertGoldstreamPostcard(connection.session);
    await maskPreviewAccountIdentity(connection.session);
    await connection.session.screenshot("preview-account-after-restart.png");

    if (!hasPreviewAuthJourney(diagnostics, smokeApiBaseUrl)) {
      throw new Error("The WebView did not complete registration and restart authentication against the required live smoke API.");
    }
    if (!hasLiveClaimImportJourney(diagnostics, smokeApiBaseUrl)) {
      throw new Error("The WebView did not complete the fixture claim and guest-to-account import against the live smoke API.");
    }
    const failures = blockingDiagnostics(diagnostics);
    if (failures.length) throw new Error(failures.join("\n"));
    writeFileSync(path.join(artifactDirectory, "diagnostics.json"), JSON.stringify(diagnostics, null, 2));
    process.stdout.write(`Android ${smokeMode} smoke passed; coarse native location, fixture claim import, and account restart persistence were verified.\n`);
  } catch (error) {
    if (connection) {
      try { await maskPreviewAccountIdentity(connection.session); } catch { /* best-effort redaction */ }
      try { await connection.session.screenshot("smoke-failure.png"); } catch { /* best-effort diagnostics */ }
    }
    writeFileSync(path.join(artifactDirectory, "diagnostics.json"), JSON.stringify({
      ...diagnostics,
      error: error instanceof Error ? error.stack : String(error),
    }, null, 2));
    throw error;
  } finally {
    if (connection) {
      connection.session.close();
      removeForward(connection.port);
    }
  }
}

async function seedGuestVisitStorage(session) {
  const stored = await session.evaluate(`(async () => {
    const preferences = globalThis.Capacitor?.Plugins?.Preferences;
    if (!preferences) return false;
    await preferences.set({ key: "every-park:visited:v1", value: JSON.stringify(["android-smoke-park"]) });
    await preferences.set({ key: "every-park:visit-timestamps:v1", value: JSON.stringify({ "android-smoke-park": "2026-01-01T00:00:00.000Z" }) });
    return true;
  })()`);
  if (!stored) throw new Error("Capacitor Preferences was unavailable for the guest persistence check.");
}

async function assertGuestVisitInUi(session) {
  await openFixturePlace(session);
  await waitFor("restored guest visit in the Parkdex UI", () => session.evaluate(
    "document.querySelector('.place-sheet .legacy-visit-note')?.textContent?.includes('Visited')",
  ));
}

async function runSmoke() {
  mkdirSync(artifactDirectory, { recursive: true });
  const diagnostics = { mode: smokeMode, console: [], exceptions: [], failedRequests: [], responses: [] };
  if (["preview-online", "local-runtime"].includes(smokeMode)) {
    await runPreviewOnlineSmoke(diagnostics);
    return;
  }
  let connection;
  try {
    launchApp();
    connection = await connectWebView(diagnostics);
    await waitForParkdex(connection.session);
    if (smokeMode === "online") {
      await connection.session.screenshot("online-app.png");
      const failures = blockingDiagnostics(diagnostics);
      if (failures.length) throw new Error(failures.join("\n"));
      writeFileSync(path.join(artifactDirectory, "diagnostics.json"), JSON.stringify(diagnostics, null, 2));
      process.stdout.write("Android WebView online smoke passed; Parkdex rendered without application failures.\n");
      return;
    }
    await openFixturePlace(connection.session);
    await seedGuestVisitStorage(connection.session);
    connection.session.isolatedOffline = true;
    const loaded = connection.session.waitForEvent("Page.loadEventFired");
    await connection.session.send("Page.reload", { ignoreCache: true });
    await loaded;
    await waitForParkdex(connection.session);
    await assertGuestVisitInUi(connection.session);
    await connection.session.screenshot("guest-visit-before-restart.png");
    connection.session.close();
    removeForward(connection.port);
    connection = undefined;

    adb("shell", "am", "force-stop", packageName);
    launchApp();
    connection = await connectWebView(diagnostics, smokeMode === "isolated");
    await waitForParkdex(connection.session);
    await assertGuestVisitInUi(connection.session);
    await connection.session.screenshot("guest-visit-after-restart.png");

    if (!hasExpectedOfflineCatalogueResponse(diagnostics)) {
      throw new Error("The isolated persistence phase did not exercise the expected offline catalogue response.");
    }
    const failures = blockingDiagnostics(diagnostics);
    if (failures.length) throw new Error(failures.join("\n"));
    writeFileSync(path.join(artifactDirectory, "diagnostics.json"), JSON.stringify({ ...diagnostics, parkName: "Android Smoke Park" }, null, 2));
    process.stdout.write("Android WebView smoke passed; the guest visit persisted for Android Smoke Park.\n");
  } catch (error) {
    if (connection) {
      try { await connection.session.screenshot("smoke-failure.png"); } catch { /* best-effort diagnostics */ }
    }
    writeFileSync(path.join(artifactDirectory, "diagnostics.json"), JSON.stringify({
      ...diagnostics,
      error: error instanceof Error ? error.stack : String(error),
    }, null, 2));
    throw error;
  } finally {
    if (connection) {
      connection.session.close();
      removeForward(connection.port);
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runSmoke().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}
