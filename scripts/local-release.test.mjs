import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildNeonApiCommand, buildPreviewEnvironmentName, buildProviderProcess, buildRailwayApiCommand, buildRailwayServiceMutation, buildRailwayServicePatch, buildVercelCurlArgs, classifyRailwayEnvironmentCreateFailure, finalizeReleaseSourceCleanup, parseRailwayEnvironmentInventory, provisionRailwayServiceInstances, sanitizeProviderDiagnostic, verifyRailwayDeploymentResult, verifyRailwayServicePatchResult, verifyReadyPayload, workerCatalogueReady } from "./provider-command.mjs";

const source = readFileSync("scripts/local-release.mjs", "utf8");
const providerSource = readFileSync("scripts/provider-command.mjs", "utf8");
const fixedRelease = "11111111-1111-4111-8111-111111111111";
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

function invoke(args, env = {}) {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC", "ComSpec", "WINDIR"];
  const safeEnv = Object.fromEntries(keep.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return spawnSync(process.execPath, ["scripts/local-release.mjs", ...args], {
    cwd: process.cwd(),
    env: { ...safeEnv, ...env },
    encoding: "utf8",
  });
}

test("preview planning is unique and provider-free", () => {
  const sourceSha = "a".repeat(40);
  const result = invoke(["--mode", "preview", "--pr", "321", "--release-id", fixedRelease, "--sha", sourceSha]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.harnessSha, head);
  assert.equal(plan.commitSha, sourceSha);
  assert.match(plan.railwayEnvironment, /^lp-pr-321-[0-9a-f]{8}-11111111$/);
  assert.ok(plan.railwayEnvironment.length <= 30);
  assert.equal(plan.neonBranch, `preview/${plan.railwayEnvironment}`);
  assert.equal(plan.apply, false);
});

test("apply remains fail-closed before provider commands", () => {
  const result = invoke(["--mode", "preview", "--pr", "321", "--release-id", fixedRelease, "--sha", head, "--apply"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Preview apply requires explicit --sha, --head-ref, and --attestation/);
});

test("cleanup requires an explicit durable journal", () => {
  const result = invoke(["--mode", "cleanup", "--release-id", fixedRelease, "--apply"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cleanup requires its exact existing release journal/);
});

test("cleanup without apply is rejected before journal access", () => {
  const result = invoke(["--mode", "cleanup", "--release-id", fixedRelease]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cleanup requires explicit --apply/);
});

test("local staging apply remains disabled", () => {
  const result = invoke(["--mode", "staging", "--release-id", fixedRelease, "--sha", head, "--apply"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Local staging Apply remains disabled/);
});

test("Neon JSON body uses the CLI stdin sentinel as one argument", () => {
  const command = buildNeonApiCommand("neon-cli.mjs", "/projects/p/branches", { method: "POST", body: { branch: { name: "preview/test" } } });
  assert.ok(command.args.includes("--data=-"));
  assert.ok(!command.args.includes("-"));
  assert.deepEqual(JSON.parse(command.input), { branch: { name: "preview/test" } });
});

test("provider diagnostics redact connection values at the call boundary", () => {
  const safe = sanitizeProviderDiagnostic('{"value":"sensitive","url":"postgresql://owner:password@example.neon.tech/app","token":"long-lived-token"}');
  assert.doesNotMatch(safe, /sensitive|password|long-lived-token/);
  assert.match(safe, /\[redacted\]/);
});

test("Windows provider commands execute through the cmd shim with status preserved", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "parkdex-provider-shim-"));
  try {
    writeFileSync(join(directory, "railway.cmd"), "@echo off\r\nif \"%~1\"==\"fail\" exit /b 7\r\necho %*\r\n", "utf8");
    const success = buildProviderProcess("railway", ["deployment", "list"], "win32");
    const successResult = spawnSync(success.executable, success.args, { encoding: "utf8", env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` } });
    assert.equal(successResult.status, 0, successResult.stderr);
    assert.match(successResult.stdout, /deployment list/);
    const failure = buildProviderProcess("railway", ["fail"], "win32");
    const failureResult = spawnSync(failure.executable, failure.args, { encoding: "utf8", env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` } });
    assert.equal(failureResult.status, 7);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release source cleanup recovers from a partial git worktree removal", () => {
  const calls = [];
  let exists = true;
  let registered = true;
  const result = finalizeReleaseSourceCleanup({
    sourceRoot: "C:/temp/release-source",
    removeWorktree: () => { calls.push("worktree"); registered = false; throw new Error("partial removal"); },
    removeDirectory: () => { calls.push("directory"); exists = false; },
    pruneWorktrees: () => { calls.push("prune"); },
    sourceExists: () => exists,
    sourceRegistered: () => registered,
  });
  assert.deepEqual(result, { recovered: true });
  assert.deepEqual(calls, ["worktree", "directory", "prune"]);
});

test("release source cleanup stays fail-closed when residue remains", () => {
  const original = new Error("worktree removal failed");
  assert.throws(() => finalizeReleaseSourceCleanup({
    sourceRoot: "C:/temp/release-source",
    removeWorktree: () => { throw original; },
    removeDirectory: () => {},
    pruneWorktrees: () => {},
    sourceExists: () => false,
    sourceRegistered: () => true,
  }), (error) => error === original);
});

test("protected Vercel content uses the exact native CLI target on Windows", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "parkdex-vercel-shim-"));
  try {
    writeFileSync(join(directory, "vercel.cmd"), "@echo off\r\nif \"%~2\"==\"/fail\" exit /b 9\r\necho %*\r\n", "utf8");
    const outputPath = join(directory, "page.html");
    const args = buildVercelCurlArgs("/", "https://exact-preview.vercel.app/", "exact-scope", outputPath);
    const command = buildProviderProcess("vercel", args, "win32");
    const result = spawnSync(command.executable, command.args, { encoding: "utf8", env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /curl \/ --deployment https:\/\/exact-preview\.vercel\.app\/ --cwd frontend --scope exact-scope -- --fail --silent --show-error --output/);
    assert.throws(() => buildVercelCurlArgs("/", "https://vercel.com/sso-api", "exact-scope", outputPath), /URL was invalid/);
    assert.throws(() => buildVercelCurlArgs("/../secret", "https://exact-preview.vercel.app/", "exact-scope", outputPath), /route was invalid/);
    const failure = buildProviderProcess("vercel", ["curl", "/fail"], "win32");
    assert.equal(spawnSync(failure.executable, failure.args, { env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` } }).status, 9);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preview database identity guards pass", () => {
  const result = spawnSync("python", ["-m", "pytest", "scripts/verify_preview_database_test.py", "-q"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("preview names stay in the conservative Railway-safe subset", () => {
  assert.equal(buildPreviewEnvironmentName(999999, "abcdef0123456789", fixedRelease), "lp-pr-999999-abcdef01-11111111");
  assert.equal(buildPreviewEnvironmentName(999999, "abcdef0123456789", fixedRelease).length, 30);
});

test("Railway absence is accepted only from a complete non-paginated inventory", () => {
  assert.deepEqual(parseRailwayEnvironmentInventory({ environments: [] }), []);
  assert.throws(() => parseRailwayEnvironmentInventory({}), /complete list/);
  assert.throws(() => parseRailwayEnvironmentInventory({ environments: [], pageInfo: { hasNextPage: true } }), /paginated/);
  assert.throws(() => parseRailwayEnvironmentInventory({ environments: [{ name: "preview" }] }), /invalid entry/);
});

test("only Railway's exact invalid-name rejection is classified as pre-create", () => {
  assert.equal(classifyRailwayEnvironmentCreateFailure("> Environment name bad\nError in name - Invalid input\n"), "invalid-name");
  assert.equal(classifyRailwayEnvironmentCreateFailure("operation timed out"), "unknown");
  assert.equal(classifyRailwayEnvironmentCreateFailure("not authorized"), "unknown");
});

test("Railway preview services are created from a sanitized patch", () => {
  const patch = buildRailwayServicePatch("api-id", "worker-id");
  assert.deepEqual(Object.keys(patch.services).sort(), ["api-id", "worker-id"]);
  assert.equal(patch.services["api-id"].isCreated, true);
  assert.equal(patch.services["worker-id"].isCreated, true);
  assert.ok(!JSON.stringify(patch).includes("variables"));
  assert.ok(!JSON.stringify(patch).includes("source"));
  assert.ok(!JSON.stringify(patch).includes("networking"));
});

test("Railway GraphQL patch keeps structured variables on stdin", () => {
  const request = buildRailwayServiceMutation("environment-id", "api-id", "worker-id");
  const command = buildRailwayApiCommand(request.query, request.variables);
  assert.deepEqual(command.args.slice(-3), ["--variables", "@-", "--compact"]);
  assert.equal(JSON.parse(command.input).environmentId, "environment-id");
  assert.deepEqual(Object.keys(JSON.parse(command.input).patch.services).sort(), ["api-id", "worker-id"]);
});

test("Railway preview service readback rejects copied configuration", () => {
  const patch = buildRailwayServicePatch("api-id", "worker-id");
  assert.equal(verifyRailwayServicePatchResult(patch, "api-id", "worker-id"), true);
  patch.services["api-id"].variables = { SECRET: { value: "copied" } };
  assert.throws(() => verifyRailwayServicePatchResult(patch, "api-id", "worker-id"), /forbidden configuration/);
  delete patch.services["api-id"].variables;
  patch.services["extra-id"] = { isCreated: true };
  assert.throws(() => verifyRailwayServicePatchResult(patch, "api-id", "worker-id"), /identities/);
});

test("native runtime checks require exact provider identities", () => {
  const message = "local-release release-id commit commit-sha";
  assert.equal(verifyRailwayDeploymentResult([{ id: "deployment-id", status: "SUCCESS", meta: { cliMessage: message } }], message), "deployment-id");
  assert.throws(() => verifyRailwayDeploymentResult([{ id: "deployment-id", status: "FAILED", meta: { cliMessage: message } }], message), /exact successful/);
  assert.equal(verifyReadyPayload({ status: "ready", commit: "commit-sha", release: "release-id" }, "commit-sha", "release-id"), true);
  assert.throws(() => verifyReadyPayload({ status: "ready", commit: "other", release: "release-id" }, "commit-sha", "release-id"), /identity/);
  assert.equal(workerCatalogueReady("Parkdex catalogue ready commit=commit-sha release=release-id places=195", "commit-sha", "release-id"), true);
  assert.equal(workerCatalogueReady("Parkdex catalogue ready commit=other release=release-id places=195", "commit-sha", "release-id"), false);
});

test("Railway empty-environment shim journals, patches, then verifies readback", () => {
  const events = [];
  const config = buildRailwayServicePatch("api-id", "worker-id");
  provisionRailwayServiceInstances({
    projectId: "project-id", environmentId: "environment-id", environmentName: "lp-pr-1-abcdef01-12345678", apiServiceId: "api-id", workerServiceId: "worker-id",
    listEnvironments: () => [{ id: "environment-id", name: "lp-pr-1-abcdef01-12345678" }],
    recordIntent: (intent) => events.push(["intent", intent]),
    commitPatch: (request) => events.push(["patch", request.variables.environmentId]),
    readConfig: () => { events.push(["readback"]); return config; },
  });
  assert.deepEqual(events.map(([event]) => event), ["intent", "patch", "readback"]);
  assert.deepEqual(events[0][1], { projectId: "project-id", environmentId: "environment-id", serviceIds: ["api-id", "worker-id"] });
});

test("Railway patch failure remains journaled and stops before readback", () => {
  const events = [];
  assert.throws(() => provisionRailwayServiceInstances({
    projectId: "project-id", environmentId: "environment-id", environmentName: "lp-pr-1-abcdef01-12345678", apiServiceId: "api-id", workerServiceId: "worker-id",
    listEnvironments: () => [{ id: "environment-id", name: "lp-pr-1-abcdef01-12345678" }],
    recordIntent: () => events.push("intent"),
    commitPatch: () => { events.push("patch"); throw new Error("provider rejected patch"); },
    readConfig: () => { events.push("readback"); return {}; },
  }), /provider rejected patch/);
  assert.deepEqual(events, ["intent", "patch"]);
});

test("Railway service patch refuses an environment outside the exact project inventory", () => {
  const events = [];
  assert.throws(() => provisionRailwayServiceInstances({
    projectId: "project-id", environmentId: "wrong-id", environmentName: "lp-pr-1-abcdef01-12345678", apiServiceId: "api-id", workerServiceId: "worker-id",
    listEnvironments: () => [{ id: "environment-id", name: "lp-pr-1-abcdef01-12345678" }],
    recordIntent: () => events.push("intent"), commitPatch: () => events.push("patch"), readConfig: () => ({}),
  }), /identity was not verified/);
  assert.deepEqual(events, []);
});

test("orchestration preserves the isolation and identity contracts", () => {
  assert.doesNotMatch(source, /environment", "new"[^\n]*--(?:copy|duplicate)/);
  assert.doesNotMatch(source, /APP_ENVIRONMENT/);
  assert.match(source, /RAILWAY_ENVIRONMENT_NAME/);
  assert.match(source, /PREVIEW_DATABASE_URL_UNPOOLED/);
  assert.match(source, /APP_RELEASE_ID/);
  assert.match(source, /API_PUBLIC_URL/);
  assert.match(source, /MCP_PUBLIC_URL/);
  assert.match(source, /`\$\{state\.apiUrl\}\/mcp`/);
  assert.match(source, /verifyRailwayDeployments/);
  assert.doesNotMatch(source, /callBash/);
  assert.match(source, /buildVercelCurlArgs/);
  assert.doesNotMatch(source, /fetch\(frontendUrl/);
  assert.match(source, /parkdexReleaseId/);
  assert.match(source, /parkdexEnvironment/);
  assert.match(source, /state\.neonBranch !== `preview\/\$\{state\.railwayEnvironment\}`/);
  assert.match(source, /Preview database zero-row gate/);
  assert.match(source, /app_preview_/);
  assert.match(source, /endpoint\.host/);
  assert.match(source, /-pooler\$2/);
  assert.ok(source.indexOf("neonDatabaseInitialization") < source.indexOf("Preview database migrations"));
  assert.match(source, /Preview database migration idempotency/);
  assert.match(source, /Preview database isolation and catalogue gate/);
  assert.match(source, /frontend-creating/);
  assert.match(source, /railway-services-creating/);
  assert.match(providerSource, /environmentPatchCommit/);
  assert.doesNotMatch(source, /service", "source", "disconnect/);
  assert.match(source, /process\.env\.VERCEL_PROJECT_ID/);
  assert.doesNotMatch(source, /"vercel", \["link"/);
  assert.doesNotMatch(source, /LIVE_PROOF|--live-proof/);
  assert.match(source, /refs\/remotes\/origin\/staging/);
  assert.match(source, /parkdex\.merge-candidate\/v1/);
  assert.match(source, /trustedValidatorSha256/);
  assert.match(source, /Preview pull request identity did not match/);
  assert.match(source, /Cleanup provider project identities do not match/);
  assert.doesNotMatch(source, /expectedSha !== actualSha/);
  assert.ok(source.indexOf("atomicJournal(journalPath, state)") < source.lastIndexOf("createNeonBranch(root, state, journalPath)"));
  assert.doesNotMatch(source, /npm(?:\.cmd)?[^\n]*run[^\n]*build/);
});
