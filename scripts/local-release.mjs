#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalGithubRepositorySlug, validateNestedLocalEvidence } from "./evidence-validation.mjs";
import { buildNeonApiCommand, buildPreviewEnvironmentName, buildProviderProcess, buildRailwayApiCommand, buildVercelCurlArgs, catalogueVisitedIds, classifyRailwayEnvironmentCreateFailure, confirmStablePreviewAbsence, finalizeReleaseSourceCleanup, parseRailwayEnvironmentInventory, provisionRailwayApiService, sanitizeProviderDiagnostic, verifyCorsHeaders, verifyGuestVisitRejection, verifyRailwayDeploymentResult, verifyReadyPayload, verifyUnvisitedCatalogues } from "./provider-command.mjs";

const value = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(name);
const REPOSITORY = "NathanPannell/parkdex";
const STAGING_API_HOST = "api-staging-882c.up.railway.app";
const STAGING_FRONTEND_ORIGIN = "https://staging.web.parkdex.app";

function run(command, args, options = {}) {
  const provider = buildProviderProcess(command, args);
  const result = spawnSync(provider.executable, provider.args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`${options.label || command} failed with exit ${result.status ?? "spawn"}`);
    Object.defineProperty(error, "providerStderr", { value: sanitizeProviderDiagnostic(`${result.stderr || ""}\n${result.stdout || ""}`), enumerable: false });
    throw error;
  }
  return (result.stdout || "").trim();
}

function git(root, args) {
  return run("git", args, { cwd: root, label: `git ${args[0]}` });
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

function minimalEnv(extra = {}) {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC", "ComSpec", "WINDIR", "CI"];
  const env = Object.fromEntries(keep.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return { ...env, ...extra };
}

function atomicJournal(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function updateJournal(path, state, patch) {
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });
  atomicJournal(path, state);
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON`); }
}

function trustedHarness(root) {
  if (canonicalGithubRepositorySlug(git(root, ["remote", "get-url", "origin"])) !== REPOSITORY.toLowerCase()) throw new Error("Origin does not match the canonical Parkdex repository");
  git(root, ["fetch", "--no-tags", "origin", "+refs/heads/staging:refs/remotes/origin/staging"]);
  const harnessSha = git(root, ["rev-parse", "HEAD"]);
  if (harnessSha !== git(root, ["rev-parse", "refs/remotes/origin/staging"])) throw new Error("Provider Apply requires the clean current remote staging harness");
  return harnessSha;
}

function verifyCandidateAuthorization(root, harnessSha, sourceSha, pullRequest, headRef, attestationPath, { requireDraft = false } = {}) {
  if (!/^[A-Za-z0-9._/-]+$/.test(headRef || "") || headRef.startsWith("/") || headRef.includes("..")) throw new Error("Candidate apply requires a safe --head-ref");
  const resolved = resolve(attestationPath);
  const relativePath = relative(root, resolved);
  if (!relativePath.startsWith("..") || !existsSync(resolved)) throw new Error("Candidate attestation must be an existing file outside the repository");
  const evidenceText = readFileSync(resolved, "utf8");
  const evidence = parseJson(evidenceText, "Merge-candidate attestation");
  if (evidence.schema !== "parkdex.merge-candidate/v1" || evidence.status !== "success" || evidence.headSha !== sourceSha || evidence.baseRef !== "refs/heads/staging" || evidence.baseSha !== harnessSha || evidence.remoteBaseSha !== harnessSha || evidence.validatorRef !== harnessSha || evidence.suite !== "all" || canonicalGithubRepositorySlug(evidence.repository) !== REPOSITORY.toLowerCase()) throw new Error("Merge-candidate attestation identity was incomplete");
  git(root, ["fetch", "--no-tags", "origin", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`]);
  if (git(root, ["rev-parse", `refs/remotes/origin/${headRef}`]) !== sourceSha) throw new Error("Preview source no longer matches the attested remote head");
  const pr = parseJson(run("gh", ["pr", "view", String(pullRequest), "--repo", REPOSITORY, "--json", "number,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid"], { env: minimalEnv(), label: "GitHub pull request identity" }), "GitHub pull request identity");
  if (pr.number !== pullRequest || pr.state !== "OPEN" || pr.isCrossRepository !== false || pr.baseRefName !== "staging" || pr.headRefName !== headRef || pr.headRefOid !== sourceSha || (requireDraft && pr.isDraft !== true)) throw new Error("Pull request identity did not match the requested local release source");
  const treeSha = git(root, ["merge-tree", "--write-tree", harnessSha, sourceSha]).split(/\s+/).find((item) => /^[0-9a-f]{40}$/.test(item));
  if (!treeSha || treeSha !== evidence.treeSha) throw new Error("Preview merge tree no longer matches the attestation");
  if (git(root, ["rev-parse", `${evidence.candidateSha}^{tree}`]) !== treeSha || git(root, ["show", "-s", "--format=%P", evidence.candidateSha]) !== `${harnessSha} ${sourceSha}`) throw new Error("Preview candidate commit does not bind the exact merge tree and parents");
  const trustedValidator = `${git(root, ["show", `${harnessSha}:scripts/local-ci.mjs`])}\n`;
  if (createHash("sha256").update(trustedValidator).digest("hex") !== evidence.trustedValidatorSha256) throw new Error("Preview trusted validator identity did not match staging");
  const localEvidenceText = readFileSync(evidence.localEvidencePath, "utf8");
  if (createHash("sha256").update(localEvidenceText).digest("hex") !== evidence.localEvidenceSha256) throw new Error("Preview nested local evidence hash did not match");
  const localEvidence = parseJson(localEvidenceText, "Nested local evidence");
  if (!validateNestedLocalEvidence(localEvidence, { candidateSha: evidence.candidateSha, treeSha, repository: REPOSITORY, validatorSha256: evidence.trustedValidatorSha256, requireCanonicalGithub: true })) throw new Error("Preview nested evidence did not prove the exact complete merge candidate");
  return { schema: evidence.schema, attestationSha256: createHash("sha256").update(evidenceText).digest("hex"), baseSha: harnessSha, headSha: sourceSha, headRef, treeSha, candidateSha: evidence.candidateSha, pullRequest };
}

function railwayEnv(token, extra = {}) {
  return minimalEnv({ ...(token ? { RAILWAY_API_TOKEN: token } : {}), ...extra });
}

function vercelEnv(token, extra = {}) {
  return minimalEnv({ ...(token ? { VERCEL_TOKEN: token } : {}), ...extra, VERCEL_TELEMETRY_DISABLED: "1" });
}

function neonCli(root) {
  const cli = join(root, "node_modules", "neonctl", "bin", "cli.js");
  if (!existsSync(cli)) throw new Error("Neon CLI dependency is not installed; run npm ci");
  return cli;
}

function neonApi(root, path, { method = "GET", query = {}, body } = {}) {
  const cli = neonCli(root);
  const command = buildNeonApiCommand(cli, path, { method, query, body });
  return parseJson(run(process.execPath, command.args, { cwd: root, input: command.input, env: minimalEnv(), label: `Neon API ${method} ${path}` }), "Neon API");
}

