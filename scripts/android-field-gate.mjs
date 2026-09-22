#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const PACKAGE = "app.parkdex.debug";
const ACTIVITY = `${PACKAGE}/app.parkdex.MainActivity`;
const BELL = { longitude: -123.0600868, latitude: 49.0918726 };
const MOTION = { longitude: -123.0695, latitude: 49.0965 };
// This budget includes a full cold Activity/WebView launch before the native
// watch can receive the emulator's edge-triggered location fix. Keep the
// measured TTFF in the attestation so regressions remain visible.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PHOTO_TIMEOUT_MS = 60_000;
const NETWORK_OFFLINE_FAILURE_TIMEOUT_MS = 45_000;
// Android's virtual Ethernet and WebView can take longer than the application
// retry schedule to agree that connectivity has returned. This remains a
// bounded, measured recovery oracle; ordinary cold-start TTFF is still held to
// the tighter DEFAULT_TIMEOUT_MS budget below.
const NETWORK_RECOVERY_TIMEOUT_MS = 60_000;
const FIELD_BUILD_ENVIRONMENT = Object.freeze({
  NEXT_PUBLIC_API_BASE_URL: "https://api-staging-882c.up.railway.app",
  PARKDEX_CATALOGUE_SCOPE: "staging",
  NEXT_PUBLIC_FIELD_DIAGNOSTICS: "1",
});
const RAILWAY_IDENTITY = Object.freeze({
  projectId: "0999e6e0-d2ae-4b48-b516-55d53dba7cb5",
  environmentId: "369b82da-1be4-4aea-898a-c5050c4985f7",
  serviceId: "b30d9ca5-fc77-4427-a955-b020a7ec3cf8",
});

export function assertEmulatorSerial(serial) {
  if (!/^emulator-[0-9]+$/.test(serial || "")) {
    throw new Error("--serial must be an explicit Android emulator serial such as emulator-5554");
  }
  return serial;
}

export function parseAdbDevices(output) {
  return String(output)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...details] = line.split(/\s+/);
      return { serial, state, details: details.join(" ") };
    });
}

export function parseBounds(bounds) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds || "");
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  if (right <= left || bottom <= top) return null;
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

export function locateButtonCenter(xml) {
  const node = String(xml).match(/<node\b[^>]*(?:content-desc="Show my current location"|text="Show my current location")[^>]*>/)?.[0];
  return parseBounds(node?.match(/bounds="([^"]+)"/)?.[1]);
}

export function labelledNodeCenter(xml, labels) {
  const matchers = labels.map((label) => label instanceof RegExp ? label : new RegExp(`^${String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
  const matches = [];
  for (const match of String(xml).matchAll(/<node\b[^>]*>/g)) {
    const node = match[0];
    const nodeLabels = [...node.matchAll(/(?:text|content-desc)="([^"]*)"/g)].map((candidate) => candidate[1]);
    if (!nodeLabels.some((nodeLabel) => matchers.some((matcher) => matcher.test(nodeLabel)))) continue;
    const center = parseBounds(node.match(/bounds="([^"]+)"/)?.[1]);
    if (center) matches.push({
      center,
      clickable: /clickable="true"/.test(node) && !/enabled="false"/.test(node),
    });
  }
  return matches.find((candidate) => candidate.clickable)?.center || matches[0]?.center || null;
}

const ONBOARDING_SKIP_LABELS = [/^Skip(?: intro)?$/i];
const MY_DEX_LABELS = [/^(?:My Dex|Account)$/i];
const SETTINGS_LABELS = [/^Settings$/i];

/**
 * The first launch intro is rendered in the WebView and can cover every
 * native/WebView target the gate needs. Keep this exact so the global
 * "Skip to ..." accessibility controls are never mistaken for the intro.
 */
export function onboardingSkipCenter(xml) {
  return labelledNodeCenter(xml, ONBOARDING_SKIP_LABELS);
}

export function photoPostcardReady(xml, placeName = "Bell Park") {
  const text = String(xml);
  const escaped = placeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:text|content-desc)="Private postcard from ${escaped}"`, "i").test(text)
    && new RegExp(`(?:text|content-desc)="Private visit photo from ${escaped}"`, "i").test(text)
    && Boolean(labelledNodeCenter(text, [/^Remove photo$/i]))
    && !/Photo unavailable|Loading private photo/i.test(text);
}

export function photoJourneyCleanupReady(xml, placeName = "Bell Park") {
  const text = String(xml);
  const escaped = placeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return /(?:Your first boundary claim will become a postcard here|Your first postcard will appear in your Collection after a boundary claim)/i.test(text)
    && !new RegExp(`(?:text|content-desc)="(?:Postcard|Private postcard) from ${escaped}"`, "i").test(text);
}

function photoReviewSaveCenter(xml) {
  const text = String(xml);
  if (!/(?:text|content-desc)="Keep this one\?"/i.test(text)) return null;
  return labelledNodeCenter(text, [/^Save my visit$/i]);
}

export function photoReviewReady(xml) {
  return Boolean(photoReviewSaveCenter(xml));
}

export function bellParkReady(xml) {
  const text = String(xml);
  return /(?:text|content-desc)="[^"]*Bell Park[^"]*"/.test(text)
    && distanceLabels(text).length > 0;
}

export function locationUnavailable(xml) {
  return /(?:text|content-desc)="[^"]*(?:location is unavailable|could not get your location|location tracking did not become active)[^"]*"/i.test(String(xml));
}

export function catalogueUnavailable(xml) {
  return /(?:text|content-desc)="[^"]*(?:could not load the field guide|failed to fetch|field guide is offline)[^"]*"/i.test(String(xml));
}

export function offlineCatalogueOracle(xml) {
  if (bellParkReady(xml)) return "unexpected-ready";
  if (catalogueUnavailable(xml)) return "unavailable";
  return null;
}

export function parseAirplaneMode(output) {
  const value = String(output).trim().toLowerCase();
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  throw new Error(`Unexpected emulator airplane-mode state: ${sanitizeText(value || "empty")}`);
}

export function parseAppPid(output) {
  const value = String(output).trim();
  if (!/^\d+$/.test(value)) throw new Error("Could not resolve the Parkdex Activity process");
  return value;
}

export function networkStartupRecoveryReady(evidence) {
  return evidence?.initialCatalogueUnavailableObserved === true
    && evidence?.recoveredWithoutRestart === true
    && evidence?.activityPidStable === true
    && evidence?.networkRestored === true
    && Number.isFinite(evidence?.offlineHoldMs)
    && evidence.offlineHoldMs >= 0
    && Number.isFinite(evidence?.elapsedAfterRestoreMs)
    && evidence.elapsedAfterRestoreMs >= 0
    && Array.isArray(evidence?.distances)
    && evidence.distances.length > 0;
}

export function pinOracle(xml) {
  const text = String(xml);
  if (/(?:content-desc|text)="[^"]*(?:current location pin|location pin ready|user location)[^"]*"/i.test(text)) return "native-ui";
  return "nearby-bell-park";
}

export function distanceLabels(xml) {
  return [...String(xml).matchAll(/(?:text|content-desc)="([^"]*\b\d+(?:\.\d+)?\s*km\b[^"]*)"/gi)]
    .map((match) => match[1]);
}

export function summarizeDurations(values) {
  if (!values.length) return { count: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1),
  };
}

