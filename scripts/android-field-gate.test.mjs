import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  accountNavigationTarget,
  assertEmulatorSerial,
  bellParkReady,
  catalogueUnavailable,
  distanceLabels,
  evaluateDumpedPoll,
  fieldReadyFromCheckpoints,
  locateButtonCenter,
  locationUnavailable,
  labelledNodeCenter,
  isFieldReadyProfile,
  manualCleanupFailure,
  networkStartupRecoveryReady,
  offlineCatalogueOracle,
  openSealedArrivalCamera,
  parseAdbDevices,
  parseAirplaneMode,
  parseAppPid,
  parseArgs,
  parseR2ContractOutput,
  photoPostcardReady,
  photoJourneyCleanupReady,
  photoReviewReady,
  railwayContractCommand,
  resolveStagingBaseSha,
  retryActionDue,
  sanitizeText,
  sealedClaimCenter,
  stagingBuildEnvironment,
  summarizeDurations,
  validateRailwayProjectDir,
  validateRailwayStatus,
} from "./android-field-gate.mjs";

test("requires an explicit emulator serial and rejects physical-looking targets", () => {
  assert.equal(assertEmulatorSerial("emulator-5554"), "emulator-5554");
  for (const value of [undefined, "", "RFCX11LBS4P", "device", "emulator-evil", "emulator-5554;adb devices"]) {
    assert.throws(() => assertEmulatorSerial(value), /explicit Android emulator serial/);
  }
});

test("parses adb inventory without selecting another attached device", () => {
  const devices = parseAdbDevices("List of devices attached\nemulator-5554 device product:sdk model:sdk_gphone\nRFCX11LBS4P device product:phone model:phone\n");
  assert.deepEqual(devices.map(({ serial, state }) => ({ serial, state })), [
    { serial: "emulator-5554", state: "device" },
    { serial: "RFCX11LBS4P", state: "device" },
  ]);
});

test("finds the Locate Me target and Bell Park ready state in UIAutomator XML", () => {
  const xml = '<hierarchy><node content-desc="Show my current location" bounds="[800,1800][1000,2000]"/><node text="Bell Park" bounds="[1,1][2,2]"/><node text="0.0 km" bounds="[1,1][2,2]"/></hierarchy>';
  assert.deepEqual(locateButtonCenter(xml), { x: 900, y: 1900 });
  assert.equal(bellParkReady(xml), true);
  assert.deepEqual(distanceLabels(xml), ["0.0 km"]);
  assert.equal(bellParkReady(xml.replace('<node text="0.0 km" bounds="[1,1][2,2]"/>', '<node text="Finding your location…" bounds="[1,1][2,2]"/>')), false);
  assert.equal(bellParkReady(`${xml}<node text="Finding your location: Location pin is ready"/>`), true);
  assert.equal(locationUnavailable('<node text="Your location is unavailable right now."/>'), true);
  assert.equal(locationUnavailable(xml), false);
  assert.equal(catalogueUnavailable('<node text="Could not load the field guide."/>'), true);
  assert.equal(catalogueUnavailable('<node content-desc="TypeError: Failed to fetch"/>'), true);
  assert.equal(catalogueUnavailable(xml), false);
  assert.equal(offlineCatalogueOracle('<node text="Could not load the field guide."/>'), "unavailable");
  assert.equal(offlineCatalogueOracle(xml), "unexpected-ready");
  assert.equal(offlineCatalogueOracle('<node text="Loading"/>'), null);
  assert.deepEqual(labelledNodeCenter('<node text="Claim + photo" bounds="[10,20][110,80]"/>', [/Claim \+ photo/]), { x: 60, y: 50 });
  assert.deepEqual(labelledNodeCenter('<node text="" content-desc="Shutter" bounds="[0,2010][1080,2340]"/>', [/Shutter/]), { x: 540, y: 2175 });
  assert.deepEqual(labelledNodeCenter('<node text="Map" clickable="false" bounds="[0,0][100,100]"/><node text="Map" clickable="true" enabled="true" bounds="[800,1800][1000,2000]"/>', [/^Map$/]), { x: 900, y: 1900 });
  const postcard = '<node content-desc="Private postcard from Bell Park" bounds="[1,1][2,2]"/><node content-desc="Private visit photo from Bell Park" bounds="[1,1][2,2]"/><node text="Remove photo" clickable="true" enabled="true" bounds="[1,1][2,2]"/>';
  assert.equal(photoPostcardReady(postcard), true);
  const collectionOnly = '<node content-desc="Postcard from Bell Park" bounds="[1,1][2,2]"/><node content-desc="Private visit photo from Bell Park" bounds="[1,1][2,2]"/>';
  assert.equal(photoPostcardReady(collectionOnly), false);
  const placeQualifiedRemove = '<node content-desc="Private postcard from Bell Park" bounds="[1,1][2,2]"/><node content-desc="Private visit photo from Bell Park" bounds="[1,1][2,2]"/><node text="Remove photo from Bell Park" bounds="[1,1][2,2]"/>';
  assert.equal(photoPostcardReady(placeQualifiedRemove), false);
  const oldAndroidWebViewPostcard = '<node text="Inspect postcard from Bell Park. Use arrow keys to tilt it."/><node text="Private visit photo from Bell Park"/><node text="Remove photo from Bell Park"/>';
  assert.equal(photoPostcardReady(oldAndroidWebViewPostcard), false);
  assert.equal(photoPostcardReady(`${postcard}<node text="Photo unavailable"/>`), false);
  const emptyCollection = '<node text="Your first boundary claim will become a postcard here."/>';
  assert.equal(photoJourneyCleanupReady(emptyCollection), true);
  assert.equal(photoJourneyCleanupReady(`${emptyCollection}<node content-desc="Postcard from Bell Park"/>`), false);
  const review = '<node text="Keep this one?" bounds="[20,300][500,360]"/><node text="Save my visit" clickable="true" enabled="true" bounds="[20,700][500,780]"/>';
  assert.equal(photoReviewReady(review), true);
  assert.equal(photoReviewReady('<node text="Keep this one?"/><node text="Save" clickable="true" bounds="[20,700][500,780]"/>'), false);
  assert.equal(photoReviewReady('<node text="Save my visit" clickable="true" bounds="[20,700][500,780]"/>'), false);
});

