import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageName = process.env.ANDROID_SMOKE_PACKAGE || "app.parkdex";
const activityName = process.env.ANDROID_SMOKE_ACTIVITY || ".MainActivity";
const artifactDirectory = path.resolve(process.env.ANDROID_SMOKE_ARTIFACT_DIR || "android-smoke-artifacts");
const timeoutMs = Number(process.env.ANDROID_SMOKE_TIMEOUT_MS || 30_000);
const smokeMode = process.env.ANDROID_SMOKE_MODE || "isolated";

if (!["isolated", "online"].includes(smokeMode)) {
  throw new Error("ANDROID_SMOKE_MODE must be isolated or online.");
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

export function blockingDiagnostics(diagnostics) {
  return [
    ...diagnostics.exceptions.map((failure) => `JavaScript exception: ${failure}`),
    ...diagnostics.responses
      .filter(({ status, url }) => status >= 500 && /(^https:\/\/localhost|\.up\.railway\.app)/.test(url))
      .map(({ status, url }) => `HTTP ${status}: ${url}`),
    ...diagnostics.failedRequests
      .filter(({ errorText, url }) => errorText !== "net::ERR_ABORTED"
        && /(^https:\/\/localhost|\.up\.railway\.app)/.test(url))
      .map(({ errorText, url }) => `${errorText}: ${url}`),
  ];
}

class DevToolsSession {
  constructor(socket, diagnostics, isolatedOffline = false) {
    this.socket = socket;
    this.diagnostics = diagnostics;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.requests = new Map();
    this.captureDiagnostics = smokeMode === "online";
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
    if (this.isolatedOffline) {
      responseCode = 408;
      body = JSON.stringify({ detail: "Expected offline phase of the Android smoke test." });
    } else if (params.request.method === "OPTIONS") {
      responseCode = 204;
      body = "";
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