export function retryActionDue(nowMs, lastAttemptMs, intervalMs = 2_000) {
  if (![nowMs, lastAttemptMs, intervalMs].every(Number.isFinite) || intervalMs < 1) {
    throw new Error("Retry scheduling requires finite timestamps and a positive interval");
  }
  return nowMs - lastAttemptMs >= intervalMs;
}

export function evaluateDumpedPoll({ clock = Date.now, deadlineMs, lastRetryAt, retryIntervalMs = 2_000, retryEnabled = false }, predicate, value) {
  const afterDumpMs = clock();
  if (afterDumpMs >= deadlineMs) return { expired: true, matched: false, retry: false };
  const matchedValue = predicate(value);
  const matched = Boolean(matchedValue);
  const afterPredicateMs = clock();
  if (afterPredicateMs >= deadlineMs) return { expired: true, matched: false, retry: false };
  return {
    expired: false,
    matched,
    value: matchedValue,
    retry: !matched && retryEnabled && retryActionDue(afterPredicateMs, lastRetryAt, retryIntervalMs),
    observedAtMs: afterPredicateMs,
  };
}

export function sanitizeText(value) {
  return String(value)
    .replace(/("(?:(?:r2|aws)[_-]?)?(?:authorization|token|password|api[_-]?key|access[_-]?key(?:[_-]?id)?|secret(?:[_-]?access)?[_-]?key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/((?:(?:r2|aws)[_-]?)?(?:token|password|api[_-]?key|access[_-]?key(?:[_-]?id)?|secret(?:[_-]?access)?[_-]?key)\s*[:=]\s*)(["'])(?:\\.|(?!\2).)*\2/gi, "$1$2[redacted]$2")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/((?:(?:r2|aws)[_-]?)?(?:token|password|api[_-]?key|access[_-]?key(?:[_-]?id)?|secret(?:[_-]?access)?[_-]?key)\s*[:=]\s*)[^\s,;"']+/gi, "$1[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/-?\d{1,2}\.\d{4,}\s*[,/]\s*-?\d{1,3}\.\d{4,}/g, "[redacted-coordinates]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/[A-Za-z0-9_-]{41,}/g, "[redacted]");
}

export function stagingBuildEnvironment(inherited = {}) {
  return { ...inherited, ...FIELD_BUILD_ENVIRONMENT };
}

export function publicStagingBuildIdentity(environment) {
  return Object.fromEntries(Object.keys(FIELD_BUILD_ENVIRONMENT).map((name) => [name, environment?.[name]]));
}

export function isFieldReadyProfile(options, workingTreeClean) {
  return workingTreeClean
    && !options.allowDirty
    && !options.skipPhotoJourney
    && !options.skipR2Contract
    && options.trials === 10
    && options.timeoutMs === DEFAULT_TIMEOUT_MS
    && options.photoTimeoutMs === DEFAULT_PHOTO_TIMEOUT_MS;
}

const REQUIRED_REPOSITORY_PHASES = ["start", "after-sync", "after-assemble", "after-connected-tests", "before-install", "final"];
const REQUIRED_APK_PHASES = ["after-assemble", "after-connected-tests", "before-install", "final"];

export function fieldReadyFromCheckpoints({ profileReady, commitSha, treeSha, stagingBaseSha, apkSha, checkpoints, r2Contract, buildEnvironment, networkStartupRecovery }) {
  const railwayIdentityMatches = r2Contract?.railwayIdentity?.projectId === RAILWAY_IDENTITY.projectId
    && r2Contract?.railwayIdentity?.environmentId === RAILWAY_IDENTITY.environmentId
    && r2Contract?.railwayIdentity?.serviceId === RAILWAY_IDENTITY.serviceId;
  const stagingBuildMatches = Object.entries(FIELD_BUILD_ENVIRONMENT)
    .every(([name, value]) => buildEnvironment?.[name] === value);
  if (!profileReady || !commitSha || !treeSha || !stagingBaseSha || !apkSha || r2Contract?.status !== "success" || !railwayIdentityMatches || !stagingBuildMatches || !networkStartupRecoveryReady(networkStartupRecovery)) return false;
  const byPhase = new Map((checkpoints || []).map((checkpoint) => [checkpoint.phase, checkpoint]));
  if (!REQUIRED_REPOSITORY_PHASES.every((phase) => byPhase.has(phase))) return false;
  if (!REQUIRED_APK_PHASES.every((phase) => byPhase.has(phase))) return false;
  if (!REQUIRED_REPOSITORY_PHASES.every((phase) => {
    const checkpoint = byPhase.get(phase);
    return checkpoint.clean && checkpoint.commitSha === commitSha && checkpoint.treeSha === treeSha;
  })) return false;
  return REQUIRED_APK_PHASES.every((phase) => byPhase.get(phase).apkSha === apkSha);
}

export function parseR2ContractOutput(output) {
  let result;
  for (const line of String(output).trim().split(/\r?\n/).filter(Boolean).reverse()) {
    try {
      const candidate = JSON.parse(line);
      if (candidate && typeof candidate === "object") { result = candidate; break; }
    } catch { /* Railway may print non-JSON status lines around command output. */ }
  }
  if (!result) throw new Error("R2 contract did not return valid JSON");
  const requiredTimings = ["put", "get", "delete", "missingRead", "total"];
  if (result?.status !== "success" || !Number.isInteger(result.byteCount) || result.byteCount < 1
      || !requiredTimings.every((name) => typeof result.timingsMs?.[name] === "number" && result.timingsMs[name] >= 0)) {
    throw new Error("R2 contract did not confirm put, read, delete, and missing read");
  }
  return { status: "success", byteCount: result.byteCount, timingsMs: result.timingsMs };
}