function neonAnnotations(payload) {
  return payload?.annotation?.value || payload?.branch?.annotation_value || payload?.branch?.annotations || payload?.annotation_value || payload?.annotations || {};
}

function exactNeonBranchInventory(root, state) {
  const base = `/projects/${process.env.NEON_PROJECT_ID}`;
  if (!state.neonBranchId) {
    const listing = neonApi(root, `${base}/branches`, { query: { limit: 1000 } });
    if (!Array.isArray(listing.branches)) throw new Error("Neon branch inventory was incomplete");
    return listing.branches.filter((branch) => branch.name === state.neonBranch);
  }
  try {
    const data = neonApi(root, `${base}/branches/${state.neonBranchId}`);
    const branch = data.branch || data;
    if (branch.id !== state.neonBranchId || branch.name !== state.neonBranch) throw new Error("Neon exact branch identity was not verified");
    return [branch];
  } catch (error) {
    if (/(?:HTTP[^\n]*404|not found|does not exist)/i.test(error.providerStderr || "")) return [];
    throw error;
  }
}

function verifyEmptyVercelPreviewEnvironment() {
  const sourceRoot = mkdtempSync(join(tmpdir(), "parkdex-vercel-environment-audit-"));
  try {
    bindVercelProject(sourceRoot);
    const provider = buildProviderProcess("vercel", ["env", "ls", "preview", "--cwd", "frontend", "--no-color", ...vercelScopeArgs()]);
    const result = spawnSync(provider.executable, provider.args, { cwd: sourceRoot, env: vercelEnv(process.env.VERCEL_TOKEN), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("Vercel Preview environment inventory failed");
    const inventory = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (!/No Environment Variables found/.test(inventory)) throw new Error("Vercel Preview environment must contain no configured variables before candidate code can build");
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function providerPreflight(root, preview, { enforceEmptyVercelPreview = false } = {}) {
  run("railway", ["whoami"], { env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway authentication" });
  const railwayProjects = parseJson(run("railway", ["list", "--json"], { env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway project inventory" }), "Railway project inventory");
  const railwayMatches = railwayProjects.filter((project) => project.id === process.env.RAILWAY_PROJECT_ID && project.deletedAt == null);
  if (railwayMatches.length !== 1) throw new Error("Railway project identity was not verified");
  const railwayProject = railwayMatches[0];
  const serviceIds = new Set((railwayProject.services?.edges || []).map((edge) => edge.node?.id));
  if (!serviceIds.has(process.env.RAILWAY_API_SERVICE_ID)) throw new Error("Railway API service identity was not verified");
  const environmentId = preview ? process.env.RAILWAY_BASE_ENVIRONMENT_ID : process.env.RAILWAY_STAGING_ENVIRONMENT_ID;
  const environment = (railwayProject.environments?.edges || []).map((edge) => edge.node).find((item) => item?.id === environmentId);
  if (!environment || environment.name !== "staging") throw new Error("Railway staging/base environment identity was not verified");

  if (!preview) {
    const context = railwayContext(process.env.RAILWAY_PROJECT_ID, environmentId, process.env.RAILWAY_API_TOKEN);
    try {
      const config = parseJson(run("railway", ["environment", "config", "--environment", environmentId, "--json"], { cwd: context, env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway staging configuration" }), "Railway staging configuration");
      const serviceConfig = config.services?.[process.env.RAILWAY_API_SERVICE_ID];
      if (!serviceConfig || serviceConfig.source != null) throw new Error("Railway staging API must exist without a Git source");
      if (serviceConfig.deploy?.preDeployCommand?.join(" ") !== "python -m backend.app.migrate") throw new Error("Railway staging API must run the migration pre-deploy command");
      for (const name of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
        if (!Object.hasOwn(serviceConfig.variables || {}, name)) throw new Error(`Railway staging API is missing ${name}`);
      }
    } finally { rmSync(context, { recursive: true, force: true }); }
    const domains = parseJson(run("railway", ["domain", "list", "--project", process.env.RAILWAY_PROJECT_ID, "--environment", environmentId, "--service", process.env.RAILWAY_API_SERVICE_ID, "--json"], { env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway staging domain list" }), "Railway staging domains");
    const generatedDomains = [...new Set(JSON.stringify(domains).match(/[a-zA-Z0-9][a-zA-Z0-9-]*\.up\.railway\.app/g) || [])];
    if (generatedDomains.length !== 1 || generatedDomains[0] !== STAGING_API_HOST) throw new Error("Railway staging API domain identity was not verified");
  }

  if (preview) {
    if (process.env.NEON_PARENT_BRANCH !== "staging") throw new Error("Preview Neon parent must be the isolated staging branch");
    run(process.execPath, [neonCli(root), "me", "--output", "json"], { cwd: root, env: minimalEnv(), label: "Neon authentication" });
    const neonProjects = neonApi(root, "/projects", { query: { limit: 100, org_id: process.env.NEON_ORG_ID } });
    if ((neonProjects.projects || []).filter((project) => project.id === process.env.NEON_PROJECT_ID).length !== 1) throw new Error("Neon project identity was not verified");
  }

  run("vercel", ["whoami"], { env: vercelEnv(process.env.VERCEL_TOKEN), label: "Vercel authentication" });
  const vercelProjects = parseJson(run("vercel", ["project", "ls", "--json", ...vercelScopeArgs()], { env: vercelEnv(process.env.VERCEL_TOKEN), label: "Vercel project inventory" }), "Vercel project inventory");
  if ((vercelProjects.projects || []).filter((project) => project.id === process.env.VERCEL_PROJECT_ID && project.name === process.env.VERCEL_PROJECT_NAME).length !== 1) throw new Error("Vercel project identity was not verified");
  if (enforceEmptyVercelPreview) verifyEmptyVercelPreviewEnvironment();
}

async function createNeonBranch(root, state, journalPath) {
  const project = process.env.NEON_PROJECT_ID;
  const base = `/projects/${project}`;
  const listing = neonApi(root, `${base}/branches`, { query: { limit: 1000 } });
  const parent = (listing.branches || []).filter((branch) => branch.name === process.env.NEON_PARENT_BRANCH);
  if (parent.length !== 1) throw new Error("Neon parent branch was not resolved exactly");
  if ((listing.branches || []).some((branch) => branch.name === state.neonBranch)) throw new Error("Refusing to adopt an existing Neon preview branch");
  let branch;
  try {
    updateJournal(journalPath, state, { resourceIntent: { ...(state.resourceIntent || {}), neon: { branchName: state.neonBranch, parentId: parent[0].id, releaseId: state.releaseId } }, status: "neon-creating" });
    const created = neonApi(root, `${base}/branches`, {
      method: "POST",
      body: {
        branch: { name: state.neonBranch, parent_id: parent[0].id, init_source: "parent-schema", expires_at: state.expiresAt },
        endpoints: [{ type: "read_write" }],
        annotation_value: { "parkdex-release-id": state.releaseId, "parkdex-commit": state.commitSha, "parkdex-environment": state.railwayEnvironment },
      },
    });
    branch = created.branch;
  } catch (error) {
    const recovered = neonApi(root, `${base}/branches`, { query: { limit: 1000 } });
    const matches = (recovered.branches || []).filter((item) => item.name === state.neonBranch);
    if (matches.length !== 1) throw error;
    branch = matches[0];
  }
  if (!branch?.id || branch.name !== state.neonBranch) throw new Error("Neon branch creation identity was not verified");
  const detailsData = neonApi(root, `${base}/branches/${branch.id}`);
  const details = detailsData.branch || detailsData;
  const annotations = neonAnnotations(detailsData);
  if (details?.name !== state.neonBranch || details?.init_source !== "parent-schema" || (details?.parent_id != null && details.parent_id !== parent[0].id) || annotations["parkdex-release-id"] !== state.releaseId || annotations["parkdex-commit"] !== state.commitSha || annotations["parkdex-environment"] !== state.railwayEnvironment) throw new Error("Neon branch provenance was not verified");
  const endpointListing = neonApi(root, `${base}/endpoints`, { query: { limit: 1000 } });
  const endpoints = (endpointListing.endpoints || []).filter((endpoint) => endpoint.branch_id === branch.id && endpoint.project_id === project && endpoint.type === "read_write");
  if (endpoints.length !== 1) throw new Error("Neon preview endpoint identity was not verified");
  const endpoint = endpoints[0];
  const directHost = endpoint.host;
  const pooledHost = directHost?.replace(/^([^.]+)(\..+)$/, "$1-pooler$2");
  if (!directHost || !pooledHost || directHost === pooledHost || !directHost.startsWith(`${endpoint.id}.`) || !directHost.endsWith(".neon.tech") || !pooledHost.startsWith(`${endpoint.id}-pooler.`) || !pooledHost.endsWith(".neon.tech")) throw new Error("Neon preview endpoint hosts were not verified");
  updateJournal(journalPath, state, { neonBranchId: branch.id, neonEndpointId: endpoint.id, status: "neon-created" });

  const databaseName = `app_preview_${state.releaseId.replaceAll("-", "").slice(0, 8)}`;
  const databasePath = `${base}/branches/${branch.id}/databases`;
  const databaseListing = neonApi(root, databasePath);
  if ((databaseListing.databases || []).some((database) => database.name === databaseName)) throw new Error("Refusing to adopt an existing Neon preview database");
  let database;
  try {
    updateJournal(journalPath, state, { resourceIntent: { ...(state.resourceIntent || {}), neonDatabase: { projectId: project, branchId: branch.id, endpointId: endpoint.id, databaseName, ownerName: "app_owner" } }, status: "neon-database-creating" });
    const created = neonApi(root, databasePath, { method: "POST", body: { database: { name: databaseName, owner_name: "app_owner" } } });
    database = created.database || created;
  } catch (error) {
    const recovered = neonApi(root, databasePath);
    const matches = (recovered.databases || []).filter((item) => item.name === databaseName);
    if (matches.length !== 1) throw error;
    database = matches[0];
  }
  if (!database?.id || database.name !== databaseName || (database.branch_id != null && database.branch_id !== branch.id) || (database.owner_name != null && database.owner_name !== "app_owner")) throw new Error("Neon preview database identity was not verified");
  updateJournal(journalPath, state, { neonDatabaseId: database.id, neonDatabaseName: databaseName, status: "neon-database-created" });
  const connection = async (pooled) => {
    return neonApi(root, `${base}/connection_uri`, { query: { branch_id: branch.id, database_name: databaseName, role_name: "app_owner", pooled: String(pooled) } }).uri;
  };
  const validateUri = (uri, pooled) => {
    const parsed = new URL(uri);
    const expectedHost = pooled ? pooledHost : directHost;
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== expectedHost || parsed.pathname !== `/${databaseName}` || decodeURIComponent(parsed.username) !== 'app_owner') throw new Error("Neon connection URI identity was not verified");
    return uri;
  };
  return { pooled: validateUri(await connection(true), true), direct: validateUri(await connection(false), false), databaseName, directHost, pooledHost };
}

function railwayContext(projectId, baseEnvironment, token) {
  const cwd = mkdtempSync(join(tmpdir(), "parkdex-railway-context-"));
  run("railway", ["link", "--project", projectId, "--environment", baseEnvironment], { cwd, env: railwayEnv(token), label: "Railway link" });
  return cwd;
}

function listRailwayEnvironments(cwd, token) {
  const payload = parseJson(run("railway", ["environment", "list", "--json"], { cwd, env: railwayEnv(token), label: "Railway environment list" }), "Railway environment list");
  return parseRailwayEnvironmentInventory(payload);
}

function createRailwayApiService(cwd, state, journalPath, token) {
  provisionRailwayApiService({
    projectId: process.env.RAILWAY_PROJECT_ID,
    environmentId: state.railwayEnvironmentId,
    environmentName: state.railwayEnvironment,
    apiServiceId: process.env.RAILWAY_API_SERVICE_ID,
    listEnvironments: () => listRailwayEnvironments(cwd, token),
    recordIntent: (intent) => updateJournal(journalPath, state, {
      resourceIntent: { ...(state.resourceIntent || {}), railwayServices: intent },
      status: "railway-api-creating",
    }),
    commitPatch: ({ query, variables }) => {
      const command = buildRailwayApiCommand(query, variables);
      return run("railway", command.args, { cwd, input: command.input, env: railwayEnv(token), label: "Railway preview API create" });
    },
    readConfig: () => parseJson(run("railway", ["environment", "config", "--environment", state.railwayEnvironmentId, "--json"], { cwd, env: railwayEnv(token), label: "Railway preview API inventory" }), "Railway preview API inventory"),
  });
  updateJournal(journalPath, state, { status: "railway-api-created" });
}

function setRailwayVariable(name, value, service, environment, project, token) {
  run("railway", ["variable", "set", name, "--stdin", "--skip-deploys", "--service", service, "--environment", environment, "--project", project], {
    input: value,
    env: railwayEnv(token),
    label: `Railway variable ${name}`,
  });
}

function releaseMetadata(root, sha) {
  const output = run(process.execPath, ["scripts/release-metadata.mjs", sha], { cwd: root, env: minimalEnv(), label: "Release metadata" });
  return Object.fromEntries(output.split(/\r?\n/).map((line) => line.split("=")).filter(([key, val]) => key && val));
}

function vercelScopeArgs() {
  return ["--scope", process.env.VERCEL_SCOPE];
}

function bindVercelProject(sourceRoot) {
  if (!/^team_[A-Za-z0-9]+$/.test(process.env.VERCEL_ORG_ID || "")) throw new Error("VERCEL_ORG_ID has an invalid shape");
  const directory = join(sourceRoot, "frontend", ".vercel");
  const link = { projectId: process.env.VERCEL_PROJECT_ID, orgId: process.env.VERCEL_ORG_ID, projectName: process.env.VERCEL_PROJECT_NAME };
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "project.json"), `${JSON.stringify(link)}\n`, { encoding: "utf8", mode: 0o600 });
  return link;
}

function listVercelReleases(sha, releaseId, environment) {
  const output = run("vercel", ["list", process.env.VERCEL_PROJECT_NAME, "--meta", `githubCommitSha=${sha}`, "--meta", `parkdexReleaseId=${releaseId}`, "--meta", `parkdexEnvironment=${environment}`, "--yes", ...vercelScopeArgs()], { env: vercelEnv(process.env.VERCEL_TOKEN), label: "Vercel deployment list" });
  const urls = [...new Set(output.match(/[a-zA-Z0-9][a-zA-Z0-9-]*\.vercel\.app/g) || [])];
  return urls.map((host) => {
    const data = parseJson(run("vercel", ["inspect", host, "--json", ...vercelScopeArgs()], { env: vercelEnv(process.env.VERCEL_TOKEN), label: "Vercel deployment inspect" }), "Vercel deployment inspect");
    return { ...data, url: `https://${data.url}` };
  }).filter((item) => item.name === process.env.VERCEL_PROJECT_NAME && /^dpl_[A-Za-z0-9]+$/.test(item.id || ""));
}

function inspectVercelDeploymentById(deploymentId, { allowMissing = false } = {}) {
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId || "")) throw new Error("Vercel deployment ID was invalid");
  const provider = buildProviderProcess("vercel", ["inspect", deploymentId, "--json", ...vercelScopeArgs()]);
  const result = spawnSync(provider.executable, provider.args, { env: vercelEnv(process.env.VERCEL_TOKEN), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const diagnostic = sanitizeProviderDiagnostic(`${result.stderr || ""}\n${result.stdout || ""}`);
    if (allowMissing && /Can't find the deployment/.test(diagnostic)) return null;
    throw new Error("Vercel deployment inspection failed");
  }
  return parseJson(result.stdout, "Vercel deployment inspect");
}

function findVercelRelease(sha, releaseId, environment) {
  const matches = listVercelReleases(sha, releaseId, environment);
  if (matches.length !== 1 || !matches[0].url) throw new Error("Vercel deployment could not be recovered exactly");
  return matches[0].url;
}

function verifyVercelDeployment(url, sha, releaseId, environment, expectedTarget) {
  const parsed = new URL(url);
  const host = parsed.host;
  if (parsed.protocol !== "https:" || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.vercel\.app$/.test(host)) throw new Error("Vercel returned an invalid deployment URL");
  const matches = listVercelReleases(sha, releaseId, environment).filter((item) => new URL(item.url).host === host);
  if (matches.length !== 1 || matches[0].readyState !== "READY" || matches[0].target !== expectedTarget) {
    throw new Error("Vercel deployment identity was not verified");
  }
  return { id: matches[0].id, url: new URL(matches[0].url).origin };
}

async function verifyBrowserCors(apiUrl, frontendUrl) {
  const origin = new URL(frontendUrl).origin;
  const response = await fetch(`${apiUrl}/api/places`, {
    headers: { Origin: origin },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Browser CORS GET returned HTTP ${response.status}`);
  verifyCorsHeaders(response.headers, origin);
  const verifyPreflight = async (method, requestedHeaders) => {
    const preflight = await fetch(`${apiUrl}/api/places`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": requestedHeaders.join(","),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!preflight.ok) throw new Error(`Browser CORS ${method} preflight returned HTTP ${preflight.status}`);
    verifyCorsHeaders(preflight.headers, origin, { method, requestedHeaders });
  };
  await verifyPreflight("GET", ["authorization"]);
  await verifyPreflight("PUT", ["content-type", "x-collection-key"]);
}

const wait = (delay) => new Promise((resolveWait) => setTimeout(resolveWait, delay));

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function verifyRailwayDeployments(state, token, message) {
  const deployments = parseJson(run("railway", ["deployment", "list", "--json", "--service", process.env.RAILWAY_API_SERVICE_ID, "--environment", state.railwayEnvironmentId, "--project", process.env.RAILWAY_PROJECT_ID], { env: railwayEnv(token), label: "Railway API deployment list" }), "Railway API deployment list");
  verifyRailwayDeploymentResult(deployments, message);
}

async function waitForRailwayApi(apiUrl, commitSha, releaseId) {
  const delays = [0, 2, 4, 8, 12, 20, 30, 30, 30, 30, 30, 30];
  for (const seconds of delays) {
    if (seconds) await wait(seconds * 1000);
    try {
      verifyReadyPayload(await fetchJson(`${apiUrl}/ready`), commitSha, releaseId);
      return;
    } catch {}
  }
  throw new Error("Railway API never reported the exact local release ready");
}

async function smokeCatalogue(apiUrl) {
  const collectionKey = randomBytes(32).toString("base64url");
  const secondCollectionKey = randomBytes(32).toString("base64url");
  const catalogue = await fetchJson(`${apiUrl}/api/places`);
  const placeId = catalogue?.places?.[0]?.id;
  if (!placeId || catalogue.places.length < 1) throw new Error("Preview catalogue was empty");
  catalogueVisitedIds(catalogue);
  const visit = (key, visited) => fetchJson(`${apiUrl}/api/visits/${encodeURIComponent(placeId)}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Collection-Key": key }, body: JSON.stringify({ visited }) });
  const guestCollection = (key) => fetchJson(`${apiUrl}/api/places`, { headers: key ? { "X-Collection-Key": key } : {} });
  try {
    const cleared = await visit(collectionKey, false);
    if (cleared?.visited !== false || cleared?.placeId !== placeId) throw new Error("Preview visit cleanup was not verified");
    // Guest creation is deliberately forbidden after location claims launched.
    const rejected = await fetch(`${apiUrl}/api/visits/${encodeURIComponent(placeId)}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Collection-Key": collectionKey }, body: JSON.stringify({ visited: true }), signal: AbortSignal.timeout(20_000) });
    verifyGuestVisitRejection(rejected.status, await rejected.json());
    verifyUnvisitedCatalogues(placeId, await Promise.all([guestCollection(), guestCollection(collectionKey), guestCollection(secondCollectionKey)]));
  } finally {
    try { await visit(collectionKey, false); } catch {}
  }
}

function verifyFrontendContent(sourceRoot, frontendUrl) {
  const binding = parseJson(readFileSync(join(sourceRoot, "frontend", ".vercel", "project.json"), "utf8"), "Vercel project binding");
  if (binding.projectId !== process.env.VERCEL_PROJECT_ID || binding.orgId !== process.env.VERCEL_ORG_ID || binding.projectName !== process.env.VERCEL_PROJECT_NAME) throw new Error("Vercel project binding identity was not verified");
  const directory = mkdtempSync(join(tmpdir(), "parkdex-vercel-verify-"));
  try {
    for (const [route, filename] of [["/", "page.html"], ["/maplibre/maplibre-gl-worker.mjs", "worker.mjs"], ["/maplibre/maplibre-gl-shared.mjs", "shared.mjs"]]) {
      const outputPath = join(directory, filename);
      run("vercel", buildVercelCurlArgs(route, frontendUrl, process.env.VERCEL_SCOPE, outputPath), { cwd: sourceRoot, env: vercelEnv(process.env.VERCEL_TOKEN), label: `Vercel protected content ${route}` });
      const content = readFileSync(outputPath);
      if (!content.length || (route === "/" && !content.toString("utf8").includes("<title>Parkdex"))) throw new Error(`Preview frontend content ${route} was not verified`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function verifyPreviewResourcesAbsent(root, state, journalPath) {
  const context = railwayContext(process.env.RAILWAY_PROJECT_ID, process.env.RAILWAY_BASE_ENVIRONMENT_ID, process.env.RAILWAY_API_TOKEN);
  try {
    const hasUnresolvedCreateIntent = Boolean(
      (state.resourceIntent?.vercel && !state.vercelDeploymentId)
      || (state.resourceIntent?.railway && !state.railwayEnvironmentId)
      || (state.resourceIntent?.neon && !state.neonBranchId)
    );
    const confirmation = await confirmStablePreviewAbsence({
      state,
      minimumGraceMs: hasUnresolvedCreateIntent ? 30_000 : 10_000,
      wait,
      readInventories: async () => {
        const exactVercel = state.vercelDeploymentId ? inspectVercelDeploymentById(state.vercelDeploymentId, { allowMissing: true }) : null;
        const vercelDeployments = state.vercelDeploymentId ? (exactVercel ? [exactVercel] : []) : listVercelReleases(state.commitSha, state.releaseId, state.railwayEnvironment);
        const railwayEnvironments = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN);
        const neonBranches = exactNeonBranchInventory(root, state);
        return { vercelDeployments, railwayEnvironments, neonBranches };
      },
    });
    const verifiedAt = new Date().toISOString();
    updateJournal(journalPath, state, {
      absenceVerification: {
        verifiedAt,
        observations: confirmation.observations,
        consecutiveEmptyInventories: confirmation.consecutiveEmpty,
        elapsedMs: confirmation.elapsedMs,
        vercel: { deploymentId: state.vercelDeploymentId || null, absent: true },
        railway: { environmentId: state.railwayEnvironmentId || null, environmentName: state.railwayEnvironment, absent: true },
        neon: { branchId: state.neonBranchId || null, branchName: state.neonBranch, absent: true },
      },
      status: "cleanup-verified-absent",
    });
    return verifiedAt;
  } catch (error) {
    const unresolved = error.unresolved || ["provider inventory verification"];
    const cleanup = { ...(state.cleanup || {}) };
    if (unresolved.includes("Vercel deployment")) cleanup.vercel = false;
    if (unresolved.includes("Railway environment")) cleanup.railway = false;
    if (unresolved.includes("Neon branch")) cleanup.neon = false;
    updateJournal(journalPath, state, { cleanup, cleanupRemaining: unresolved, status: "cleanup-incomplete" });
    throw error;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

async function cleanup(root, journalPath) {
  if (!journalPath || !existsSync(journalPath)) throw new Error("Cleanup requires an explicit existing --journal path");
  const state = parseJson(readFileSync(journalPath, "utf8"), "Release journal");
  if (!["parkdex.local-release/v3", "parkdex.local-release/v4"].includes(state.schema) || state.mode !== "preview" || !/^lp-pr-[0-9]{1,6}-[0-9a-f]{8}-[0-9a-f]{8}$/.test(state.railwayEnvironment || "") || state.neonBranch !== `preview/${state.railwayEnvironment}`) {
    throw new Error("Release journal is not an owned preview");
  }
  requireEnv(["RAILWAY_PROJECT_ID", "RAILWAY_BASE_ENVIRONMENT_ID", "RAILWAY_API_SERVICE_ID", "NEON_ORG_ID", "NEON_PROJECT_ID", "VERCEL_SCOPE", "VERCEL_ORG_ID", "VERCEL_PROJECT_NAME", "VERCEL_PROJECT_ID"]);
  if (state.providerProjects && (state.providerProjects.railway !== process.env.RAILWAY_PROJECT_ID || state.providerProjects.neon !== process.env.NEON_PROJECT_ID || state.providerProjects.vercel !== process.env.VERCEL_PROJECT_ID || state.providerProjects.vercelOrg !== process.env.VERCEL_ORG_ID)) throw new Error("Cleanup provider project identities do not match the release journal");
  providerPreflight(root, true);
  if (!state.railwayEnvironmentId) {
    const context = railwayContext(process.env.RAILWAY_PROJECT_ID, process.env.RAILWAY_BASE_ENVIRONMENT_ID, process.env.RAILWAY_API_TOKEN);
    try {
      const matches = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN).filter((item) => item.name === state.railwayEnvironment);
      if (matches.length > 1) throw new Error("Multiple Railway environments matched the journal identity");
      if (matches.length === 1) updateJournal(journalPath, state, { railwayEnvironmentId: matches[0].id, status: "cleanup-recovered" });
      else if (state.resourceIntent?.railway?.createFailure === "invalid-name") {
        const verifiedAt = [];
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
          const repeated = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN).filter((item) => item.name === state.railwayEnvironment);
          if (repeated.length > 1) throw new Error("Multiple Railway environments matched the journal identity");
          if (repeated.length === 1) {
            updateJournal(journalPath, state, { railwayEnvironmentId: repeated[0].id, status: "cleanup-recovered" });
            break;
          }
          verifiedAt.push(new Date().toISOString());
        }
        if (!state.railwayEnvironmentId) {
          updateJournal(journalPath, state, {
            cleanupIntent: { ...(state.cleanupIntent || {}), railway: { projectId: process.env.RAILWAY_PROJECT_ID, environmentName: state.railwayEnvironment, completeInventories: verifiedAt } },
            cleanup: { ...(state.cleanup || {}), railway: true },
            status: "cleanup-verified-absent",
          });
        }
      }
    } finally { rmSync(context, { recursive: true, force: true }); }
  }
  if (!state.neonBranchId) {
    const base = `/projects/${process.env.NEON_PROJECT_ID}`;
    const listing = neonApi(root, `${base}/branches`, { query: { limit: 1000 } });
    const matches = (listing.branches || []).filter((item) => item.name === state.neonBranch);
    if (matches.length > 1) throw new Error("Multiple Neon branches matched the journal identity");
    if (matches.length === 1) {
      const detailsData = neonApi(root, `${base}/branches/${matches[0].id}`);
      const details = detailsData.branch || detailsData;
      const annotations = neonAnnotations(detailsData);
      if (annotations["parkdex-release-id"] !== state.releaseId || annotations["parkdex-commit"] !== state.commitSha || annotations["parkdex-environment"] !== state.railwayEnvironment) throw new Error("Recovered Neon branch provenance did not match the journal");
      updateJournal(journalPath, state, { neonBranchId: matches[0].id, status: "cleanup-recovered" });
    }
  }
  if (!state.vercelDeploymentId) {
    const matches = await listVercelReleases(state.commitSha, state.releaseId, state.railwayEnvironment);
    if (matches.length > 1) throw new Error("Multiple Vercel deployments matched the journal identity");
    if (matches.length === 1) updateJournal(journalPath, state, { vercelDeploymentId: matches[0].id, status: "cleanup-recovered" });
  }
  const deletionErrors = [];
  if (state.vercelDeploymentId && !state.cleanup?.vercel) {
    try {
      const matches = listVercelReleases(state.commitSha, state.releaseId, state.railwayEnvironment).filter((item) => item.id === state.vercelDeploymentId);
      if (matches.length === 0 && state.cleanupIntent?.vercel) updateJournal(journalPath, state, { cleanup: { ...(state.cleanup || {}), vercel: true } });
      else if (matches.length !== 1 || matches[0].target !== "preview") throw new Error("Vercel cleanup ownership verification failed");
      else {
        updateJournal(journalPath, state, { cleanupIntent: { ...(state.cleanupIntent || {}), vercel: true } });
        run("vercel", ["remove", state.vercelDeploymentId, "--safe", "--yes", ...vercelScopeArgs()], { env: vercelEnv(process.env.VERCEL_TOKEN), label: "Vercel deployment delete" });
      }
      updateJournal(journalPath, state, { cleanup: { ...(state.cleanup || {}), vercel: true } });
    } catch (error) { deletionErrors.push(`Vercel: ${error.message}`); }
  }
  if (state.railwayEnvironmentId && !state.cleanup?.railway) {
    let context;
    try {
      context = railwayContext(process.env.RAILWAY_PROJECT_ID, process.env.RAILWAY_BASE_ENVIRONMENT_ID, process.env.RAILWAY_API_TOKEN);
      const matches = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN).filter((item) => item.id === state.railwayEnvironmentId && item.name === state.railwayEnvironment);
      if (matches.length === 0 && state.cleanupIntent?.railway) updateJournal(journalPath, state, { cleanup: { ...(state.cleanup || {}), railway: true } });
      else if (matches.length !== 1) throw new Error("Railway cleanup ownership verification failed");
      else {
        updateJournal(journalPath, state, { cleanupIntent: { ...(state.cleanupIntent || {}), railway: true } });
        run("railway", ["environment", "delete", state.railwayEnvironmentId, "--yes"], { cwd: context, env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway environment delete" });
      }
      updateJournal(journalPath, state, { cleanup: { ...(state.cleanup || {}), railway: true } });
    } catch (error) { deletionErrors.push(`Railway: ${error.message}`); }
    finally { if (context) rmSync(context, { recursive: true, force: true }); }
  }
  if (state.neonBranchId && !state.cleanup?.neon) {
    try {
      const base = `/projects/${process.env.NEON_PROJECT_ID}`;
      const listing = neonApi(root, `${base}/branches`, { query: { limit: 1000 } });
      const matches = (listing.branches || []).filter((branch) => branch.id === state.neonBranchId && branch.name === state.neonBranch);
      if (matches.length === 0 && state.cleanupIntent?.neon) updateJournal(journalPath, state, { cleanup: { ...(state.cleanup || {}), neon: true } });
      else if (matches.length !== 1) throw new Error("Neon cleanup ownership verification failed");
      else {
        const data = neonApi(root, `${base}/branches/${state.neonBranchId}`);
        const branch = data.branch || data;
        const annotations = neonAnnotations(data);
        if (annotations["parkdex-release-id"] !== state.releaseId || annotations["parkdex-commit"] !== state.commitSha || annotations["parkdex-environment"] !== state.railwayEnvironment) throw new Error("Neon cleanup ownership verification failed");
        updateJournal(journalPath, state, { cleanupIntent: { ...(state.cleanupIntent || {}), neon: true } });
        neonApi(root, `${base}/branches/${state.neonBranchId}`, { method: "DELETE" });
      }
      updateJournal(journalPath, state, { cleanup: { ...(state.cleanup || {}), neon: true } });
    } catch (error) { deletionErrors.push(`Neon: ${error.message}`); }
  }
  let absenceVerifiedAt;
  try {
    absenceVerifiedAt = await verifyPreviewResourcesAbsent(root, state, journalPath);
  } catch (error) {
    updateJournal(journalPath, state, { deletionErrors: [...deletionErrors, `Verification: ${error.message}`], status: "cleanup-incomplete" });
    throw error;
  }
  updateJournal(journalPath, state, { status: "cleaned", cleanedAt: new Date().toISOString(), absenceVerifiedAt });
  console.log(`local-release cleanup=success journal=${journalPath}`);
}

async function deploy(root, mode, sha, journalPath, releaseId, pullRequest, harnessSha, sourceAuthorization) {
  const preview = mode === "preview";
  const railwayEnvironment = preview ? buildPreviewEnvironmentName(pullRequest, sha, releaseId) : "staging";
  const persistentStagingEnvironmentId = process.env.RAILWAY_STAGING_ENVIRONMENT_ID || null;
  const neonBranch = preview ? `preview/${railwayEnvironment}` : null;
  const expiresAt = preview ? new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  const state = { schema: "parkdex.local-release/v4", mode, status: "planned", releaseId, harnessSha, commitSha: sha, sourceAuthorization, providerProjects: { railway: process.env.RAILWAY_PROJECT_ID || null, neon: preview ? process.env.NEON_PROJECT_ID || null : null, vercel: process.env.VERCEL_PROJECT_ID || null, vercelOrg: process.env.VERCEL_ORG_ID || null }, pullRequest: pullRequest || null, railwayEnvironment, railwayEnvironmentId: preview ? null : persistentStagingEnvironmentId, neonBranch, neonBranchId: null, neonEndpointId: null, neonDatabaseId: null, neonDatabaseName: null, vercelDeploymentId: null, vercelOrgId: null, frontendUrl: null, apiUrl: null, expiresAt, resourceIntent: {}, cleanupIntent: {}, cleanup: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const safety = preview ? ["trusted clean staging harness", "attested exact source SHA", "no environment copy", "journal before mutation", "exact source and release id", "provider-owned cleanup"] : ["trusted clean staging harness", "attested exact reviewed PR head", "persistent staging only", "preserve provider configuration", "manual production boundary"];
  const plan = { mode, harnessSha, commitSha: sha, releaseId, railwayEnvironment, neonBranch, journalPath, apply: flag("--apply"), safety };
  if (!flag("--apply")) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (!value("--sha")) throw new Error("--apply requires an explicit full --sha");
  if (resolve(journalPath).startsWith(`${resolve(root)}\\`) || resolve(journalPath).startsWith(`${resolve(root)}/`)) throw new Error("Release journals must be stored outside the repository");
  if (existsSync(journalPath)) throw new Error("Refusing to overwrite an existing release journal");
  const common = ["RAILWAY_PROJECT_ID", "RAILWAY_API_SERVICE_ID", "VERCEL_SCOPE", "VERCEL_ORG_ID", "VERCEL_PROJECT_NAME", "VERCEL_PROJECT_ID"];
  requireEnv(preview ? [...common, "RAILWAY_BASE_ENVIRONMENT_ID", "NEON_ORG_ID", "NEON_PROJECT_ID", "NEON_PARENT_BRANCH"] : common);
  if (!preview && !persistentStagingEnvironmentId) throw new Error("Missing required environment variable: RAILWAY_STAGING_ENVIRONMENT_ID");
  providerPreflight(root, preview, { enforceEmptyVercelPreview: preview });
  atomicJournal(journalPath, state);
  const metadata = releaseMetadata(root, sha);
  const sourceRoot = mkdtempSync(join(tmpdir(), "parkdex-release-source-"));
  git(root, ["worktree", "add", "--detach", sourceRoot, sha]);
  let database;
  try {
    if (preview) {
      database = await createNeonBranch(root, state, journalPath);
      const databaseEnv = { PREVIEW_DATABASE_URL: database.pooled, PREVIEW_DATABASE_URL_UNPOOLED: database.direct, PREVIEW_DATABASE_NAME: database.databaseName, PREVIEW_DATABASE_HOST: database.directHost, RAILWAY_ENVIRONMENT_NAME: railwayEnvironment };
      run("python", [join(sourceRoot, "scripts", "verify_preview_database.py"), "--phase", "empty"], { cwd: sourceRoot, env: minimalEnv(databaseEnv), label: "Preview database zero-row gate" });
      updateJournal(journalPath, state, { resourceIntent: { ...(state.resourceIntent || {}), neonDatabaseInitialization: { branchId: state.neonBranchId, databaseId: state.neonDatabaseId, databaseName: database.databaseName } }, status: "database-initializing" });
      run("python", ["-m", "backend.app.migrate"], { cwd: sourceRoot, env: minimalEnv(databaseEnv), label: "Preview database migrations" });
      run("python", ["-m", "backend.app.migrate"], { cwd: sourceRoot, env: minimalEnv(databaseEnv), label: "Preview database migration idempotency" });
      run("python", [join(sourceRoot, "scripts", "verify_preview_database.py"), "--phase", "migrated"], { cwd: sourceRoot, env: minimalEnv(databaseEnv), label: "Preview database isolation and catalogue gate" });
      updateJournal(journalPath, state, { status: "database-verified" });
    }
    const context = railwayContext(process.env.RAILWAY_PROJECT_ID, preview ? process.env.RAILWAY_BASE_ENVIRONMENT_ID : persistentStagingEnvironmentId, process.env.RAILWAY_API_TOKEN);
    try {
      const environments = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN);
      if (preview) {
        if (environments.some((item) => item.name === railwayEnvironment)) throw new Error("Refusing to adopt an existing Railway preview environment");
        const createEnvironmentArgs = ["environment", "new", railwayEnvironment, "--json"];
        updateJournal(journalPath, state, { resourceIntent: { ...(state.resourceIntent || {}), railway: { environmentName: railwayEnvironment, releaseId } }, status: "railway-creating" });
        try {
          run("railway", createEnvironmentArgs, { cwd: context, env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway environment create" });
        } catch (error) {
          const recovered = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN).filter((item) => item.name === railwayEnvironment);
          const createFailure = classifyRailwayEnvironmentCreateFailure(error.providerStderr);
          if (recovered.length === 0 && createFailure !== "unknown") {
            updateJournal(journalPath, state, { resourceIntent: { ...(state.resourceIntent || {}), railway: { ...state.resourceIntent.railway, createFailure } } });
          }
          if (recovered.length !== 1) throw error;
        }
        const matches = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN).filter((item) => item.name === railwayEnvironment);
        if (matches.length !== 1) throw new Error("Railway preview environment identity was not verified");
        state.railwayEnvironmentId = matches[0].id;
        updateJournal(journalPath, state, { railwayEnvironmentId: matches[0].id, status: "railway-created" });
        createRailwayApiService(context, state, journalPath, process.env.RAILWAY_API_TOKEN);
      } else if (!environments.some((item) => item.id === state.railwayEnvironmentId && item.name === "staging")) throw new Error("Railway staging environment identity was not verified");
    } finally { rmSync(context, { recursive: true, force: true }); }
    const railwayArgs = ["--project", process.env.RAILWAY_PROJECT_ID, "--environment", state.railwayEnvironmentId, "--service", process.env.RAILWAY_API_SERVICE_ID, "--json"];
    let domains = parseJson(run("railway", ["domain", "list", ...railwayArgs], { env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway domain list" }), "Railway domains");
    const generatedDomains = [...new Set(JSON.stringify(domains).match(/[a-zA-Z0-9][a-zA-Z0-9-]*\.up\.railway\.app/g) || [])];
    let domain = preview ? generatedDomains[0] : STAGING_API_HOST;
    if (preview && !domain) {
      updateJournal(journalPath, state, { resourceIntent: { ...(state.resourceIntent || {}), railwayDomain: { environmentId: state.railwayEnvironmentId, serviceId: process.env.RAILWAY_API_SERVICE_ID } }, status: "railway-domain-creating" });
      run("railway", ["domain", "--port", "8080", ...railwayArgs], { env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway domain create" });
      domains = parseJson(run("railway", ["domain", "list", ...railwayArgs], { env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway domain list" }), "Railway domains");
      domain = JSON.stringify(domains).match(/[a-zA-Z0-9][a-zA-Z0-9-]*\.up\.railway\.app/)?.[0];
    }
    if (!domain || (!preview && generatedDomains.length !== 1)) throw new Error("Railway API domain was not verified");
    state.apiUrl = `https://${domain}`;
    updateJournal(journalPath, state, { status: "frontend-creating" });
    const vercelLink = bindVercelProject(sourceRoot);
    updateJournal(journalPath, state, { vercelOrgId: vercelLink.orgId, status: "frontend-linked" });
    let deploymentUrl;
    try {
      updateJournal(journalPath, state, { resourceIntent: { ...(state.resourceIntent || {}), vercel: { projectId: process.env.VERCEL_PROJECT_ID, commitSha: sha, releaseId, environment: railwayEnvironment } }, status: "vercel-creating" });
      const targetArgs = preview ? ["--target", "preview"] : ["--prod"];
      const deployOutput = run("vercel", ["deploy", "--yes", ...targetArgs, "--skip-domain", "--cwd", "frontend", "--build-env", `NEXT_PUBLIC_API_BASE_URL=${state.apiUrl}`, "--build-env", `NEXT_PUBLIC_APP_URL=${preview ? "https://web.parkdex.app" : STAGING_FRONTEND_ORIGIN}`, "--build-env", `NEXT_PUBLIC_RELEASE_VERSION=${metadata.version}`, "--build-env", `NEXT_PUBLIC_COMMIT_SHA=${sha}`, "--build-env", `NEXT_PUBLIC_COMMIT_DATE=${metadata.commit_date}`, "--meta", `githubCommitSha=${sha}`, "--meta", `parkdexReleaseId=${releaseId}`, "--meta", `parkdexEnvironment=${railwayEnvironment}`, ...vercelScopeArgs()], { cwd: sourceRoot, env: vercelEnv(process.env.VERCEL_TOKEN), label: "Vercel deploy" });
      deploymentUrl = deployOutput.split(/\r?\n/).findLast((line) => /^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/.test(line.trim()))?.trim();
    } catch {
      deploymentUrl = await findVercelRelease(sha, releaseId, railwayEnvironment);
    }
    if (!deploymentUrl) deploymentUrl = await findVercelRelease(sha, releaseId, railwayEnvironment);
    const vercel = await verifyVercelDeployment(deploymentUrl, sha, releaseId, railwayEnvironment, preview ? "preview" : "production");
    state.frontendUrl = preview ? vercel.url : STAGING_FRONTEND_ORIGIN;
    updateJournal(journalPath, state, { vercelDeploymentId: vercel.id, frontendUrl: state.frontendUrl, apiUrl: state.apiUrl, status: "frontend-created" });
    const variables = preview
      ? [["PREVIEW_DATABASE_URL", database.pooled], ["PREVIEW_DATABASE_URL_UNPOOLED", database.direct], ["RAILWAY_ENVIRONMENT_NAME", railwayEnvironment], ["APP_COMMIT_SHA", sha], ["APP_RELEASE_ID", releaseId]]
      : [["APP_COMMIT_SHA", sha], ["APP_RELEASE_ID", releaseId]];
    for (const [name, val] of variables) setRailwayVariable(name, val, process.env.RAILWAY_API_SERVICE_ID, state.railwayEnvironmentId, process.env.RAILWAY_PROJECT_ID, process.env.RAILWAY_API_TOKEN);
    if (preview) for (const [name, val] of [
      ["FRONTEND_ORIGINS", state.frontendUrl],
      ["APP_PUBLIC_URL", state.frontendUrl],
      ["API_PUBLIC_URL", state.apiUrl],
      ["MCP_PUBLIC_URL", `${state.apiUrl}/mcp`],
    ]) setRailwayVariable(name, val, process.env.RAILWAY_API_SERVICE_ID, state.railwayEnvironmentId, process.env.RAILWAY_PROJECT_ID, process.env.RAILWAY_API_TOKEN);
    updateJournal(journalPath, state, { status: "configured" });
    const message = `local-release ${releaseId} commit ${sha}`;
    const marker = join(sourceRoot, "backend", ".local-release-source-sha");
    writeFileSync(marker, `${sha} ${releaseId}`, "utf8");
    run("railway", ["up", "--ci", "--yes", "--message", message, "--service", process.env.RAILWAY_API_SERVICE_ID, "--environment", state.railwayEnvironmentId, "--project", process.env.RAILWAY_PROJECT_ID], { cwd: sourceRoot, env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway API deploy" });
    verifyRailwayDeployments(state, process.env.RAILWAY_API_TOKEN, message);
    await waitForRailwayApi(state.apiUrl, sha, releaseId);
    await verifyBrowserCors(state.apiUrl, state.frontendUrl);
    await smokeCatalogue(state.apiUrl);
    verifyFrontendContent(sourceRoot, vercel.url);
    if (!preview) run("vercel", ["alias", "set", vercel.url, "staging.web.parkdex.app", ...vercelScopeArgs()], { cwd: sourceRoot, env: vercelEnv(process.env.VERCEL_TOKEN), label: "Vercel staging alias" });
    updateJournal(journalPath, state, { status: "ready", readyAt: new Date().toISOString() });
    console.log(`local-release status=ready mode=${mode} sha=${sha} journal=${journalPath}`);
  } catch (error) {
    if (existsSync(journalPath)) updateJournal(journalPath, state, { status: "failed", failure: error.message });
    throw error;
  } finally {
    const normalizedSourceRoot = resolve(sourceRoot).replaceAll("\\", "/").toLowerCase();
    finalizeReleaseSourceCleanup({
      sourceRoot,
      removeWorktree: () => run("git", ["worktree", "remove", "--force", sourceRoot], { cwd: root, label: "git worktree remove" }),
      removeDirectory: () => rmSync(sourceRoot, { recursive: true, force: true }),
      pruneWorktrees: () => run("git", ["worktree", "prune"], { cwd: root, label: "git worktree prune" }),
      sourceExists: existsSync,
      sourceRegistered: () => git(root, ["worktree", "list", "--porcelain"]).split(/\r?\n/).some((line) => line.startsWith("worktree ") && line.slice(9).replaceAll("\\", "/").toLowerCase() === normalizedSourceRoot),
    });
  }
}

const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
const actualSha = git(root, ["rev-parse", "HEAD"]);
const expectedSha = value("--sha", actualSha);
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error("Refusing a non-full source commit SHA");
if (git(root, ["status", "--porcelain"])) throw new Error("Refusing a dirty worktree");
const mode = value("--mode", "staging").toLowerCase();
if (!["preview", "staging", "cleanup"].includes(mode)) throw new Error("--mode must be preview, staging, or cleanup");
const pullRequest = Number(value("--pr", "0"));
if (mode !== "cleanup" && flag("--apply") && (!Number.isInteger(pullRequest) || pullRequest < 1 || pullRequest > 999999)) throw new Error("Candidate apply requires a valid --pr number");
const releaseId = value("--release-id", randomUUID());
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(releaseId)) throw new Error("--release-id must be a version-4 UUID");
const defaultRoot = process.env.LOCALAPPDATA || tmpdir();
const journalPath = resolve(value("--journal", join(defaultRoot, "Parkdex", "release-journal", `${releaseId}.json`)));

if (mode === "cleanup" && !flag("--apply")) throw new Error("Cleanup requires explicit --apply");
if (mode === "cleanup") {
  if (!value("--journal") || !existsSync(journalPath)) throw new Error("Cleanup requires its exact existing release journal");
  trustedHarness(root);
  await cleanup(root, journalPath);
} else if (flag("--apply")) {
  if (!value("--sha") || !value("--attestation") || !value("--head-ref")) throw new Error("Candidate apply requires explicit --sha, --head-ref, and --attestation");
  const harnessSha = trustedHarness(root);
  const authorization = verifyCandidateAuthorization(root, harnessSha, expectedSha, pullRequest, value("--head-ref"), value("--attestation"), { requireDraft: mode === "preview" });
  await deploy(root, mode, expectedSha, journalPath, releaseId, pullRequest, harnessSha, authorization);
} else {
  await deploy(root, mode, expectedSha, journalPath, releaseId, pullRequest, actualSha, null);
}
