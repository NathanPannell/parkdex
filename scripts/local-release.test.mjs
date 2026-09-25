import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildNeonApiCommand, buildPreviewEnvironmentName, buildProviderProcess, buildRailwayApiCommand, buildRailwayApiServiceMutation, buildRailwayApiServicePatch, buildVercelCurlArgs, catalogueVisitedIds, classifyRailwayEnvironmentCreateFailure, confirmStablePreviewAbsence, finalizeReleaseSourceCleanup, parseRailwayEnvironmentInventory, provisionRailwayApiService, sanitizeProviderDiagnostic, unresolvedPreviewResources, verifyCorsHeaders, verifyGuestVisitRejection, verifyRailwayDeploymentResult, verifyRailwayApiServicePatchResult, verifyReadyPayload, verifyUnvisitedCatalogues } from "./provider-command.mjs";

const source = readFileSync("scripts/local-release.mjs", "utf8");
const providerSource = readFileSync("scripts/provider-command.mjs", "utf8");
const previewWrapperSource = readFileSync("scripts/preview-pr.ps1", "utf8");
const teardownWrapperSource = readFileSync("scripts/teardown-preview-pr.ps1", "utf8");
const mergeCandidateSource = readFileSync("scripts/merge-candidate.mjs", "utf8");
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
  assert.match(result.stderr, /Candidate apply requires explicit --sha, --head-ref, and --attestation/);
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