test("dismisses blocking dialogs before retrying Account navigation", () => {
  const accountButton = '<node text="Account" clickable="true" bounds="[849,2099][1042,2242]"/>';
  const arrivalClose = '<node content-desc="Close sealed impression" clickable="true" bounds="[893,193][1017,320]"/>';
  assert.deepEqual(accountNavigationTarget(`${accountButton}${arrivalClose}`), {
    kind: "dismiss-arrival", center: { x: 955, y: 257 },
  });
  assert.deepEqual(accountNavigationTarget(accountButton), {
    kind: "navigate", center: { x: 946, y: 2171 },
  });
  assert.equal(accountNavigationTarget(`${accountButton}<node text="Close nearby places" bounds="[1,1][3,3]"/>`).kind, "dismiss-nearby");
  assert.equal(accountNavigationTarget(`${accountButton}<node text="Claim my badge" bounds="[1,1][3,3]"/>`).kind, "dismiss-badge");
  assert.deepEqual(accountNavigationTarget('<node text="Account" resource-id="primary-content"/>'), { kind: "ready" });
  const claim = '<node text="Claim + photo" clickable="true" bounds="[10,20][110,80]"/>';
  assert.equal(sealedClaimCenter(claim), null);
  assert.deepEqual(sealedClaimCenter(`${arrivalClose}${claim}`), { x: 60, y: 50 });
});

test("waits for the sealed arrival when Locate and Claim occupy overlapping screen space", () => {
  const locate = '<node content-desc="Show my current location" clickable="true" bounds="[783,1923][910,2050]"/>';
  const close = '<node content-desc="Close sealed impression" clickable="true" bounds="[893,193][1017,320]"/>';
  const claim = '<node text="Claim + photo" clickable="true" bounds="[77,1956][1006,2096]"/>';
  const camera = '<node content-desc="Shutter" clickable="true" bounds="[0,2010][1080,2340]"/>';
  const arrival = `${locate}${close}${claim}`;
  const context = { photoTimeoutMs: 60_000 };
  const taps = [];
  let locationInjections = 0;

  // The Locate center is inside the later Claim button. A stale Locate tap
  // would launch Camera before the gate has observed the sealed arrival.
  assert.deepEqual(locateButtonCenter(locate), { x: 847, y: 1987 });
  const observedXml = openSealedArrivalCamera(context, {
    now: () => 1_000,
    injectLocation: () => { locationInjections += 1; },
    tap: (center) => { taps.push(center); },
    wait: (receivedContext, predicate, deadline, label, { retryAction }) => {
      assert.equal(receivedContext, context);
      assert.equal(deadline, 61_000);
      assert.equal(label, "Bell Park sealed Claim + photo action");
      assert.equal(predicate(locate), null);
      assert.equal(predicate(camera), null);
      assert.deepEqual(taps, []);
      retryAction();
      return { value: predicate(arrival), xml: arrival };
    },
  });
  assert.equal(observedXml, arrival);
  assert.equal(locationInjections, 1);
  assert.deepEqual(taps, [{ x: 542, y: 2026 }]);
});