export function validateRailwayProjectDir(value) {
  if (!value || !isAbsolute(value)) throw new Error("A linked absolute Railway project directory is required");
  const directory = resolve(value);
  try {
    if (!statSync(directory).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("The configured Railway project directory does not exist or is not a directory");
  }
  return directory;
}

export function railwayContractCommand(root, railwayProjectDir, platform = process.platform) {
  const directory = validateRailwayProjectDir(railwayProjectDir);
  const localRailway = platform === "win32" ? join(root, "node_modules", ".bin", "railway.cmd") : join(root, "node_modules", ".bin", "railway");
  const executable = existsSync(localRailway) ? localRailway : (platform === "win32" ? "railway.cmd" : "railway");
  const contractScript = resolve(root, "scripts", "r2-contract.py");
  if (!existsSync(contractScript)) throw new Error("The current branch R2 contract script is missing");
  return {
    cwd: directory,
    executable,
    statusArgs: ["status", "--json"],
    contractArgs: ["run", "--environment", "staging", "--service", "api", "python", contractScript],
    contractScript,
  };
}

export function validateRailwayStatus(output) {
  let status;
  try { status = JSON.parse(String(output)); } catch { throw new Error("Railway linked-project status was not valid JSON"); }
  const staging = status?.environments?.edges?.find((edge) => edge?.node?.name === "staging")?.node;
  const api = status?.services?.edges?.find((edge) => edge?.node?.name === "api")?.node;
  if (status?.id !== RAILWAY_IDENTITY.projectId
      || staging?.id !== RAILWAY_IDENTITY.environmentId
      || api?.id !== RAILWAY_IDENTITY.serviceId) {
    throw new Error("Railway project directory is not linked to the reviewed Parkdex staging API identity");
  }
  return { ...RAILWAY_IDENTITY };
}

export function manualCleanupFailure(error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.message = `${failure.message} Automatic QA cleanup failed; manual staging cleanup is required.`;
  failure.manualCleanupRequired = true;
  return failure;
}

export function parseArgs(argv) {
  const value = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const serial = assertEmulatorSerial(value("--serial"));
  const trials = Number(value("--trials", "10"));
  const timeoutMs = Number(value("--timeout-ms", String(DEFAULT_TIMEOUT_MS)));
  const photoTimeoutMs = Number(value("--photo-timeout-ms", String(DEFAULT_PHOTO_TIMEOUT_MS)));
  const qaAccountEmail = process.env.PARKDEX_QA_ACCOUNT_EMAIL?.trim() || "";
  const railwayProjectDir = value("--railway-project-dir", process.env.PARKDEX_RAILWAY_PROJECT_DIR?.trim() || "");
  const skipPhotoJourney = argv.includes("--skip-photo-journey");
  const skipR2Contract = argv.includes("--skip-r2-contract");
  if (!Number.isInteger(trials) || trials < 1 || trials > 100) throw new Error("--trials must be an integer from 1 to 100");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("--timeout-ms must be between 1000 and 60000");
  if (!Number.isInteger(photoTimeoutMs) || photoTimeoutMs < 10_000 || photoTimeoutMs > 120_000) throw new Error("--photo-timeout-ms must be between 10000 and 120000");
  if (!qaAccountEmail && !skipPhotoJourney) {
    throw new Error("PARKDEX_QA_ACCOUNT_EMAIL is required for the Camera, claim, upload, readback, and cleanup journey. Use --skip-photo-journey only for location-gate development; that attestation is not field-ready.");
  }
  if (!railwayProjectDir && !skipR2Contract) {
    throw new Error("--railway-project-dir or PARKDEX_RAILWAY_PROJECT_DIR is required for the staging R2 contract. Use --skip-r2-contract only for gate development; that attestation is not field-ready.");
  }
  return {
    serial,
    trials,
    timeoutMs,
    photoTimeoutMs,
    qaAccountEmail,
    skipPhotoJourney,
    skipR2Contract,
    railwayProjectDir,
    adb: value("--adb", process.env.ADB || "adb"),
    output: value("--output"),
    allowDirty: argv.includes("--allow-dirty"),
  };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function run(command, args, { cwd, env, encoding = "utf8", allowFailure = false, timeoutMs = 120_000 } = {}) {
  const windowsBatch = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  const executable = windowsBatch ? "cmd.exe" : command;
  const childArgs = windowsBatch ? ["/d", "/c", command, ...args] : args;
  const result = spawnSync(executable, childArgs, {
    cwd,
    env: { ...process.env, ...env },
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = sanitizeText(result.stderr || result.stdout || result.error?.message || "unknown error");
    throw new Error(`${command} ${args.join(" ")} failed: ${detail.slice(-2000)}`);
  }
  return result;
}

function git(root, args) {
  return run("git", args, { cwd: root }).stdout.trim();
}

function currentRemoteStagingSha(root) {
  const output = run("git", ["ls-remote", "--exit-code", "origin", "refs/heads/staging"], {
    cwd: root,
    timeoutMs: 30_000,
  }).stdout.trim();
  const match = /^([0-9a-f]{40})\s+refs\/heads\/staging$/m.exec(output);
  if (!match) throw new Error("Could not resolve the current remote staging revision");
  return match[1];
}

export function resolveStagingBaseSha(root, fieldReadyProfile, resolveRemoteSha = currentRemoteStagingSha) {
  if (!fieldReadyProfile) return null;
  const stagingBaseSha = resolveRemoteSha(root);
  if (!/^[0-9a-f]{40}$/.test(stagingBaseSha)) {
    throw new Error("Could not resolve the current remote staging revision");
  }
  return stagingBaseSha;
}

function assertCurrentStagingIntegrated(root, expectedSha) {
  const remoteSha = currentRemoteStagingSha(root);
  if (remoteSha !== expectedSha) {
    throw new Error("Remote staging advanced during the field gate; integrate it and rerun the exact-APK gate");
  }
  run("git", ["merge-base", "--is-ancestor", remoteSha, "HEAD"], { cwd: root });
}

function repositoryCheckpoint(root, phase, apkPath) {
  return {
    phase,
    commitSha: git(root, ["rev-parse", "HEAD"]),
    treeSha: git(root, ["rev-parse", "HEAD^{tree}"]),
    clean: !git(root, ["status", "--porcelain"]),
    ...(apkPath ? { apkSha: sha256(apkPath) } : {}),
  };
}

function assertExactCheckpoint(checkpoint, expected, expectedApkSha) {
  if (!checkpoint.clean || checkpoint.commitSha !== expected.commitSha || checkpoint.treeSha !== expected.treeSha) {
    throw new Error(`Repository identity changed during ${checkpoint.phase}; refusing field-ready attestation`);
  }
  if (expectedApkSha && checkpoint.apkSha !== expectedApkSha) {
    throw new Error(`APK bytes changed during ${checkpoint.phase}; refusing field-ready attestation`);
  }
}

function runR2Contract(root, railwayProjectDir) {
  const command = railwayContractCommand(root, railwayProjectDir);
  // `railway run` alone reports "No linked project found" only after doing
  // other setup. Validate linkage explicitly from the requested checkout.
  const status = run(command.executable, command.statusArgs, { cwd: command.cwd, timeoutMs: 30_000 });
  const railwayIdentity = validateRailwayStatus(status.stdout);
  const result = run(command.executable, command.contractArgs, {
    cwd: command.cwd,
    timeoutMs: 2 * 60_000,
  });
  return { ...parseR2ContractOutput(result.stdout), linkedProjectValidated: true, railwayIdentity };
}

function adb(context, args, options = {}) {
  return run(context.adb, ["-s", context.serial, ...args], { timeoutMs: 30_000, ...options });
}

function dumpHierarchy(context) {
  adb(context, ["shell", "uiautomator", "dump", "/sdcard/parkdex-window.xml"], { timeoutMs: 10_000 });
  const xml = adb(context, ["shell", "cat", "/sdcard/parkdex-window.xml"]).stdout;
  adb(context, ["shell", "rm", "/sdcard/parkdex-window.xml"], { allowFailure: true });
  return xml;
}

function waitFor(context, predicate, deadline, label, { retryAction, retryIntervalMs = 2_000 } = {}) {
  let lastXml = "";
  let lastRetryAt = Date.now();
  while (Date.now() < deadline) {
    let retry = false;
    try {
      lastXml = dumpHierarchy(context);
      const onboardingSkip = onboardingSkipCenter(lastXml);
      if (onboardingSkip) {
        adb(context, ["shell", "input", "tap", String(onboardingSkip.x), String(onboardingSkip.y)]);
        lastRetryAt = Date.now();
        sleep(300);
        continue;
      }
      const decision = evaluateDumpedPoll({
        deadlineMs: deadline,
        lastRetryAt,
        retryIntervalMs,
        retryEnabled: Boolean(retryAction),
      }, predicate, lastXml);
      if (decision.expired) break;
      if (decision.matched) return { value: decision.value, xml: lastXml };
      retry = decision.retry;
    } catch {
      // The hierarchy can be unavailable briefly while the Activity starts.
      const now = Date.now();
      if (now >= deadline) break;
      retry = Boolean(retryAction) && retryActionDue(now, lastRetryAt, retryIntervalMs);
    }
    // The dump and predicate can both consume meaningful time. Never replay a
    // provider event after the fixed trial deadline.
    if (Date.now() >= deadline) break;
    if (retryAction && retry) {
      retryAction();
      lastRetryAt = Date.now();
    }
    sleep(300);
  }
  const error = new Error(`Timed out waiting for ${label}`);
  error.lastXml = lastXml;
  throw error;
}

function waitForWithScroll(context, predicate, deadline, label) {
  let lastXml = "";
  while (Date.now() < deadline) {
    try {
      lastXml = dumpHierarchy(context);
      const onboardingSkip = onboardingSkipCenter(lastXml);
      if (onboardingSkip) {
        adb(context, ["shell", "input", "tap", String(onboardingSkip.x), String(onboardingSkip.y)]);
        sleep(300);
        continue;
      }
      const result = predicate(lastXml);
      if (result) return { value: result, xml: lastXml };
      // The postcard deliberately consumes drag gestures for its tilt effect,
      // so Page Down is the primary scroll action. A following swipe covers
      // the empty-postcard layout, where the WebView may not yet hold keyboard
      // focus and therefore ignores Page Down.
      adb(context, ["shell", "input", "keyevent", "KEYCODE_PAGE_DOWN"]);
      adb(context, ["shell", "input", "swipe", "540", "1900", "540", "650", "350"]);
    } catch {
      // The hierarchy can be unavailable briefly during WebView navigation.
    }
    sleep(500);
  }
  const error = new Error(`Timed out waiting for ${label}`);
  error.lastXml = lastXml;
  throw error;
}

function captureFailure(context, evidenceDirectory, name, fallbackXml = "", { includeScreenshot = true } = {}) {
  mkdirSync(evidenceDirectory, { recursive: true });
  let xml = fallbackXml;
  if (!xml) {
    try { xml = dumpHierarchy(context); } catch { /* keep the available fallback */ }
  }
  writeFileSync(join(evidenceDirectory, `${name}.xml`), sanitizeText(xml), "utf8");
  const logs = adb(context, ["logcat", "-d", "-v", "threadtime"], { allowFailure: true }).stdout;
  writeFileSync(join(evidenceDirectory, `${name}.logcat.txt`), sanitizeText(logs), "utf8");
  // Authenticated screenshots can expose account data that cannot be safely
  // redacted as text. Capture them only after the gate has cleared app data.
  if (includeScreenshot) {
    const screenshot = adb(context, ["exec-out", "screencap", "-p"], { encoding: null, allowFailure: true });
    if (screenshot.status === 0 && screenshot.stdout?.length) writeFileSync(join(evidenceDirectory, `${name}.png`), screenshot.stdout);
  }
}

function grantLocation(context) {
  for (const permission of ["android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"]) {
    adb(context, ["shell", "pm", "grant", PACKAGE, permission]);
  }
}

function spoof(context, point) {
  adb(context, ["emu", "geo", "fix", String(point.longitude), String(point.latitude)]);
}

function tapLabel(context, labels, deadline, description) {
  const found = waitFor(context, (xml) => labelledNodeCenter(xml, labels), deadline, description);
  adb(context, ["shell", "input", "tap", String(found.value.x), String(found.value.y)]);
  return found.xml;
}


function tapLabelWithScroll(context, labels, deadline, description) {
  const found = waitForWithScroll(context, (xml) => labelledNodeCenter(xml, labels), deadline, description);
  adb(context, ["shell", "input", "tap", String(found.value.x), String(found.value.y)]);
  return found.xml;
}

function primaryContentVisible(xml, labels) {
  const matchers = labels.map((label) => label instanceof RegExp ? label : new RegExp(`^${String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
  for (const match of String(xml).matchAll(/<node\b[^>]*>/g)) {
    const node = match[0];
    if (!/resource-id="primary-content"/.test(node)) continue;
    const nodeLabels = [...node.matchAll(/(?:text|content-desc)="([^"]*)"/g)].map((candidate) => candidate[1]);
    if (nodeLabels.some((nodeLabel) => matchers.some((matcher) => matcher.test(nodeLabel)))) return true;
  }
  return false;
}

function accountViewVisible(xml) {
  // Account became My Dex in the bottom navigation. Keep Account as a
  // backwards-compatible label for older field APKs while recognizing the
  // modern primary-content aria-label regardless of XML attribute order.
  return primaryContentVisible(xml, MY_DEX_LABELS);
}

function settingsViewVisible(xml) {
  const text = String(xml);
  return /(?:text|content-desc)="Back to My Dex"/i.test(text)
    || /(?:text|content-desc)="Sign out"/i.test(text);
}

function navigateToAccountSettings(context, deadline, description) {
  const accountXml = navigateToAccountHandlingOverlays(context, deadline, description);
  if (settingsViewVisible(accountXml)) return accountXml;
  const settings = labelledNodeCenter(accountXml, SETTINGS_LABELS);
  // Older APKs kept account controls on the account page. Preserve that
  // compatibility while requiring the modern Settings tap when it exists.
  if (!settings) return accountXml;
  adb(context, ["shell", "input", "tap", String(settings.x), String(settings.y)]);
  return waitFor(context, settingsViewVisible, deadline, `${description} Settings view`).xml;
}

function leaveAccountSettingsIfOpen(context, deadline, description) {
  let current = "";
  try {
    current = dumpHierarchy(context);
    const backToMyDex = labelledNodeCenter(current, [/^Back to My Dex$/i]);
    if (!backToMyDex) return current;
    adb(context, ["shell", "input", "tap", String(backToMyDex.x), String(backToMyDex.y)]);
    return waitFor(context, (xml) => accountViewVisible(xml) && !settingsViewVisible(xml), deadline, `${description} My Dex view`).xml;
  } catch (error) {
    error.lastXml = error.lastXml || current;
    throw error;
  }
}

export function accountNavigationTarget(xml) {
  for (const [kind, labels] of [
    ["dismiss-onboarding", ONBOARDING_SKIP_LABELS],
    ["dismiss-arrival", [/^Close sealed impression$/i]],
    ["dismiss-nearby", [/^Close nearby places$/i]],
    ["dismiss-badge", [/^Claim my badge$/i]],
  ]) {
    const center = labelledNodeCenter(xml, labels);
    if (center) return { kind, center };
  }
  if (accountViewVisible(xml)) return { kind: "ready" };
  const center = labelledNodeCenter(xml, MY_DEX_LABELS);
  return center ? { kind: "navigate", center } : null;
}

export function sealedClaimCenter(xml) {
  if (!labelledNodeCenter(xml, [/^Close sealed impression$/i])) return null;
  return labelledNodeCenter(xml, [/^(?:Claim \+ photo|Log visit \+ photo)$/i]);
}

export function openSealedArrivalCamera(context, {
  wait = waitFor,
  tap = (center) => adb(context, ["shell", "input", "tap", String(center.x), String(center.y)]),
  injectLocation = () => spoof(context, BELL),
  now = Date.now,
} = {}) {
  const sealedClaim = wait(context, sealedClaimCenter, now() + context.photoTimeoutMs, "Bell Park sealed Claim + photo action", {
    retryAction: injectLocation,
  });
  tap(sealedClaim.value);
  return sealedClaim.xml;
}

function waitForAccountPostcard(context, deadline) {
  let lastXml = "";
  let collectionRequested = false;
  let postcardRequested = false;
  while (Date.now() < deadline) {
    try {
      lastXml = dumpHierarchy(context);
      const onboardingSkip = onboardingSkipCenter(lastXml);
      if (onboardingSkip) {
        adb(context, ["shell", "input", "tap", String(onboardingSkip.x), String(onboardingSkip.y)]);
        sleep(300);
        continue;
      }
      const seeCollection = !collectionRequested && labelledNodeCenter(lastXml, [/^See my collection$/i]);
      if (seeCollection) {
        adb(context, ["shell", "input", "tap", String(seeCollection.x), String(seeCollection.y)]);
        collectionRequested = true;
        sleep(500);
        continue;
      }
      // The current success receipt can be dismissed into the map. If the
      // success flow has already returned there, use its explicit postcard
      // action before checking the My Dex collection.
      if (!collectionRequested) {
        const openPostcard = labelledNodeCenter(lastXml, [/^Open your postcard$/i, /^Open your Bell Park postcard$/i]);
        if (openPostcard) {
          adb(context, ["shell", "input", "tap", String(openPostcard.x), String(openPostcard.y)]);
          collectionRequested = true;
          sleep(500);
          continue;
        }
      }
      const backToMap = !collectionRequested && labelledNodeCenter(lastXml, [/^Back to map$/i]);
      if (backToMap) {
        adb(context, ["shell", "input", "tap", String(backToMap.x), String(backToMap.y)]);
        sleep(500);
        continue;
      }
      const badge = labelledNodeCenter(lastXml, [/^Claim my badge$/i]);
      if (badge) {
        adb(context, ["shell", "input", "tap", String(badge.x), String(badge.y)]);
        sleep(500);
        continue;
      }
      if (collectionRequested && !postcardRequested && (accountViewVisible(lastXml) || /(?:text|content-desc)="My Dex"/i.test(lastXml))) {
        const viewPostcard = labelledNodeCenter(lastXml, [/^View Bell Park postcard$/i]);
        if (viewPostcard) {
          adb(context, ["shell", "input", "tap", String(viewPostcard.x), String(viewPostcard.y)]);
          postcardRequested = true;
          sleep(500);
          continue;
        }
      }
      if (postcardRequested && photoPostcardReady(lastXml)) {
        const closePostcard = labelledNodeCenter(lastXml, [/^Close postcard$/i]);
        if (closePostcard) {
          adb(context, ["shell", "input", "tap", String(closePostcard.x), String(closePostcard.y)]);
          sleep(500);
          return { xml: lastXml };
        }
      }
      if (collectionRequested && !postcardRequested && !/class="android\.app\.Dialog"/.test(lastXml)) {
        adb(context, ["shell", "input", "swipe", "540", "1900", "540", "650", "350"]);
      }
    } catch {
      // WebView and native celebration transitions can briefly hide the tree.
    }
    sleep(500);
  }
  const error = new Error("Timed out waiting for uploaded Bell Park postcard readback");
  error.lastXml = lastXml;
  throw error;
}

function navigateToAccountHandlingOverlays(context, deadline, description) {
  let lastXml = "";
  while (Date.now() < deadline) {
    try {
      lastXml = dumpHierarchy(context);
      const target = accountNavigationTarget(lastXml);
      if (target?.kind === "ready") return lastXml;
      // The arrival, nearby, and badge dialogs can cover bottom navigation
      // even while UIAutomator reports its Account button as clickable.
      if (target?.center) adb(context, ["shell", "input", "tap", String(target.center.x), String(target.center.y)]);
    } catch {
      // Retry during native/WebView transitions.
    }
    sleep(500);
  }
  const error = new Error(`Timed out waiting for ${description}`);
  error.lastXml = lastXml;
  throw error;
}

function setLocationEnabled(context, enabled) {
  adb(context, ["shell", "cmd", "location", "set-location-enabled", enabled ? "true" : "false"]);
}

function setAirplaneMode(context, enabled) {
  adb(context, ["shell", "cmd", "connectivity", "airplane-mode", enabled ? "enable" : "disable"]);
  const actual = parseAirplaneMode(adb(context, ["shell", "cmd", "connectivity", "airplane-mode"]).stdout);
  if (actual !== enabled) throw new Error(`Emulator airplane mode did not ${enabled ? "enable" : "disable"}`);
}

function appPid(context) {
  return parseAppPid(adb(context, ["shell", "pidof", PACKAGE]).stdout);
}

function runNetworkStartupRecovery(context) {
  adb(context, ["shell", "am", "force-stop", PACKAGE], { allowFailure: true });
  adb(context, ["shell", "pm", "clear", PACKAGE]);
  grantLocation(context);
  setLocationEnabled(context, true);
  let lastXml = "";
  let launchPid = "";
  try {
    // Airplane mode is an emulator-wide, observable connectivity transition.
    // Unlike Wi-Fi/data toggles, it also cuts the emulator's virtual Ethernet
    // path while leaving ADB available for the recovery oracle.
    setAirplaneMode(context, true);
    const offlineStartedAt = Date.now();
    adb(context, ["shell", "am", "start", "-W", "-S", "-n", ACTIVITY], { timeoutMs: context.timeoutMs });
    launchPid = appPid(context);
    const unavailable = waitFor(context, (xml) => {
      lastXml = xml;
      return offlineCatalogueOracle(xml);
    }, offlineStartedAt + NETWORK_OFFLINE_FAILURE_TIMEOUT_MS, "fresh-install catalogue failure while offline");
    lastXml = unavailable.xml;
    if (unavailable.value === "unexpected-ready") {
      throw new Error("Fresh Parkdex data loaded while emulator networking was disabled");
    }
    const offlineHoldMs = Date.now() - offlineStartedAt;

    const restoredAt = Date.now();
    setAirplaneMode(context, false);
    spoof(context, BELL);
    const locate = waitFor(context, (xml) => locateButtonCenter(xml), restoredAt + NETWORK_RECOVERY_TIMEOUT_MS, "Locate Me button after network restore");
    adb(context, ["shell", "input", "tap", String(locate.value.x), String(locate.value.y)]);
    spoof(context, BELL);
    const recovered = waitFor(context, (xml) => {
      lastXml = xml;
      return bellParkReady(xml);
    }, restoredAt + NETWORK_RECOVERY_TIMEOUT_MS, "automatic catalogue recovery after network restore", {
      retryAction: () => spoof(context, BELL),
    });
    const recoveredPid = appPid(context);
    if (recoveredPid !== launchPid) throw new Error("Parkdex restarted instead of recovering its first-launch catalogue in place");
    return {
      initialCatalogueUnavailableObserved: true,
      offlineOracle: "fresh-install-field-guide-error",
      offlineHoldMs,
      recoveredWithoutRestart: true,
      activityPidStable: true,
      networkRestored: true,
      elapsedAfterRestoreMs: Date.now() - restoredAt,
      distances: distanceLabels(recovered.xml),
      xml: recovered.xml,
    };
  } catch (error) {
    error.lastXml = error.lastXml || lastXml;
    throw error;
  } finally {
    // Never leave the shared emulator disconnected, even when a UI oracle or
    // process-stability assertion fails partway through this checkpoint.
    setAirplaneMode(context, false);
  }
}

function runColdStartTrial(context, index) {
  adb(context, ["shell", "pm", "clear", PACKAGE]);
  grantLocation(context);
  spoof(context, BELL);
  adb(context, ["logcat", "-c"], { allowFailure: true });
  const started = Date.now();
  adb(context, ["shell", "am", "start", "-W", "-S", "-n", ACTIVITY], { timeoutMs: context.timeoutMs });
  const deadline = started + context.timeoutMs;
  const locate = waitFor(context, (xml) => locateButtonCenter(xml), deadline, "Locate Me button");
  adb(context, ["shell", "input", "tap", String(locate.value.x), String(locate.value.y)]);
  // Emulator geo fixes are edge-triggered. Inject after the foreground watch
  // exists instead of assuming a pre-launch fix will be replayed.
  spoof(context, BELL);
  const ready = waitFor(context, bellParkReady, deadline, "Bell Park nearby result", {
    retryAction: () => spoof(context, BELL),
  });
  const elapsedMs = Date.now() - started;
  if (elapsedMs > context.timeoutMs) throw new Error(`Trial ${index} exceeded ${context.timeoutMs}ms`);
  return {
    trial: index,
    elapsedMs,
    oracle: pinOracle(ready.xml),
    distances: distanceLabels(ready.xml),
    xml: ready.xml,
  };
}

function runMotionCheck(context, baselineXml) {
  const before = distanceLabels(baselineXml);
  spoof(context, MOTION);
  const started = Date.now();
  const moved = waitFor(context, (xml) => {
    if (!bellParkReady(xml)) return false;
    const after = distanceLabels(xml);
    return after.length > 0 && JSON.stringify(after) !== JSON.stringify(before) ? after : false;
  }, started + context.timeoutMs, "motion-driven nearby distance update", {
    retryAction: () => spoof(context, MOTION),
  });
  return { elapsedMs: Date.now() - started, before, after: moved.value };
}

function runProviderRecovery(context) {
  adb(context, ["shell", "pm", "clear", PACKAGE]);
  grantLocation(context);
  setLocationEnabled(context, false);
  let lastXml = "";
  try {
    adb(context, ["shell", "am", "start", "-W", "-S", "-n", ACTIVITY]);
    const locate = waitFor(context, (xml) => locateButtonCenter(xml), Date.now() + context.timeoutMs, "Locate Me button with provider disabled");
    adb(context, ["shell", "input", "tap", String(locate.value.x), String(locate.value.y)]);
    const unavailable = waitFor(context, (xml) => {
      lastXml = xml;
      return locationUnavailable(xml);
    }, Date.now() + Math.min(8_000, context.timeoutMs), "bounded provider-unavailable state");
    lastXml = unavailable.xml;
    const restoredAt = Date.now();
    setLocationEnabled(context, true);
    spoof(context, BELL);
    const recovered = waitFor(context, (xml) => {
      lastXml = xml;
      return bellParkReady(xml);
    }, restoredAt + context.timeoutMs, "automatic provider recovery", {
      retryAction: () => spoof(context, BELL),
    });
    return {
      unavailableObserved: true,
      recoveredWithoutRestart: true,
      elapsedAfterRestoreMs: Date.now() - restoredAt,
      distances: distanceLabels(recovered.xml),
      xml: recovered.xml,
    };
  } catch (error) {
    error.lastXml = error.lastXml || lastXml;
    throw error;
  } finally {
    setLocationEnabled(context, true);
  }
}

function runPhotoJourney(context, apk) {
  if (!context.qaAccountEmail) return null;
  adb(context, ["install", "-r", "-t", apk]);
  grantLocation(context);
  setLocationEnabled(context, true);
  spoof(context, BELL);
  adb(context, ["shell", "am", "force-stop", PACKAGE]);
  adb(context, ["shell", "am", "start", "-W", "-n", ACTIVITY]);

  let verifiedQaAccount = false;
  let cleaned = false;
  let result = null;
  let primaryFailure = null;
  try {
    navigateToAccountSettings(context, Date.now() + context.photoTimeoutMs, "My Dex navigation");
    waitFor(context, (xml) => String(xml).includes(context.qaAccountEmail) && /Sign out/i.test(xml), Date.now() + context.photoTimeoutMs, "expected signed-in QA account");
    verifiedQaAccount = true;
    tapLabel(context, [/^Field Guide$/i], Date.now() + context.timeoutMs, "Field Guide navigation");
    tapLabel(context, [/^Map$/i], Date.now() + context.timeoutMs, "Map navigation");
    // Closing the first arrival to verify Account suppresses that park's
    // invitation until departure in this app session. Relaunch with the
    // verified session intact so Camera exercises a fresh sealed arrival.
    adb(context, ["shell", "am", "force-stop", PACKAGE]);
    adb(context, ["shell", "am", "start", "-W", "-n", ACTIVITY]);
    spoof(context, BELL);
    // Authenticated Android starts its location watch automatically. Wait for
    // the actual arrival before tapping: Locate can occupy the same screen
    // coordinates as Claim + photo while the sheet mounts.
    const claimXml = openSealedArrivalCamera(context);

    const shutterXml = tapLabel(context, [/Shutter/i, /Take photo/i], Date.now() + context.photoTimeoutMs, "camera shutter");
    tapLabel(context, [/^Done$/i, /^Use photo$/i], Date.now() + context.photoTimeoutMs, "native camera acceptance");
    const review = waitFor(context, photoReviewSaveCenter, Date.now() + context.photoTimeoutMs, "Parkdex photo review");
    adb(context, ["shell", "input", "tap", String(review.value.x), String(review.value.y)]);

    const ready = waitForAccountPostcard(context, Date.now() + context.photoTimeoutMs);

    // The first-visit badge can mount again after the postcard readback has
    // already passed. Clear that modal at the cleanup boundary so it cannot
    // absorb the following Account scroll/tap sequence.
    navigateToAccountSettings(context, Date.now() + context.photoTimeoutMs, "postcard cleanup My Dex navigation");
    tapLabelWithScroll(context, [/^Reset my progress$/i], Date.now() + context.photoTimeoutMs, "progress reset action");
    tapLabel(context, [/^Reset everything$/i], Date.now() + context.timeoutMs, "progress reset confirmation");
    leaveAccountSettingsIfOpen(context, Date.now() + context.timeoutMs, "progress reset");
    const cleanupResult = waitFor(context, photoJourneyCleanupReady, Date.now() + context.photoTimeoutMs, "photo journey cleanup");
    cleaned = true;
    result = {
      completed: true,
      readback: true,
      cleanup: true,
      cameraOracle: /Shutter|Take photo/i.test(shutterXml),
      claimOracle: /(?:Claim \+ photo|Log visit \+ photo)/i.test(claimXml),
      reviewOracle: photoReviewReady(review.xml),
      postcardOracle: photoPostcardReady(ready.xml),
      cleanupOracle: photoJourneyCleanupReady(cleanupResult.xml),
    };
  } catch (error) {
    primaryFailure = error;
  } finally {
    // A failed gate must not leave disposable QA claims or R2 objects behind.
    // Reset only after the signed-in identity has matched the expected account.
    if (verifiedQaAccount && !cleaned) {
      try {
        adb(context, ["shell", "am", "force-stop", PACKAGE]);
        adb(context, ["shell", "am", "start", "-W", "-n", ACTIVITY]);
        navigateToAccountSettings(context, Date.now() + context.photoTimeoutMs, "cleanup My Dex navigation");
        tapLabelWithScroll(context, [/^Reset my progress$/i], Date.now() + context.photoTimeoutMs, "cleanup progress reset action");
        tapLabel(context, [/^Reset everything$/i], Date.now() + context.timeoutMs, "cleanup progress reset confirmation");
        leaveAccountSettingsIfOpen(context, Date.now() + context.timeoutMs, "cleanup progress reset");
        waitFor(context, photoJourneyCleanupReady, Date.now() + context.photoTimeoutMs, "failed photo journey cleanup");
      } catch (cleanupError) {
        primaryFailure = manualCleanupFailure(primaryFailure ?? cleanupError);
      }
    }
  }
  if (primaryFailure) throw primaryFailure;
  return result;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const scriptPath = fileURLToPath(import.meta.url);
  const root = run("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(scriptPath) }).stdout.trim();
  const output = resolve(options.output || join(tmpdir(), `parkdex-android-field-${Date.now()}.json`));
  const outputRelative = relative(root, output);
  if (!outputRelative.startsWith("..") && outputRelative !== "") throw new Error("--output must be outside the repository");
  const evidenceDirectory = `${output}.evidence`;
  const context = { ...options, root };
  const worktreeStatus = git(root, ["status", "--porcelain"]);
  if (worktreeStatus && !options.allowDirty) {
    throw new Error("Working tree must be clean for an exact APK attestation. Use --allow-dirty only for local gate development.");
  }
  const commitSha = git(root, ["rev-parse", "HEAD"]);
  const treeSha = git(root, ["rev-parse", "HEAD^{tree}"]);
  const fieldReadyProfile = isFieldReadyProfile(options, !worktreeStatus);
  // Development gates are intentionally runnable with an offline checkout.
  // Only the exact full-field profile binds the APK to the current remote
  // staging revision and rechecks that revision at the install/final edges.
  const stagingBaseSha = resolveStagingBaseSha(root, fieldReadyProfile);
  if (fieldReadyProfile) assertCurrentStagingIntegrated(root, stagingBaseSha);
  const initialCheckpoint = repositoryCheckpoint(root, "start");
  const androidBuildEnvironment = stagingBuildEnvironment(process.env);
  const attestation = {
    schema: "parkdex.android-e2e/v1",
    status: "failure",
    commitSha,
    treeSha,
    stagingBaseSha,
    workingTreeClean: !worktreeStatus,
    profile: fieldReadyProfile ? "full-field-release" : "development",
    fieldReady: false,
    serial: options.serial,
    trialsRequested: options.trials,
    timeoutMs: options.timeoutMs,
    buildEnvironment: publicStagingBuildIdentity(androidBuildEnvironment),
    checkpoints: [initialCheckpoint],
    startedAt: new Date().toISOString(),
    trials: [],
  };
  let lastXml = "";
  try {
    const devices = parseAdbDevices(run(options.adb, ["devices", "-l"]).stdout);
    const selected = devices.find((device) => device.serial === options.serial);
    if (!selected || selected.state !== "device") throw new Error(`Emulator ${options.serial} is not connected and ready`);
    if (adb(context, ["shell", "getprop", "ro.kernel.qemu"]).stdout.trim() !== "1") {
      throw new Error(`Refusing non-emulator target ${options.serial}`);
    }

    const frontend = join(root, "frontend");
    run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "android:sync"], {
      cwd: frontend,
      env: androidBuildEnvironment,
      timeoutMs: 10 * 60_000,
    });
    const afterSync = repositoryCheckpoint(root, "after-sync");
    attestation.checkpoints.push(afterSync);
    if (fieldReadyProfile) assertExactCheckpoint(afterSync, attestation);
    const gradle = process.platform === "win32" ? join(frontend, "android", "gradlew.bat") : join(frontend, "android", "gradlew");
    run(gradle, ["-p", "android", "--no-daemon", ":app:assembleDebug"], {
      cwd: frontend,
      env: { ANDROID_SERIAL: options.serial },
      timeoutMs: 10 * 60_000,
    });
    const apk = join(frontend, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
    if (!existsSync(apk)) throw new Error(`Expected APK was not produced at ${apk}`);
    const artifactApk = `${output}.apk`;
    copyFileSync(apk, artifactApk);
    attestation.apkSha256 = sha256(artifactApk);
    attestation.apkPath = artifactApk;
    const afterAssemble = repositoryCheckpoint(root, "after-assemble", apk);
    attestation.checkpoints.push(afterAssemble);
    if (fieldReadyProfile) assertExactCheckpoint(afterAssemble, attestation, attestation.apkSha256);

    if (!options.skipR2Contract) {
      try {
        attestation.r2Contract = runR2Contract(root, options.railwayProjectDir);
      } catch (error) {
        attestation.manualCleanupRequired = true;
        throw manualCleanupFailure(error);
      }
    }

    if (!options.skipPhotoJourney) {
      try {
        attestation.photoJourney = runPhotoJourney(context, artifactApk);
      } catch (error) {
        if (error?.manualCleanupRequired) attestation.manualCleanupRequired = true;
        captureFailure(context, evidenceDirectory, "photo-journey", error.lastXml || "", { includeScreenshot: false });
        throw error;
      }
    }

    // Connected tests can reinstall or clear the app. Run them only after the
    // session-preserving authenticated photo journey has completed and cleaned up.
    run(gradle, ["-p", "android", "--no-daemon", ":app:connectedDebugAndroidTest"], {
      cwd: frontend,
      env: { ANDROID_SERIAL: options.serial },
      timeoutMs: 10 * 60_000,
    });

    const afterConnectedTests = repositoryCheckpoint(root, "after-connected-tests", apk);
    attestation.checkpoints.push(afterConnectedTests);
    if (fieldReadyProfile) assertExactCheckpoint(afterConnectedTests, attestation, attestation.apkSha256);

    // Re-hash both the build output and immutable external candidate at the
    // final install boundary. The emulator receives the external candidate,
    // never an APK that a later Gradle task could have overwritten.
    const assembledApkSha = attestation.apkSha256;
    const beforeInstall = repositoryCheckpoint(root, "before-install", artifactApk);
    attestation.checkpoints.push(beforeInstall);
    if (fieldReadyProfile) {
      assertExactCheckpoint(beforeInstall, attestation, assembledApkSha);
      assertCurrentStagingIntegrated(root, stagingBaseSha);
      if (sha256(apk) !== assembledApkSha) throw new Error("Build APK no longer matches the field candidate before install");
    }
    // This is the authoritative field APK digest: calculated at the install
    // boundary, after every generator and connected Android test completed.
    attestation.apkSha256 = beforeInstall.apkSha;

    adb(context, ["uninstall", PACKAGE], { allowFailure: true });
    adb(context, ["install", "-t", artifactApk]);
    adb(context, ["shell", "pm", "clear", PACKAGE]);

    try {
      const recovery = runNetworkStartupRecovery(context);
      lastXml = recovery.xml;
      attestation.networkStartupRecovery = {
        initialCatalogueUnavailableObserved: recovery.initialCatalogueUnavailableObserved,
        offlineOracle: recovery.offlineOracle,
        offlineHoldMs: recovery.offlineHoldMs,
        recoveredWithoutRestart: recovery.recoveredWithoutRestart,
        activityPidStable: recovery.activityPidStable,
        networkRestored: recovery.networkRestored,
        elapsedAfterRestoreMs: recovery.elapsedAfterRestoreMs,
        distances: recovery.distances,
      };
    } catch (error) {
      captureFailure(context, evidenceDirectory, "network-startup-recovery", error.lastXml || lastXml);
      throw error;
    }

    for (let trial = 1; trial <= options.trials; trial += 1) {
      try {
        const result = runColdStartTrial(context, trial);
        lastXml = result.xml;
        attestation.trials.push({ trial, elapsedMs: result.elapsedMs, oracle: result.oracle, distances: result.distances });
      } catch (error) {
        captureFailure(context, evidenceDirectory, `cold-start-${trial}`, error.lastXml || lastXml);
        throw error;
      }
    }
    attestation.summary = summarizeDurations(attestation.trials.map((trial) => trial.elapsedMs));
    if (attestation.summary.maxMs > options.timeoutMs) throw new Error(`Cold-start maximum exceeded ${options.timeoutMs}ms`);
    try {
      attestation.motion = runMotionCheck(context, lastXml);
    } catch (error) {
      captureFailure(context, evidenceDirectory, "motion", error.lastXml || lastXml);
      throw error;
    }
    try {
      const recovery = runProviderRecovery(context);
      lastXml = recovery.xml;
      attestation.providerRecovery = {
        unavailableObserved: recovery.unavailableObserved,
        recoveredWithoutRestart: recovery.recoveredWithoutRestart,
        elapsedAfterRestoreMs: recovery.elapsedAfterRestoreMs,
        distances: recovery.distances,
      };
    } catch (error) {
      captureFailure(context, evidenceDirectory, "provider-recovery", error.lastXml || lastXml);
      throw error;
    }
    const finalCheckpoint = repositoryCheckpoint(root, "final", artifactApk);
    attestation.checkpoints.push(finalCheckpoint);
    if (fieldReadyProfile) {
      assertExactCheckpoint(finalCheckpoint, attestation, attestation.apkSha256);
      assertCurrentStagingIntegrated(root, stagingBaseSha);
    }
    attestation.status = "success";
    attestation.fieldReady = fieldReadyFromCheckpoints({
      profileReady: fieldReadyProfile,
      commitSha,
      treeSha,
      stagingBaseSha,
      apkSha: attestation.apkSha256,
      checkpoints: attestation.checkpoints,
      r2Contract: attestation.r2Contract,
      buildEnvironment: attestation.buildEnvironment,
      networkStartupRecovery: attestation.networkStartupRecovery,
    });
    if (fieldReadyProfile && !attestation.fieldReady) throw new Error("Final repository, APK, or R2 evidence did not satisfy field-ready requirements");
  } catch (error) {
    attestation.status = "failure";
    attestation.fieldReady = false;
    attestation.failure = sanitizeText(error instanceof Error ? error.message : String(error));
    if (!existsSync(evidenceDirectory)) {
      // Setup can fail before the gate clears a previously signed-in app.
      captureFailure(context, evidenceDirectory, "setup", lastXml, { includeScreenshot: false });
    }
  } finally {
    attestation.endedAt = new Date().toISOString();
    attestation.evidenceDirectory = existsSync(evidenceDirectory) ? evidenceDirectory : undefined;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
    process.stdout.write(`android-field-gate status=${attestation.status} fieldReady=${attestation.fieldReady} attestation=${output}\n`);
  }
  if (attestation.status !== "success") process.exitCode = 1;
  return attestation;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