test("local staging apply requires an exact reviewed candidate", () => {
  const result = invoke(["--mode", "staging", "--release-id", fixedRelease, "--sha", head, "--apply"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Candidate apply requires a valid --pr number/);
  assert.doesNotMatch(source, /Local staging Apply remains disabled/);
  assert.match(source, /verifyCandidateAuthorization/);
  assert.match(source, /attested exact reviewed PR head/);
  assert.match(source, /\["APP_COMMIT_SHA", sha\], \["APP_RELEASE_ID", releaseId\]/);
  assert.doesNotMatch(source, /PARKDEX_STAGING_DATABASE_URL|PARKDEX_STAGING_GOOGLE_CLIENT_SECRET/);
  assert.match(source, /const STAGING_API_HOST = "api-staging-882c\.up\.railway\.app"/);
  assert.match(source, /Railway staging API must run the migration pre-deploy command/);
  assert.match(source, /Railway staging API is missing \$\{name\}/);
  assert.match(source, /if \(preview && !domain\)/);
  assert.match(source, /state\.frontendUrl = preview \? vercel\.url : STAGING_FRONTEND_ORIGIN/);
  assert.match(source, /verifyBrowserCors\(state\.apiUrl, state\.frontendUrl\)/);
  assert.doesNotMatch(source, /verifyBrowserCors\(state\.apiUrl, vercel\.url\)/);
  assert.doesNotMatch(source, /RAILWAY_STAGING_ENVIRONMENT_ID \|\| process\.env\.RAILWAY_BASE_ENVIRONMENT_ID/);
});

test("Neon JSON body uses the CLI stdin sentinel as one argument", () => {
  const command = buildNeonApiCommand("neon-cli.mjs", "/projects/p/branches", { method: "POST", body: { branch: { name: "preview/test" } } });
  assert.ok(command.args.includes("--data=-"));
  assert.ok(!command.args.includes("-"));
  assert.deepEqual(JSON.parse(command.input), { branch: { name: "preview/test" } });
});

test("Neon commands avoid the analytics shutdown crash on Windows", () => {
  const command = buildNeonApiCommand("neon-cli.mjs", "/projects");
  assert.doesNotMatch(command.args.join(" "), /--analytics/);
  assert.doesNotMatch(source, /"me", "--output", "json", "--analytics"/);
});

test("provider diagnostics redact connection values at the call boundary", () => {
  const safe = sanitizeProviderDiagnostic('{"value":"sensitive","url":"postgresql://owner:password@example.neon.tech/app","token":"long-lived-token"}');
  assert.doesNotMatch(safe, /sensitive|password|long-lived-token/);
  assert.match(safe, /\[redacted\]/);
});

test("browser CORS readiness requires the exact origin and requested preflight contract", () => {
  const origin = "https://every-park-3qskgeya-nathanpannells-projects.vercel.app";
  const headers = new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type, X-Collection-Key",
  });
  assert.doesNotThrow(() => verifyCorsHeaders(headers, origin, { method: "GET", requestedHeaders: ["authorization"] }));
  assert.doesNotThrow(() => verifyCorsHeaders(headers, origin, { method: "PUT", requestedHeaders: ["content-type", "x-collection-key"] }));
  assert.throws(() => verifyCorsHeaders(headers, "https://staging.web.parkdex.app"), /exact frontend origin/);
  assert.throws(() => verifyCorsHeaders(new Headers({ "access-control-allow-origin": origin }), origin, { method: "PUT", requestedHeaders: ["x-collection-key"] }), /did not allow PUT/);
  assert.throws(() => verifyCorsHeaders(new Headers({ "access-control-allow-origin": origin, "access-control-allow-methods": "GET", "access-control-allow-headers": "content-type" }), origin, { method: "GET", requestedHeaders: ["authorization"] }), /requested headers/);
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

test("Vercel provider commands disable detached CLI telemetry and retain bounded cleanup retries", () => {
  const minimalEnv = source.match(/function minimalEnv\(extra = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  const vercelEnv = source.match(/function vercelEnv\(token, extra = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(minimalEnv);
  assert.ok(vercelEnv);
  const audit = source.match(/function verifyEmptyVercelPreviewEnvironment\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
  assert.ok(audit);
  assert.match(audit, /rmSync\(sourceRoot, \{ recursive: true, force: true, maxRetries: 5, retryDelay: 200 \}\)/);
  const extra = { PARKDEX_ENV_SENTINEL: "preserved", VERCEL_TELEMETRY_DISABLED: "" };
  const evaluated = { process: { env: process.env }, extra, result: null };
  runInNewContext(`${minimalEnv}\n${vercelEnv}\nresult = vercelEnv("fixture-token", extra);`, evaluated);
  assert.equal(extra.VERCEL_TELEMETRY_DISABLED, "");
  assert.equal(evaluated.result.VERCEL_TOKEN, "fixture-token");
  assert.equal(evaluated.result.PARKDEX_ENV_SENTINEL, "preserved");
  assert.equal(evaluated.result.VERCEL_TELEMETRY_DISABLED, "1");
  if (process.platform !== "win32") return;

  let fixtureRoot;
  let sourceRoot;
  try {
    fixtureRoot = mkdtempSync(join(tmpdir(), "parkdex-vercel-telemetry-fixture-"));
    sourceRoot = mkdtempSync(join(tmpdir(), "parkdex-vercel-environment-audit-test-"));
    const capturePath = join(fixtureRoot, "telemetry-environment.txt");
    mkdirSync(join(sourceRoot, "frontend", ".vercel"), { recursive: true });
    writeFileSync(join(sourceRoot, "frontend", ".vercel", "project.json"), "{}\n", "utf8");
    writeFileSync(join(fixtureRoot, "vercel.cmd"), `@echo off\r\n> "%PARKDEX_TELEMETRY_CAPTURE%" echo %VERCEL_TELEMETRY_DISABLED%\r\necho No Environment Variables found\r\n`, "utf8");
    const fixtureContext = { process: { env: process.env }, extra: { PATH: `${fixtureRoot}${delimiter}${process.env.PATH}`, PARKDEX_TELEMETRY_CAPTURE: capturePath }, result: null };
    runInNewContext(`${minimalEnv}\n${vercelEnv}\nresult = vercelEnv("fixture-token", extra);`, fixtureContext);
    const provider = buildProviderProcess("vercel", ["env", "ls", "preview", "--cwd", "frontend", "--no-color"], "win32");
    const result = spawnSync(provider.executable, provider.args, { cwd: sourceRoot, env: fixtureContext.result, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(capturePath, "utf8").trim(), "1");
    assert.match(result.stdout, /No Environment Variables found/);
    assert.doesNotThrow(() => rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  } finally {
    if (sourceRoot) rmSync(sourceRoot, { recursive: true, force: true });
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
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

test("isolated Railway API deployments run the idempotent migration command", () => {
  const patch = buildRailwayApiServicePatch("api-id");
  assert.deepEqual(patch.services["api-id"].deploy.preDeployCommand, ["python -m backend.app.migrate"]);
});

test("persistent Railway IaC preserves the API direct database connection and release identity", () => {
  const railwayConfig = readFileSync(".railway/railway.ts", "utf8");
  const apiConfig = railwayConfig.match(/const api = service\("api", \{(?<body>[\s\S]*?)\n  \}\);/)?.groups?.body;
  assert.ok(apiConfig);
  assert.match(apiConfig, /preDeployCommand: \["python -m backend\.app\.migrate"\]/);
  assert.match(apiConfig, /DATABASE_URL_UNPOOLED: preserve\(\)/);
  assert.match(apiConfig, /APP_RELEASE_ID: preserve\(\)/);
  assert.doesNotMatch(railwayConfig, /service\("worker"|Dockerfile\.worker/);
  assert.doesNotMatch(railwayConfig, /service\("photo-cleanup"|cronSchedule|photo_cleanup/);
  assert.match(railwayConfig, /resources: \[api\]/);
  for (const name of ["API_PUBLIC_URL", "APP_PUBLIC_URL", "APP_ENVIRONMENT", "EMAIL_PROVIDER", "ENABLE_STAGING_FIELD_PLACES", "FRONTEND_ORIGINS", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "MCP_PUBLIC_URL", "PHOTO_STORAGE_BACKEND", "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_REGION", "RESEND_API_KEY", "RESEND_FROM"]) {
    assert.match(apiConfig, new RegExp(`${name}: preserve\\(\\)`));
  }
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

test("only the Railway API is created from a sanitized patch", () => {
  const patch = buildRailwayApiServicePatch("api-id");
  assert.deepEqual(Object.keys(patch.services), ["api-id"]);
  assert.equal(patch.services["api-id"].isCreated, true);
  assert.equal(patch.services["api-id"].build.dockerfilePath, "backend/Dockerfile.api");
  assert.ok(!JSON.stringify(patch).includes("variables"));
  assert.ok(!JSON.stringify(patch).includes("source"));
  assert.ok(!JSON.stringify(patch).includes("networking"));
});

test("Railway GraphQL patch keeps structured variables on stdin", () => {
  const request = buildRailwayApiServiceMutation("environment-id", "api-id");
  const command = buildRailwayApiCommand(request.query, request.variables);
  assert.deepEqual(command.args.slice(-3), ["--variables", "@-", "--compact"]);
  assert.equal(JSON.parse(command.input).environmentId, "environment-id");
  assert.deepEqual(Object.keys(JSON.parse(command.input).patch.services), ["api-id"]);
});

test("Railway API readback rejects copied configuration", () => {
  const patch = buildRailwayApiServicePatch("api-id");
  assert.equal(verifyRailwayApiServicePatchResult(patch, "api-id"), true);
  patch.services["api-id"].variables = { SECRET: { value: "copied" } };
  assert.throws(() => verifyRailwayApiServicePatchResult(patch, "api-id"), /forbidden configuration/);
  delete patch.services["api-id"].variables;
  patch.services["extra-id"] = { isCreated: true };
  assert.throws(() => verifyRailwayApiServicePatchResult(patch, "api-id"), /identity/);
});

test("native runtime checks require exact provider identities", () => {
  const message = "local-release release-id commit commit-sha";
  assert.equal(verifyRailwayDeploymentResult([{ id: "deployment-id", status: "SUCCESS", meta: { cliMessage: message } }], message), "deployment-id");
  assert.throws(() => verifyRailwayDeploymentResult([{ id: "deployment-id", status: "FAILED", meta: { cliMessage: message } }], message), /exact successful/);
  assert.equal(verifyReadyPayload({ status: "ready", commit: "commit-sha", release: "release-id" }, "commit-sha", "release-id"), true);
  assert.throws(() => verifyReadyPayload({ status: "ready", commit: "other", release: "release-id" }, "commit-sha", "release-id"), /identity/);
});

test("Railway empty-environment shim journals, patches, then verifies readback", () => {
  const events = [];
  const config = buildRailwayApiServicePatch("api-id");
  provisionRailwayApiService({
    projectId: "project-id", environmentId: "environment-id", environmentName: "lp-pr-1-abcdef01-12345678", apiServiceId: "api-id",
    listEnvironments: () => [{ id: "environment-id", name: "lp-pr-1-abcdef01-12345678" }],
    recordIntent: (intent) => events.push(["intent", intent]),
    commitPatch: (request) => events.push(["patch", request.variables.environmentId]),
    readConfig: () => { events.push(["readback"]); return config; },
  });
  assert.deepEqual(events.map(([event]) => event), ["intent", "patch", "readback"]);
  assert.deepEqual(events[0][1], { projectId: "project-id", environmentId: "environment-id", serviceIds: ["api-id"] });
});

test("Railway service readback tolerates a brief missing configuration", () => {
  const events = [];
  let reads = 0;
  provisionRailwayApiService({
    projectId: "project-id", environmentId: "environment-id", environmentName: "lp-pr-1-abcdef01-12345678", apiServiceId: "api-id",
    listEnvironments: () => [{ id: "environment-id", name: "lp-pr-1-abcdef01-12345678" }],
    recordIntent: () => events.push("intent"),
    commitPatch: () => events.push("patch"),
    readConfig: () => { reads++; return reads === 1 ? {} : buildRailwayApiServicePatch("api-id"); },
    maxReadAttempts: 2,
    waitForRead: () => events.push("wait"),
  });
  assert.equal(reads, 2);
  assert.deepEqual(events, ["intent", "patch", "wait"]);
});

test("Railway patch failure remains journaled and stops before readback", () => {
  const events = [];
  assert.throws(() => provisionRailwayApiService({
    projectId: "project-id", environmentId: "environment-id", environmentName: "lp-pr-1-abcdef01-12345678", apiServiceId: "api-id",
    listEnvironments: () => [{ id: "environment-id", name: "lp-pr-1-abcdef01-12345678" }],
    recordIntent: () => events.push("intent"),
    commitPatch: () => { events.push("patch"); throw new Error("provider rejected patch"); },
    readConfig: () => { events.push("readback"); return {}; },
  }), /provider rejected patch/);
  assert.deepEqual(events, ["intent", "patch"]);
});

test("Railway service patch refuses an environment outside the exact project inventory", () => {
  const events = [];
  assert.throws(() => provisionRailwayApiService({
    projectId: "project-id", environmentId: "wrong-id", environmentName: "lp-pr-1-abcdef01-12345678", apiServiceId: "api-id",
    listEnvironments: () => [{ id: "environment-id", name: "lp-pr-1-abcdef01-12345678" }],
    recordIntent: () => events.push("intent"), commitPatch: () => events.push("patch"), readConfig: () => ({}),
  }), /identity was not verified/);
  assert.deepEqual(events, []);
});

test("orchestration preserves the isolation and identity contracts", () => {
  assert.doesNotMatch(source, /environment", "new"[^\n]*--(?:copy|duplicate)/);
  assert.doesNotMatch(source, /APP_ENVIRONMENT/);
  assert.match(source, /RAILWAY_ENVIRONMENT_NAME/);
  assert.match(source, /"--env", "NEXT_PUBLIC_MANUAL_CLAIM_ENABLED=1"/);
  assert.match(source, /PREVIEW_DATABASE_URL_UNPOOLED/);
  assert.match(source, /APP_RELEASE_ID/);
  assert.match(source, /API_PUBLIC_URL/);
  assert.match(source, /MCP_PUBLIC_URL/);
  assert.match(source, /`\$\{state\.apiUrl\}\/mcp`/);
  assert.match(source, /verifyRailwayDeployments/);
  assert.doesNotMatch(source, /callBash/);
  assert.match(source, /buildVercelCurlArgs/);
  assert.match(source, /verifyBrowserCors/);
  assert.match(source, /verifyCorsHeaders/);
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
  assert.match(source, /railway-api-creating/);
  assert.doesNotMatch(source, /RAILWAY_WORKER_SERVICE_ID|waitForWorkerCatalogue|workerCatalogueReady/);
  assert.match(providerSource, /environmentPatchCommit/);
  assert.doesNotMatch(providerSource, /workerServiceId|Dockerfile\.worker|workerCatalogueReady/);
  assert.doesNotMatch(source, /service", "source", "disconnect/);
  assert.match(source, /process\.env\.VERCEL_PROJECT_ID/);
  assert.doesNotMatch(source, /"vercel", \["link"/);
  assert.doesNotMatch(source, /LIVE_PROOF|--live-proof/);
  assert.match(source, /refs\/remotes\/origin\/staging/);
  assert.match(source, /parkdex\.merge-candidate\/v1/);
  assert.match(source, /trustedValidatorSha256/);
  assert.match(source, /Pull request identity did not match the requested local release source/);
  assert.match(source, /Cleanup provider project identities do not match/);
  assert.doesNotMatch(source, /expectedSha !== actualSha/);
  assert.ok(source.indexOf("atomicJournal(journalPath, state)") < source.lastIndexOf("createNeonBranch(root, state, journalPath)"));
  assert.doesNotMatch(source, /npm(?:\.cmd)?[^\n]*run[^\n]*build/);
});

test("agent preview entry point requires an open same-repository draft PR", () => {
  assert.match(previewWrapperSource, /isDraft,isCrossRepository/);
  assert.match(previewWrapperSource, /\$pr\.isDraft -ne \$true/);
  assert.match(previewWrapperSource, /\$pr\.isCrossRepository -ne \$false/);
  assert.match(previewWrapperSource, /\$pr\.baseRefName -ne 'staging'/);
  assert.match(previewWrapperSource, /current origin\/staging revision/);
  assert.match(previewWrapperSource, /--suite all/);
  assert.match(source, /requireDraft: mode === "preview"/);
  assert.match(source, /pr\.isCrossRepository !== false/);
});

test("preview evidence and journals use durable external per-PR paths", () => {
  assert.match(previewWrapperSource, /Parkdex\\preview-pr/);
  assert.match(previewWrapperSource, /journals\\pr-\$PullRequest/);
  assert.match(previewWrapperSource, /evidence\\pr-\$PullRequest/);
  assert.match(previewWrapperSource, /active\\pr-\$PullRequest\.json/);
  assert.match(previewWrapperSource, /Write-NewJsonFile \$activePath/);
  assert.match(previewWrapperSource, /already has an active local preview record/);
  assert.match(previewWrapperSource, /FileMode\]::OpenOrCreate/);
  assert.match(previewWrapperSource, /FileShare\]::None/);
  assert.match(previewWrapperSource, /abandoned-no-journal/);
  assert.match(previewWrapperSource, /owner =/);
  assert.match(teardownWrapperSource, /FileMode\]::OpenOrCreate/);
  assert.match(teardownWrapperSource, /requested journal is not the active release/);
  assert.match(teardownWrapperSource, /active\.releaseId -ne \$journal\.releaseId/);
  assert.match(teardownWrapperSource, /merge-gate=blocked-no-active-record/);
  assert.match(mergeCandidateSource, /--local-output/);
  assert.match(mergeCandidateSource, /Nested local evidence must be outside the repository/);
});

test("preview output gives agents the exact browser and teardown handoff", () => {
  assert.match(previewWrapperSource, /preview-url=/);
  assert.match(previewWrapperSource, /api-url=/);
  assert.match(previewWrapperSource, /journal=/);
  assert.match(previewWrapperSource, /teardown-command=/);
  assert.match(previewWrapperSource, /Google OAuth and outbound email are disabled/);
  assert.match(previewWrapperSource, /failed-needs-teardown/);
  assert.match(teardownWrapperSource, /Retry this exact command; do not merge while cleanup is incomplete/);
});

test("provider absence requires every exact preview inventory to be empty", () => {
  const state = {
    vercelDeploymentId: "dpl_exact",
    railwayEnvironmentId: "railway-exact",
    railwayEnvironment: "lp-pr-1-abcdef01-11111111",
    neonBranchId: "neon-exact",
    neonBranch: "preview/lp-pr-1-abcdef01-11111111",
  };
  assert.deepEqual(unresolvedPreviewResources(state, { vercelDeployments: [], railwayEnvironments: [], neonBranches: [] }), []);
  assert.deepEqual(unresolvedPreviewResources(state, { vercelDeployments: [{ id: "dpl_exact" }], railwayEnvironments: [], neonBranches: [] }), ["Vercel deployment"]);
  assert.deepEqual(unresolvedPreviewResources(state, { vercelDeployments: [], railwayEnvironments: [{ id: "other", name: state.railwayEnvironment }], neonBranches: [] }), ["Railway environment"]);
  assert.deepEqual(unresolvedPreviewResources(state, { vercelDeployments: [], railwayEnvironments: [], neonBranches: [{ id: "other", name: state.neonBranch }] }), ["Neon branch"]);
  assert.throws(() => unresolvedPreviewResources(state, { vercelDeployments: null, railwayEnvironments: [], neonBranches: [] }), /inventory was invalid/);
  assert.match(source, /confirmStablePreviewAbsence/);
  assert.match(source, /exactNeonBranchInventory/);
  assert.match(source, /inspectVercelDeploymentById/);
  assert.ok(source.indexOf("await verifyPreviewResourcesAbsent(root, state, journalPath)") < source.indexOf('status: "cleaned", cleanedAt'));
  assert.doesNotMatch(source, /state\.status === "cleaned"/);
  assert.match(teardownWrapperSource, /absenceVerification\.vercel\.absent/);
  assert.match(teardownWrapperSource, /absenceVerification\.railway\.absent/);
  assert.match(teardownWrapperSource, /absenceVerification\.neon\.absent/);
});

test("absence confirmation rejects transient emptiness before delayed provider visibility", async () => {
  const state = { railwayEnvironmentId: "railway-exact", railwayEnvironment: "preview", neonBranchId: "neon-exact", neonBranch: "preview/branch" };
  let elapsed = 0;
  let reads = 0;
  const empty = { vercelDeployments: [], railwayEnvironments: [], neonBranches: [] };
  const delayed = { vercelDeployments: [{ id: "dpl_delayed" }], railwayEnvironments: [], neonBranches: [] };
  const inventories = [empty, empty, delayed, empty, empty, empty];
  const result = await confirmStablePreviewAbsence({
    state,
    delays: [1, 1, 1, 1, 1, 1],
    minimumGraceMs: 0,
    requiredConsecutive: 3,
    now: () => elapsed,
    wait: async (milliseconds) => { elapsed += milliseconds; },
    readInventories: async () => inventories[reads++],
  });
  assert.equal(reads, 6);
  assert.equal(result.consecutiveEmpty, 3);
  assert.deepEqual(result.observations[2].unresolved, ["Vercel deployment"]);
});

test("preview configuration never copies application integration credentials", () => {
  const previewVariables = source.match(/const variables = preview\s*\? (?<preview>\[\[[\s\S]*?\]\])\s*: \[\["APP_COMMIT_SHA"/)?.groups?.preview;
  assert.ok(previewVariables);
  assert.doesNotMatch(previewVariables, /GOOGLE|EMAIL|SMTP|RESEND/);
  assert.match(providerSource, /inherited forbidden configuration/);
  assert.match(source, /Vercel Preview environment must contain no configured variables/);
  assert.match(source, /enforceEmptyVercelPreview: preview/);
  assert.match(source, /process\.env\.NEON_PARENT_BRANCH !== "staging"/);
  assert.match(source, /matches\[0\]\.target !== "preview"/);
  assert.match(source, /"remove", state\.vercelDeploymentId, "--safe", "--yes"/);
});

test("preview smoke honors guest location-claim enforcement", () => {
  assert.deepEqual(catalogueVisitedIds({ visitedIds: ["park"] }), ["park"]);
  assert.throws(() => catalogueVisitedIds({}), /visitedIds contract/);
  assert.equal(verifyGuestVisitRejection(409, { detail: { code: "location_claim_required" } }), true);
  assert.throws(() => verifyGuestVisitRejection(200, {}), /guest visit enforcement/);
  assert.equal(verifyUnvisitedCatalogues("park", [{ visitedIds: [] }, { visitedIds: ["other"] }]), true);
  assert.throws(() => verifyUnvisitedCatalogues("park", [{ visitedIds: ["park"] }]), /visit isolation/);
  assert.throws(() => verifyUnvisitedCatalogues("park", [{}]), /visitedIds contract/);
  assert.doesNotMatch(source, /api\/auth\/register/);
});