test("parses deterministic emulator connectivity and process oracles", () => {
  assert.equal(parseAirplaneMode("enabled\r\n"), true);
  assert.equal(parseAirplaneMode("disabled\n"), false);
  assert.throws(() => parseAirplaneMode("unknown"), /Unexpected emulator airplane-mode state/);
  assert.equal(parseAppPid("12345\n"), "12345");
  assert.throws(() => parseAppPid("123 456"), /Could not resolve/);
  assert.throws(() => parseAppPid(""), /Could not resolve/);
});

test("requires complete in-place network startup recovery evidence", () => {
  const recovery = {
    initialCatalogueUnavailableObserved: true,
    recoveredWithoutRestart: true,
    activityPidStable: true,
    networkRestored: true,
    offlineHoldMs: 31_000,
    elapsedAfterRestoreMs: 1200,
    distances: ["0.0 km"],
  };
  assert.equal(networkStartupRecoveryReady(recovery), true);
  assert.equal(networkStartupRecoveryReady({ ...recovery, initialCatalogueUnavailableObserved: false }), false);
  assert.equal(networkStartupRecoveryReady({ ...recovery, activityPidStable: false }), false);
  assert.equal(networkStartupRecoveryReady({ ...recovery, networkRestored: false }), false);
  assert.equal(networkStartupRecoveryReady({ ...recovery, offlineHoldMs: Number.NaN }), false);
  assert.equal(networkStartupRecoveryReady({ ...recovery, distances: [] }), false);
});

test("computes deterministic nearest-rank timing summaries", () => {
  assert.deepEqual(summarizeDurations([]), { count: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null });
  assert.deepEqual(summarizeDurations([9000, 1000, 4000, 2000]), { count: 4, minMs: 1000, medianMs: 2000, p95Ms: 9000, maxMs: 9000 });
});

test("replays edge-triggered emulator fixes only at the bounded retry cadence", () => {
  assert.equal(retryActionDue(1_999, 0, 2_000), false);
  assert.equal(retryActionDue(2_000, 0, 2_000), true);
  assert.equal(retryActionDue(4_100, 2_000, 2_000), true);
  assert.throws(() => retryActionDue(1, 0, 0), /positive interval/);
});

test("a hierarchy dump crossing the deadline cannot match or schedule another injection", () => {
  let predicateCalls = 0;
  const expiredAfterDump = evaluateDumpedPoll({
    clock: () => 30_000,
    deadlineMs: 30_000,
    lastRetryAt: 27_000,
    retryEnabled: true,
  }, () => { predicateCalls += 1; return true; }, "ready XML");
  assert.deepEqual(expiredAfterDump, { expired: true, matched: false, retry: false });
  assert.equal(predicateCalls, 0);

  const times = [29_999, 30_000];
  const expiredDuringPredicate = evaluateDumpedPoll({
    clock: () => times.shift(),
    deadlineMs: 30_000,
    lastRetryAt: 27_000,
    retryEnabled: true,
  }, () => { predicateCalls += 1; return true; }, "ready XML");
  assert.deepEqual(expiredDuringPredicate, { expired: true, matched: false, retry: false });
  assert.equal(predicateCalls, 1);
});

