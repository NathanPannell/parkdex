#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const value = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(name);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${options.label || command} failed with exit ${result.status ?? "spawn"}`);
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

function findNamedObjects(node, output = []) {
  if (Array.isArray(node)) for (const item of node) findNamedObjects(item, output);
  else if (node && typeof node === "object") {
    if (typeof node.id === "string" && typeof node.name === "string") output.push(node);
    for (const item of Object.values(node)) findNamedObjects(item, output);
  }
  return output;
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON`); }
}

function railwayEnv(token, extra = {}) {
  return minimalEnv({ RAILWAY_API_TOKEN: token, ...extra });
}

function vercelEnv(token, extra = {}) {
  return minimalEnv({ VERCEL_TOKEN: token, VERCEL_ORG_ID: process.env.VERCEL_ORG_ID, VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID, ...extra });
}

async function providerJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  const body = text ? parseJson(text, "Provider API") : {};
  if (!response.ok) throw new Error(`Provider API request failed with HTTP ${response.status}`);
  return body;
}

async function createNeonBranch(state, journalPath) {
  const project = process.env.NEON_PROJECT_ID;
  const token = process.env.NEON_API_KEY;
  const base = `https://console.neon.tech/api/v2/projects/${project}`;
  const listing = await providerJson(`${base}/branches?limit=1000`, token);
  const parent = (listing.branches || []).filter((branch) => branch.name === process.env.NEON_PARENT_BRANCH);
  if (parent.length !== 1) throw new Error("Neon parent branch was not resolved exactly");
  if ((listing.branches || []).some((branch) => branch.name === state.neonBranch)) throw new Error("Refusing to adopt an existing Neon preview branch");
  let branch;
  try {
    const created = await providerJson(`${base}/branches`, token, {
      method: "POST",
      body: JSON.stringify({
        branch: { name: state.neonBranch, parent_id: parent[0].id, init_source: "parent-schema", expires_at: state.expiresAt },
        endpoints: [{ type: "read_write" }],
        annotation_value: { "parkdex-release-id": state.releaseId, "parkdex-commit": state.commitSha, "parkdex-environment": state.railwayEnvironment },
      }),
    });
    branch = created.branch;
  } catch (error) {
    const recovered = await providerJson(`${base}/branches?limit=1000`, token);
    const matches = (recovered.branches || []).filter((item) => item.name === state.neonBranch);
    if (matches.length !== 1) throw error;
    branch = matches[0];
  }
  if (!branch?.id || branch.name !== state.neonBranch) throw new Error("Neon branch creation identity was not verified");
  const detailsData = await providerJson(`${base}/branches/${branch.id}`, token);
  const details = detailsData.branch || detailsData;
  const annotations = details?.annotation_value || details?.annotations || {};
  if (details?.name !== state.neonBranch || details?.init_source !== "parent-schema" || (details?.parent_id != null && details.parent_id !== parent[0].id) || annotations["parkdex-release-id"] !== state.releaseId || annotations["parkdex-commit"] !== state.commitSha || annotations["parkdex-environment"] !== state.railwayEnvironment) throw new Error("Neon branch provenance was not verified");
  updateJournal(journalPath, state, { neonBranchId: branch.id, status: "neon-created" });
  const connection = async (pooled) => {
    const query = new URLSearchParams({ branch_id: branch.id, database_name: "app", role_name: "app_owner", pooled: String(pooled) });
    return (await providerJson(`${base}/connection_uri?${query}`, token)).uri;
  };
  const validateUri = (uri, pooled) => {
    const parsed = new URL(uri);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname.endsWith('.neon.tech') || parsed.pathname !== '/app' || decodeURIComponent(parsed.username) !== 'app_owner' || pooled !== parsed.hostname.includes('-pooler')) throw new Error("Neon connection URI identity was not verified");
    return uri;
  };
  return { pooled: validateUri(await connection(true), true), direct: validateUri(await connection(false), false) };
}

function railwayContext(projectId, baseEnvironment, token) {
  const cwd = mkdtempSync(join(tmpdir(), "parkdex-railway-context-"));
  run("railway", ["link", "--project", projectId, "--environment", baseEnvironment], { cwd, env: railwayEnv(token), label: "Railway link" });
  return cwd;
}

