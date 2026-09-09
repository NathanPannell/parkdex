import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageName = process.env.ANDROID_SMOKE_PACKAGE || "app.parkdex";
const activityName = process.env.ANDROID_SMOKE_ACTIVITY || ".MainActivity";
const artifactDirectory = path.resolve(process.env.ANDROID_SMOKE_ARTIFACT_DIR || "android-smoke-artifacts");
const timeoutMs = Number(process.env.ANDROID_SMOKE_TIMEOUT_MS || 30_000);

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
  constructor(socket, diagnostics) {
    this.socket = socket;
    this.diagnostics = diagnostics;
    this.nextId = 1;
    this.pending = new Map();
    this.requests = new Map();
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
    if (message.method === "Runtime.exceptionThrown") {
      this.diagnostics.exceptions.push(params.exceptionDetails?.text ?? "Unknown exception");
    } else if (message.method === "Runtime.consoleAPICalled") {
      this.diagnostics.console.push({
        type: params.type,
        values: (params.args ?? []).map((argument) => argument.value ?? argument.description ?? ""),
      });
    } else if (message.method === "Log.entryAdded") {
      this.diagnostics.console.push({ type: params.entry?.level, values: [params.entry?.text ?? ""] });
    } else if (message.method === "Network.requestWillBeSent") {
      this.requests.set(params.requestId, params.request?.url ?? "");
    } else if (message.method === "Network.responseReceived") {
      this.diagnostics.responses.push({ status: params.response?.status ?? 0, url: params.response?.url ?? "" });
    } else if (message.method === "Network.loadingFailed") {
      this.diagnostics.failedRequests.push({
        errorText: params.errorText ?? "Unknown network failure",
        url: this.requests.get(params.requestId) ?? "",
      });
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
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

async function connectWebView(diagnostics) {
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
    const session = new DevToolsSession(socket, diagnostics);
    await Promise.all([
      session.send("Log.enable"),
      session.send("Network.enable"),
      session.send("Page.enable"),
      session.send("Runtime.enable"),
    ]);
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

async function openPlaces(session) {
  await session.evaluate(`
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Places")?.click()
  `);
  await waitFor("guest places list", () => session.evaluate("Boolean(document.querySelector('.authority-list .place-row'))"));
}

async function markUnseenPlaceVisited(session) {
  const parkName = await session.evaluate(`(() => {
    const row = [...document.querySelectorAll(".authority-list .place-row")]
      .find((candidate) => !candidate.querySelector(".specimen-number.caught"));
    if (!row) return "";
    const name = row.querySelector("strong")?.textContent?.trim() ?? "";
    row.click();
    return name;
  })()`);
  if (!parkName) throw new Error("No unvisited park was available for the guest persistence check.");
  await waitFor("place visit action", () => session.evaluate("Boolean(document.querySelector('.place-sheet .visit-button'))"));
  await session.evaluate(`(() => {
    const button = document.querySelector(".place-sheet .visit-button");
    if (button?.textContent?.includes("Mark as visited")) button.click();
  })()`);
  await waitFor("optimistic guest visit", () => session.evaluate(
    "document.querySelector('.place-sheet .visit-button')?.textContent?.includes('Visited')",
  ));
  return parkName;
}

async function waitForGuestVisitStorage(session) {
  await waitFor("guest visit in native Preferences", () => session.evaluate(`(async () => {
    const preferences = globalThis.Capacitor?.Plugins?.Preferences;
    if (!preferences) return false;
    const { value } = await preferences.get({ key: "every-park:visited:v1" });
    try { return JSON.parse(value ?? "[]").length > 0; } catch { return false; }
  })()`));
}

async function assertVisitPersisted(session, parkName) {
  await openPlaces(session);
  const persisted = await session.evaluate(`(() => {
    const expected = ${JSON.stringify(parkName)};
    const row = [...document.querySelectorAll(".authority-list .place-row")]
      .find((candidate) => candidate.querySelector("strong")?.textContent?.trim() === expected);
    return Boolean(row?.querySelector(".specimen-number.caught"));
  })()`);
  if (!persisted) throw new Error(`Guest visit for ${parkName} was lost after force-stop and relaunch.`);
}

async function runSmoke() {
  mkdirSync(artifactDirectory, { recursive: true });
  const diagnostics = { console: [], exceptions: [], failedRequests: [], responses: [] };
  let connection;
  try {
    launchApp();
    connection = await connectWebView(diagnostics);
    await waitForParkdex(connection.session);
    await openPlaces(connection.session);
    const parkName = await markUnseenPlaceVisited(connection.session);
    await waitForGuestVisitStorage(connection.session);
    await connection.session.screenshot("guest-visit-before-restart.png");
    connection.session.close();
    removeForward(connection.port);
    connection = undefined;

    adb("shell", "am", "force-stop", packageName);
    launchApp();
    connection = await connectWebView(diagnostics);
    await waitForParkdex(connection.session);
    await assertVisitPersisted(connection.session, parkName);
    await connection.session.screenshot("guest-visit-after-restart.png");

    const failures = blockingDiagnostics(diagnostics);
    if (failures.length) throw new Error(failures.join("\n"));
    writeFileSync(path.join(artifactDirectory, "diagnostics.json"), JSON.stringify({ ...diagnostics, parkName }, null, 2));
    process.stdout.write(`Android WebView smoke passed; guest visit persisted for ${parkName}.\n`);
  } catch (error) {
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