test("sanitizes credentials and validates bounded numeric arguments", () => {
  const previousQaEmail = process.env.PARKDEX_QA_ACCOUNT_EMAIL;
  const previousRailwayDir = process.env.PARKDEX_RAILWAY_PROJECT_DIR;
  delete process.env.PARKDEX_QA_ACCOUNT_EMAIL;
  delete process.env.PARKDEX_RAILWAY_PROJECT_DIR;
  try {
    const sanitized = sanitizeText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ token=secret-value TOKEN="quoted-secret" R2_ACCESS_KEY_ID=short-access R2_SECRET_ACCESS_KEY=\'short-secret\' {"token":"json-secret","R2_ACCESS_KEY_ID":"json-access"} qa@example.com 49.0918726,-123.0600868 https://example.com/private?signature=short');
    assert.doesNotMatch(sanitized, /abcdefghijklmnopqrstuvwxyz|secret-value|quoted-secret|short-access|short-secret|json-secret|json-access|qa@example|49\.091|123\.060|example\.com/);
    const development = ["--serial", "emulator-5554", "--skip-photo-journey", "--skip-r2-contract"];
    assert.deepEqual(parseArgs([...development, "--trials", "3", "--timeout-ms", "12000"]).trials, 3);
    assert.equal(parseArgs(development).timeoutMs, 30_000);
    assert.equal(parseArgs([...development, "--allow-dirty"]).allowDirty, true);
    assert.equal(parseArgs(development).skipPhotoJourney, true);
    assert.throws(() => parseArgs(["--serial", "emulator-5554"]), /PARKDEX_QA_ACCOUNT_EMAIL is required/);
    process.env.PARKDEX_QA_ACCOUNT_EMAIL = "qa@example.com";
    assert.throws(() => parseArgs(["--serial", "emulator-5554"]), /RAILWAY_PROJECT_DIR is required/i);
    const linked = resolve(tmpdir());
    process.env.PARKDEX_RAILWAY_PROJECT_DIR = linked;
    assert.equal(parseArgs(["--serial", "emulator-5554"]).railwayProjectDir, linked);
    assert.equal(parseArgs(["--serial", "emulator-5554", "--railway-project-dir", linked]).skipPhotoJourney, false);
    assert.throws(() => parseArgs([...development, "--trials", "0"]), /integer/);
  } finally {
    if (previousQaEmail === undefined) delete process.env.PARKDEX_QA_ACCOUNT_EMAIL;
    else process.env.PARKDEX_QA_ACCOUNT_EMAIL = previousQaEmail;
    if (previousRailwayDir === undefined) delete process.env.PARKDEX_RAILWAY_PROJECT_DIR;
    else process.env.PARKDEX_RAILWAY_PROJECT_DIR = previousRailwayDir;
  }
});

test("preserves the primary error while making failed cleanup explicit", () => {
  const failure = manualCleanupFailure(new Error("photo readback failed"));
  assert.match(failure.message, /photo readback failed/);
  assert.match(failure.message, /manual staging cleanup is required/);
  assert.equal(failure.manualCleanupRequired, true);
});

test("marks only the clean default full journey as field-ready", () => {
  const release = {
    allowDirty: false,
    skipPhotoJourney: false,
    trials: 10,
    timeoutMs: 30_000,
    photoTimeoutMs: 60_000,
    skipR2Contract: false,
  };
  assert.equal(isFieldReadyProfile(release, true), true);
  assert.equal(isFieldReadyProfile({ ...release, allowDirty: true }, false), false);
  assert.equal(isFieldReadyProfile({ ...release, skipPhotoJourney: true }, true), false);
  assert.equal(isFieldReadyProfile({ ...release, skipR2Contract: true }, true), false);
  assert.equal(isFieldReadyProfile({ ...release, trials: 1 }, true), false);
  assert.equal(isFieldReadyProfile({ ...release, timeoutMs: 15_000 }, true), false);
});

test("development gates do not resolve live staging, while field-ready gates record its exact revision", () => {
  const stagingSha = "a".repeat(40);
  const calls = [];
  const resolve = (root) => {
    calls.push(root);
    return stagingSha;
  };

  assert.equal(resolveStagingBaseSha("offline-checkout", false, resolve), null);
  assert.deepEqual(calls, []);
  assert.equal(resolveStagingBaseSha("field-checkout", true, resolve), stagingSha);
  assert.deepEqual(calls, ["field-checkout"]);
  assert.throws(() => resolveStagingBaseSha("field-checkout", true, () => "not-a-sha"), /current remote staging revision/);
});