function listRailwayEnvironments(cwd, token) {
  return findNamedObjects(parseJson(run("railway", ["environment", "list", "--json"], { cwd, env: railwayEnv(token), label: "Railway environment list" }), "Railway environment list"));
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

async function listVercelReleases(sha, releaseId, environment) {
  const query = new URLSearchParams({ projectId: process.env.VERCEL_PROJECT_ID, teamId: process.env.VERCEL_ORG_ID, limit: "100" });
  const listing = await providerJson(`https://api.vercel.com/v6/deployments?${query}`, process.env.VERCEL_TOKEN);
  return (listing.deployments || []).filter((item) => item.projectId === process.env.VERCEL_PROJECT_ID && item.meta?.githubCommitSha === sha && item.meta?.parkdexReleaseId === releaseId && item.meta?.parkdexEnvironment === environment);
}

async function findVercelRelease(sha, releaseId, environment) {
  const matches = await listVercelReleases(sha, releaseId, environment);
  if (matches.length !== 1 || !matches[0].url) throw new Error("Vercel deployment could not be recovered exactly");
  return `https://${matches[0].url}`;
}

async function verifyVercelDeployment(url, sha, releaseId, environment) {
  const host = new URL(url).host;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.vercel\.app$/.test(host)) throw new Error("Vercel returned an invalid deployment URL");
  const data = await providerJson(`https://api.vercel.com/v13/deployments/${host}?teamId=${process.env.VERCEL_ORG_ID}`, process.env.VERCEL_TOKEN);
  if (data.readyState !== "READY" || data.projectId !== process.env.VERCEL_PROJECT_ID || data.meta?.githubCommitSha !== sha || data.meta?.parkdexReleaseId !== releaseId || data.meta?.parkdexEnvironment !== environment || !/^dpl_[A-Za-z0-9]+$/.test(data.id || "")) {
    throw new Error("Vercel deployment identity was not verified");
  }
  return { id: data.id, url: `https://${data.url}` };
}

function callBash(root, script, env, args = []) {
  run("bash", [join(root, script), ...args], { cwd: root, env: minimalEnv(env), label: script });
}