test("field-ready evidence rejects repository mutations and overwritten APKs", () => {
  const commitSha = "a".repeat(40);
  const treeSha = "b".repeat(40);
  const stagingBaseSha = "c".repeat(40);
  const apkSha = "c".repeat(64);
  const repository = (phase) => ({ phase, commitSha, treeSha, clean: true });
  const apk = (phase) => ({ ...repository(phase), apkSha });
  const evidence = {
    profileReady: true,
    commitSha,
    treeSha,
    stagingBaseSha,
    apkSha,
    r2Contract: {
      status: "success",
      railwayIdentity: {
        projectId: "0999e6e0-d2ae-4b48-b516-55d53dba7cb5",
        environmentId: "369b82da-1be4-4aea-898a-c5050c4985f7",
        serviceId: "b30d9ca5-fc77-4427-a955-b020a7ec3cf8",
      },
    },
    buildEnvironment: {
      NEXT_PUBLIC_API_BASE_URL: "https://api-staging-882c.up.railway.app",
      PARKDEX_CATALOGUE_SCOPE: "staging",
      NEXT_PUBLIC_FIELD_DIAGNOSTICS: "1",
    },
    networkStartupRecovery: {
      initialCatalogueUnavailableObserved: true,
      recoveredWithoutRestart: true,
      activityPidStable: true,
      networkRestored: true,
      offlineHoldMs: 31_000,
      elapsedAfterRestoreMs: 1500,
      distances: ["0.0 km"],
    },
    checkpoints: [
      repository("start"),
      repository("after-sync"),
      apk("after-assemble"),
      apk("after-connected-tests"),
      apk("before-install"),
      apk("final"),
    ],
  };
  assert.equal(fieldReadyFromCheckpoints(evidence), true);
  assert.equal(fieldReadyFromCheckpoints({ ...evidence, networkStartupRecovery: undefined }), false);
  assert.equal(fieldReadyFromCheckpoints({
    ...evidence,
    networkStartupRecovery: { ...evidence.networkStartupRecovery, recoveredWithoutRestart: false },
  }), false);
  assert.equal(fieldReadyFromCheckpoints({ ...evidence, stagingBaseSha: "" }), false);
  assert.equal(fieldReadyFromCheckpoints({
    ...evidence,
    checkpoints: evidence.checkpoints.map((item) => item.phase === "after-sync" ? { ...item, clean: false } : item),
  }), false);
  assert.equal(fieldReadyFromCheckpoints({
    ...evidence,
    checkpoints: evidence.checkpoints.map((item) => item.phase === "after-connected-tests" ? { ...item, treeSha: "d".repeat(40) } : item),
  }), false);
  assert.equal(fieldReadyFromCheckpoints({
    ...evidence,
    checkpoints: evidence.checkpoints.map((item) => item.phase === "before-install" ? { ...item, apkSha: "e".repeat(64) } : item),
  }), false);
  assert.equal(fieldReadyFromCheckpoints({ ...evidence, r2Contract: { status: "failure" } }), false);
  assert.equal(fieldReadyFromCheckpoints({
    ...evidence,
    r2Contract: { ...evidence.r2Contract, railwayIdentity: { ...evidence.r2Contract.railwayIdentity, projectId: "wrong" } },
  }), false);
  assert.equal(fieldReadyFromCheckpoints({
    ...evidence,
    buildEnvironment: { ...evidence.buildEnvironment, PARKDEX_CATALOGUE_SCOPE: "canonical" },
  }), false);
  assert.equal(fieldReadyFromCheckpoints({
    ...evidence,
    buildEnvironment: { ...evidence.buildEnvironment, NEXT_PUBLIC_API_BASE_URL: "https://api.parkdex.app" },
  }), false);
  assert.equal(fieldReadyFromCheckpoints({
    ...evidence,
    buildEnvironment: { ...evidence.buildEnvironment, NEXT_PUBLIC_FIELD_DIAGNOSTICS: "0" },
  }), false);
});

test("field sync overrides inherited production and canonical build settings", () => {
  const environment = stagingBuildEnvironment({
    NEXT_PUBLIC_API_BASE_URL: "https://api.parkdex.app",
    PARKDEX_CATALOGUE_SCOPE: "canonical",
    NEXT_PUBLIC_FIELD_DIAGNOSTICS: "0",
    UNRELATED_VALUE: "preserved",
  });
  assert.deepEqual({
    NEXT_PUBLIC_API_BASE_URL: environment.NEXT_PUBLIC_API_BASE_URL,
    PARKDEX_CATALOGUE_SCOPE: environment.PARKDEX_CATALOGUE_SCOPE,
    NEXT_PUBLIC_FIELD_DIAGNOSTICS: environment.NEXT_PUBLIC_FIELD_DIAGNOSTICS,
    UNRELATED_VALUE: environment.UNRELATED_VALUE,
  }, {
    NEXT_PUBLIC_API_BASE_URL: "https://api-staging-882c.up.railway.app",
    PARKDEX_CATALOGUE_SCOPE: "staging",
    NEXT_PUBLIC_FIELD_DIAGNOSTICS: "1",
    UNRELATED_VALUE: "preserved",
  });
});

test("accepts only a successful, bounded R2 contract result", () => {
  const timingsMs = { put: 2, get: 3, delete: 2, missingRead: 1, total: 12.5 };
  assert.deepEqual(parseR2ContractOutput(`provider prelude\n${JSON.stringify({ status: "success", byteCount: 4096, timingsMs })}\nprovider postlude\n`), {
    status: "success",
    byteCount: 4096,
    timingsMs,
  });
  assert.throws(() => parseR2ContractOutput('{"status":"failure","byteCount":4096,"timingsMs":{"total":1}}'), /did not confirm/);
  assert.throws(() => parseR2ContractOutput('{"status":"success","byteCount":4096,"timingsMs":{"total":1}}'), /did not confirm/);
  assert.throws(() => parseR2ContractOutput('not json'), /valid JSON/);
});

test("builds the R2 command from a linked cwd and the current branch absolute script", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const linked = mkdtempSync(join(tmpdir(), "parkdex-railway-linked-"));
  try {
    assert.equal(validateRailwayProjectDir(linked), resolve(linked));
    assert.throws(() => validateRailwayProjectDir("relative/path"), /linked absolute/);
    assert.throws(() => validateRailwayProjectDir(join(linked, "missing")), /does not exist/);
    const command = railwayContractCommand(root, linked, "win32");
    assert.equal(command.cwd, resolve(linked));
    assert.deepEqual(command.statusArgs, ["status", "--json"]);
    assert.deepEqual(command.contractArgs.slice(0, 7), ["run", "--environment", "staging", "--service", "api", "python", command.contractScript]);
    assert.equal(command.contractScript, resolve(root, "scripts", "r2-contract.py"));
    assert.equal(command.contractArgs.some((argument) => /token|secret|password/i.test(argument)), false);
  } finally {
    rmSync(linked, { recursive: true, force: true });
  }
});

test("requires the linked Railway project to expose staging and api", () => {
  const valid = JSON.stringify({
    id: "0999e6e0-d2ae-4b48-b516-55d53dba7cb5",
    environments: { edges: [{ node: { name: "staging", id: "369b82da-1be4-4aea-898a-c5050c4985f7" } }] },
    services: { edges: [{ node: { name: "api", id: "b30d9ca5-fc77-4427-a955-b020a7ec3cf8" } }] },
  });
  assert.deepEqual(validateRailwayStatus(valid), {
    projectId: "0999e6e0-d2ae-4b48-b516-55d53dba7cb5",
    environmentId: "369b82da-1be4-4aea-898a-c5050c4985f7",
    serviceId: "b30d9ca5-fc77-4427-a955-b020a7ec3cf8",
  });
  assert.throws(() => validateRailwayStatus("not json"), /not valid JSON/);
  const wrongSameNames = JSON.stringify({
    id: "00000000-0000-0000-0000-000000000001",
    environments: { edges: [{ node: { name: "staging", id: "00000000-0000-0000-0000-000000000002" } }] },
    services: { edges: [{ node: { name: "api", id: "00000000-0000-0000-0000-000000000003" } }] },
  });
  assert.throws(() => validateRailwayStatus(wrongSameNames), /reviewed Parkdex staging API identity/);
  assert.throws(() => validateRailwayStatus(JSON.stringify({ environments: { edges: [] }, services: { edges: [] } })), /reviewed Parkdex staging API identity/);
});