async function cleanup(root, journalPath) {
  if (!journalPath || !existsSync(journalPath)) throw new Error("Cleanup requires an explicit existing --journal path");
  const state = parseJson(readFileSync(journalPath, "utf8"), "Release journal");
  if (state.schema !== "parkdex.local-release/v2" || state.mode !== "preview" || !/^local-pr-[0-9]+-[0-9a-f]{12}-[0-9a-f]{8}$/.test(state.railwayEnvironment || "") || state.neonBranch !== `preview/${state.railwayEnvironment}` || state.status === "cleaned") {
    throw new Error("Release journal is not an active owned preview");
  }
  requireEnv(["RAILWAY_API_TOKEN", "RAILWAY_PROJECT_ID", "RAILWAY_BASE_ENVIRONMENT_ID", "NEON_PROJECT_ID", "NEON_API_KEY", "VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]);
  if (!state.railwayEnvironmentId) {
    const context = railwayContext(process.env.RAILWAY_PROJECT_ID, process.env.RAILWAY_BASE_ENVIRONMENT_ID, process.env.RAILWAY_API_TOKEN);
    try {
      const matches = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN).filter((item) => item.name === state.railwayEnvironment);
      if (matches.length > 1) throw new Error("Multiple Railway environments matched the journal identity");
      if (matches.length === 1) updateJournal(journalPath, state, { railwayEnvironmentId: matches[0].id, status: "cleanup-recovered" });
    } finally { rmSync(context, { recursive: true, force: true }); }
  }
  if (!state.neonBranchId) {
    const base = `https://console.neon.tech/api/v2/projects/${process.env.NEON_PROJECT_ID}`;
    const listing = await providerJson(`${base}/branches?limit=1000`, process.env.NEON_API_KEY);
    const matches = (listing.branches || []).filter((item) => item.name === state.neonBranch);
    if (matches.length > 1) throw new Error("Multiple Neon branches matched the journal identity");
    if (matches.length === 1) {
      const detailsData = await providerJson(`${base}/branches/${matches[0].id}`, process.env.NEON_API_KEY);
      const details = detailsData.branch || detailsData;
      const annotations = details?.annotation_value || details?.annotations || {};
      if (annotations["parkdex-release-id"] !== state.releaseId || annotations["parkdex-commit"] !== state.commitSha || annotations["parkdex-environment"] !== state.railwayEnvironment) throw new Error("Recovered Neon branch provenance did not match the journal");
      updateJournal(journalPath, state, { neonBranchId: matches[0].id, status: "cleanup-recovered" });
    }
  }
  if (!state.vercelDeploymentId) {
    const matches = await listVercelReleases(state.commitSha, state.releaseId, state.railwayEnvironment);
    if (matches.length > 1) throw new Error("Multiple Vercel deployments matched the journal identity");
    if (matches.length === 1) updateJournal(journalPath, state, { vercelDeploymentId: matches[0].id, status: "cleanup-recovered" });
  }
  if (state.vercelDeploymentId && !state.cleanup?.vercel) {
    const data = await providerJson(`https://api.vercel.com/v13/deployments/${state.vercelDeploymentId}?teamId=${process.env.VERCEL_ORG_ID}`, process.env.VERCEL_TOKEN);
    if (data.id !== state.vercelDeploymentId || data.projectId !== process.env.VERCEL_PROJECT_ID || data.meta?.githubCommitSha !== state.commitSha || data.meta?.parkdexReleaseId !== state.releaseId || data.meta?.parkdexEnvironment !== state.railwayEnvironment) throw new Error("Vercel cleanup ownership verification failed");
    await providerJson(`https://api.vercel.com/v13/deployments/${state.vercelDeploymentId}?teamId=${process.env.VERCEL_ORG_ID}`, process.env.VERCEL_TOKEN, { method: "DELETE" });
    updateJournal(journalPath, state, { cleanup: { ...(state.cleanup || {}), vercel: true } });
  }
  if (state.railwayEnvironmentId && !state.cleanup?.railway) {
    const context = railwayContext(process.env.RAILWAY_PROJECT_ID, process.env.RAILWAY_BASE_ENVIRONMENT_ID, process.env.RAILWAY_API_TOKEN);
    try {
      const matches = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN).filter((item) => item.id === state.railwayEnvironmentId && item.name === state.railwayEnvironment);
      if (matches.length !== 1) throw new Error("Railway cleanup ownership verification failed");
      run("railway", ["environment", "delete", state.railwayEnvironmentId, "--yes"], { cwd: context, env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway environment delete" });
    } finally { rmSync(context, { recursive: true, force: true }); }
    updateJournal(journalPath, state, { cleanup: { ...(state.cleanup || {}), railway: true } });
  }
  if (state.neonBranchId && !state.cleanup?.neon) {
    const base = `https://console.neon.tech/api/v2/projects/${process.env.NEON_PROJECT_ID}/branches/${state.neonBranchId}`;
    const data = await providerJson(base, process.env.NEON_API_KEY);
    const branch = data.branch || data;
    const annotations = branch.annotation_value || branch.annotations || {};
    if (branch.id !== state.neonBranchId || branch.name !== state.neonBranch || annotations["parkdex-release-id"] !== state.releaseId || annotations["parkdex-commit"] !== state.commitSha || annotations["parkdex-environment"] !== state.railwayEnvironment) throw new Error("Neon cleanup ownership verification failed");
    await providerJson(base, process.env.NEON_API_KEY, { method: "DELETE" });
    updateJournal(journalPath, state, { cleanup: { ...(state.cleanup || {}), neon: true } });
  }
  updateJournal(journalPath, state, { status: "cleaned", cleanedAt: new Date().toISOString() });
  console.log(`local-release cleanup=success journal=${journalPath}`);
}

async function deploy(root, mode, sha, journalPath, releaseId, pullRequest) {
  const shortSha = sha.slice(0, 12);
  const suffix = releaseId.replaceAll("-", "").slice(0, 8);
  const preview = mode === "preview";
  const railwayEnvironment = preview ? `local-pr-${pullRequest}-${shortSha}-${suffix}` : "staging";
  const neonBranch = preview ? `preview/${railwayEnvironment}` : null;
  const expiresAt = preview ? new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  const state = { schema: "parkdex.local-release/v2", mode, status: "planned", releaseId, commitSha: sha, pullRequest: preview ? pullRequest : null, railwayEnvironment, railwayEnvironmentId: preview ? null : process.env.RAILWAY_STAGING_ENVIRONMENT_ID || null, neonBranch, neonBranchId: null, vercelDeploymentId: null, frontendUrl: null, apiUrl: null, expiresAt, cleanup: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const plan = { mode, commitSha: sha, releaseId, railwayEnvironment, neonBranch, journalPath, apply: flag("--apply"), safety: ["clean exact SHA", "reviewed code only", "no environment copy", "journal before mutation", "exact source and release id", "provider-owned cleanup"] };
  if (!flag("--apply")) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (!value("--sha")) throw new Error("--apply requires an explicit full --sha");
  if (resolve(journalPath).startsWith(`${resolve(root)}\\`) || resolve(journalPath).startsWith(`${resolve(root)}/`)) throw new Error("Release journals must be stored outside the repository");
  if (existsSync(journalPath)) throw new Error("Refusing to overwrite an existing release journal");
  const common = ["RAILWAY_API_TOKEN", "RAILWAY_PROJECT_ID", "RAILWAY_API_SERVICE_ID", "RAILWAY_WORKER_SERVICE_ID", "VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"];
  requireEnv(preview ? [...common, "RAILWAY_BASE_ENVIRONMENT_ID", "NEON_PROJECT_ID", "NEON_API_KEY", "NEON_PARENT_BRANCH"] : [...common, "RAILWAY_STAGING_ENVIRONMENT_ID", "PARKDEX_STAGING_DATABASE_URL", "PARKDEX_STAGING_DATABASE_URL_UNPOOLED", "PARKDEX_STAGING_GOOGLE_CLIENT_ID", "PARKDEX_STAGING_GOOGLE_CLIENT_SECRET"]);
  atomicJournal(journalPath, state);
  const metadata = releaseMetadata(root, sha);
  const sourceRoot = mkdtempSync(join(tmpdir(), "parkdex-release-source-"));
  git(root, ["worktree", "add", "--detach", sourceRoot, sha]);
  let database;
  try {
    if (preview) {
      database = await createNeonBranch(state, journalPath);
      run("python", [join(sourceRoot, "scripts", "verify_preview_database.py")], { cwd: sourceRoot, env: minimalEnv({ PREVIEW_DATABASE_URL_UNPOOLED: database.direct }), label: "Preview database zero-row gate" });
      updateJournal(journalPath, state, { status: "database-verified" });
    }
    else database = { pooled: process.env.PARKDEX_STAGING_DATABASE_URL, direct: process.env.PARKDEX_STAGING_DATABASE_URL_UNPOOLED };
    const context = railwayContext(process.env.RAILWAY_PROJECT_ID, preview ? process.env.RAILWAY_BASE_ENVIRONMENT_ID : process.env.RAILWAY_STAGING_ENVIRONMENT_ID, process.env.RAILWAY_API_TOKEN);
    try {
      const environments = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN);
      if (preview) {
        if (environments.some((item) => item.name === railwayEnvironment)) throw new Error("Refusing to adopt an existing Railway preview environment");
        const createEnvironmentArgs = [
          "environment", "new", railwayEnvironment, "--json",
          "--service-config", process.env.RAILWAY_API_SERVICE_ID, "build.builder", "DOCKERFILE",
          "--service-config", process.env.RAILWAY_API_SERVICE_ID, "build.dockerfilePath", "backend/Dockerfile.api",
          "--service-config", process.env.RAILWAY_API_SERVICE_ID, "deploy.preDeployCommand", "python -m backend.app.migrate",
          "--service-config", process.env.RAILWAY_API_SERVICE_ID, "deploy.healthcheckPath", "/health",
          "--service-config", process.env.RAILWAY_WORKER_SERVICE_ID, "build.builder", "DOCKERFILE",
          "--service-config", process.env.RAILWAY_WORKER_SERVICE_ID, "build.dockerfilePath", "backend/Dockerfile.worker",
        ];
        try {
          run("railway", createEnvironmentArgs, { cwd: context, env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway environment create" });
        } catch (error) {
          const recovered = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN).filter((item) => item.name === railwayEnvironment);
          if (recovered.length !== 1) throw error;
        }
        const matches = listRailwayEnvironments(context, process.env.RAILWAY_API_TOKEN).filter((item) => item.name === railwayEnvironment);
        if (matches.length !== 1) throw new Error("Railway preview environment identity was not verified");
        state.railwayEnvironmentId = matches[0].id;
        updateJournal(journalPath, state, { railwayEnvironmentId: matches[0].id, status: "railway-created" });
      } else if (!environments.some((item) => item.id === state.railwayEnvironmentId && item.name === "staging")) throw new Error("Railway staging environment identity was not verified");
    } finally { rmSync(context, { recursive: true, force: true }); }
    const railwayArgs = ["--project", process.env.RAILWAY_PROJECT_ID, "--environment", state.railwayEnvironmentId, "--service", process.env.RAILWAY_API_SERVICE_ID, "--json"];
    let domains = parseJson(run("railway", ["domain", "list", ...railwayArgs], { env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway domain list" }), "Railway domains");
    let domain = JSON.stringify(domains).match(/[a-zA-Z0-9][a-zA-Z0-9-]*\.up\.railway\.app/)?.[0];
    if (!domain) {
      run("railway", ["domain", "--port", "8080", ...railwayArgs], { env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway domain create" });
      domains = parseJson(run("railway", ["domain", "list", ...railwayArgs], { env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway domain list" }), "Railway domains");
      domain = JSON.stringify(domains).match(/[a-zA-Z0-9][a-zA-Z0-9-]*\.up\.railway\.app/)?.[0];
    }
    if (!domain) throw new Error("Railway API domain was not verified");
    state.apiUrl = `https://${domain}`;
    updateJournal(journalPath, state, { status: "frontend-creating" });
    let deploymentUrl;
    try {
      const deployOutput = run("vercel", ["deploy", "--yes", "--target", "preview", "--cwd", "frontend", "--build-env", `NEXT_PUBLIC_API_BASE_URL=${state.apiUrl}`, "--build-env", `NEXT_PUBLIC_RELEASE_VERSION=${metadata.version}`, "--build-env", `NEXT_PUBLIC_COMMIT_SHA=${sha}`, "--build-env", `NEXT_PUBLIC_COMMIT_DATE=${metadata.commit_date}`, "--meta", `githubCommitSha=${sha}`, "--meta", `parkdexReleaseId=${releaseId}`, "--meta", `parkdexEnvironment=${railwayEnvironment}`, "--scope", process.env.VERCEL_ORG_ID], { cwd: sourceRoot, env: vercelEnv(process.env.VERCEL_TOKEN), label: "Vercel deploy" });
      deploymentUrl = deployOutput.split(/\r?\n/).findLast((line) => /^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/.test(line.trim()))?.trim();
    } catch {
      deploymentUrl = await findVercelRelease(sha, releaseId, railwayEnvironment);
    }
    if (!deploymentUrl) deploymentUrl = await findVercelRelease(sha, releaseId, railwayEnvironment);
    const vercel = await verifyVercelDeployment(deploymentUrl, sha, releaseId, railwayEnvironment);
    state.frontendUrl = preview ? vercel.url : "https://staging.parkdex.app";
    updateJournal(journalPath, state, { vercelDeploymentId: vercel.id, frontendUrl: state.frontendUrl, apiUrl: state.apiUrl, status: "frontend-created" });
    const services = [process.env.RAILWAY_API_SERVICE_ID, process.env.RAILWAY_WORKER_SERVICE_ID];
    const dbName = preview ? "PREVIEW_DATABASE_URL" : "DATABASE_URL";
    const directName = preview ? "PREVIEW_DATABASE_URL_UNPOOLED" : "DATABASE_URL_UNPOOLED";
    for (const service of services) {
      for (const [name, val] of [[dbName, database.pooled], [directName, database.direct], ["RAILWAY_ENVIRONMENT_NAME", railwayEnvironment], ["APP_COMMIT_SHA", sha], ["APP_RELEASE_ID", releaseId]]) setRailwayVariable(name, val, service, state.railwayEnvironmentId, process.env.RAILWAY_PROJECT_ID, process.env.RAILWAY_API_TOKEN);
      run("railway", ["service", "source", "disconnect", "--service", service, "--environment", state.railwayEnvironmentId, "--project", process.env.RAILWAY_PROJECT_ID], { env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway source disconnect" });
    }
    for (const [name, val] of [["FRONTEND_ORIGINS", state.frontendUrl], ["APP_PUBLIC_URL", state.frontendUrl]]) setRailwayVariable(name, val, process.env.RAILWAY_API_SERVICE_ID, state.railwayEnvironmentId, process.env.RAILWAY_PROJECT_ID, process.env.RAILWAY_API_TOKEN);
    if (!preview) for (const [name, val] of [["GOOGLE_CLIENT_ID", process.env.PARKDEX_STAGING_GOOGLE_CLIENT_ID], ["GOOGLE_CLIENT_SECRET", process.env.PARKDEX_STAGING_GOOGLE_CLIENT_SECRET], ["GOOGLE_REDIRECT_URI", "https://staging.parkdex.app/auth/google/callback"]]) setRailwayVariable(name, val, process.env.RAILWAY_API_SERVICE_ID, state.railwayEnvironmentId, process.env.RAILWAY_PROJECT_ID, process.env.RAILWAY_API_TOKEN);
    updateJournal(journalPath, state, { status: "configured" });
    const message = `local-release ${releaseId} commit ${sha}`;
    const marker = join(sourceRoot, "backend", ".local-release-source-sha");
    writeFileSync(marker, `${sha} ${releaseId}`, "utf8");
    for (const service of services) run("railway", ["up", "--ci", "--yes", "--message", message, "--service", service, "--environment", state.railwayEnvironmentId, "--project", process.env.RAILWAY_PROJECT_ID], { cwd: sourceRoot, env: railwayEnv(process.env.RAILWAY_API_TOKEN), label: "Railway deploy" });
    const helperEnv = { RAILWAY_API_TOKEN: process.env.RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT: state.railwayEnvironmentId, PREVIEW_ENVIRONMENT: state.railwayEnvironmentId, RAILWAY_API_SERVICE_ID: process.env.RAILWAY_API_SERVICE_ID, RAILWAY_WORKER_SERVICE_ID: process.env.RAILWAY_WORKER_SERVICE_ID, EXPECTED_COMMIT_SHA: sha, EXPECTED_RELEASE_ID: releaseId, EXPECTED_PREVIEW_DEPLOYMENT_MESSAGE: message, GITHUB_OUTPUT: join(tmpdir(), `parkdex-api-${releaseId}.out`) };
    callBash(sourceRoot, "scripts/verify-railway-deployments.sh", helperEnv, [message]);
    callBash(sourceRoot, "scripts/wait-for-railway-api.sh", helperEnv);
    callBash(sourceRoot, "scripts/wait-for-worker-catalogue.sh", helperEnv);
    callBash(sourceRoot, "scripts/smoke-catalogue.sh", { ...helperEnv, API_URL: state.apiUrl });
    callBash(sourceRoot, "scripts/verify-frontend-release.sh", { VERCEL_TOKEN: process.env.VERCEL_TOKEN, VERCEL_ORG_ID: process.env.VERCEL_ORG_ID, VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID }, [vercel.url, sha]);
    if (!preview) run("vercel", ["alias", "set", vercel.url, "staging.parkdex.app", "--scope", process.env.VERCEL_ORG_ID], { cwd: sourceRoot, env: vercelEnv(process.env.VERCEL_TOKEN), label: "Vercel staging alias" });
    updateJournal(journalPath, state, { status: "ready", readyAt: new Date().toISOString() });
    console.log(`local-release status=ready mode=${mode} sha=${sha} journal=${journalPath}`);
  } catch (error) {
    if (existsSync(journalPath)) updateJournal(journalPath, state, { status: "failed", failure: error.message });
    throw error;
  } finally {
    run("git", ["worktree", "remove", "--force", sourceRoot], { cwd: root, label: "git worktree remove" });
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
const actualSha = git(root, ["rev-parse", "HEAD"]);
const expectedSha = value("--sha", actualSha);
if (!/^[0-9a-f]{40}$/.test(expectedSha) || expectedSha !== actualSha) throw new Error("Refusing a stale or non-full commit SHA");
if (git(root, ["status", "--porcelain"])) throw new Error("Refusing a dirty worktree");
const mode = value("--mode", "staging").toLowerCase();
if (!["preview", "staging", "cleanup"].includes(mode)) throw new Error("--mode must be preview, staging, or cleanup");
const pullRequest = Number(value("--pr", "0"));
if (mode === "preview" && (!Number.isInteger(pullRequest) || pullRequest < 1 || pullRequest > 999999)) throw new Error("Preview requires a valid --pr number");
const releaseId = value("--release-id", randomUUID());
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(releaseId)) throw new Error("--release-id must be a version-4 UUID");
const defaultRoot = process.env.LOCALAPPDATA || tmpdir();
const journalPath = resolve(value("--journal", join(defaultRoot, "Parkdex", "release-journal", `${releaseId}.json`)));

if (mode === "cleanup" && !flag("--apply")) throw new Error("Cleanup requires explicit --apply");
if (flag("--apply")) throw new Error("Provider mutation remains disabled until an isolated create/configure/deploy/verify/cleanup proof succeeds");
if (mode === "cleanup") await cleanup(root, value("--journal"));
else await deploy(root, mode, expectedSha, journalPath, releaseId, pullRequest);
