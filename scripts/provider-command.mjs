export function buildNeonApiCommand(cli, path, { method = "GET", query = {}, body } = {}) {
  const args = [cli, "api", path, "--method", method, "--output", "json"];
  for (const [name, value] of Object.entries(query)) args.push("--query", `${name}=${value}`);
  if (body !== undefined) args.push("--data=-");
  return { args, input: body === undefined ? undefined : JSON.stringify(body) };
}

export function finalizeReleaseSourceCleanup({ sourceRoot, removeWorktree, removeDirectory, pruneWorktrees, sourceExists, sourceRegistered }) {
  let removalError;
  try { removeWorktree(); } catch (error) { removalError = error; }
  try { removeDirectory(); } catch (error) { removalError ||= error; }
  try { pruneWorktrees(); } catch (error) { removalError ||= error; }
  if (sourceExists(sourceRoot) || sourceRegistered(sourceRoot)) {
    throw removalError || new Error("Release source cleanup was not verified");
  }
  return { recovered: Boolean(removalError) };
}

export function sanitizeProviderDiagnostic(value) {
  return String(value || "")
    .replace(/(postgres(?:ql)?:\/\/)[^\s"']+/gi, "$1[redacted]")
    .replace(/("value"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/("[^"]*(?:token|secret|password|api[_-]?key)[^"]*"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9_-]{41,}/g, "[redacted]")
    .trim()
    .slice(-1000);
}

export function buildProviderProcess(command, args, platform = process.platform) {
  if (platform === "win32" && ["railway", "vercel"].includes(command)) {
    return { executable: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
  }
  return { executable: command, args };
}

export function buildVercelCurlArgs(route, deploymentUrl, scope, outputPath) {
  const parsed = new URL(deploymentUrl);
  if (parsed.protocol !== "https:" || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.vercel\.app$/.test(parsed.hostname) || parsed.pathname !== "/") throw new Error("Vercel deployment URL was invalid");
  if (!/^\/[a-zA-Z0-9./_-]*$/.test(route) || route.includes("..")) throw new Error("Vercel asset route was invalid");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(scope) || !outputPath) throw new Error("Vercel verification target was invalid");
  return ["curl", route, "--deployment", deploymentUrl, "--cwd", "frontend", "--scope", scope, "--", "--fail", "--silent", "--show-error", "--output", outputPath];
}

export function verifyCorsHeaders(headers, origin, { method, requestedHeaders = [] } = {}) {
  if (headers.get("access-control-allow-origin") !== origin) {
    throw new Error("API CORS did not allow the exact frontend origin");
  }
  if (method && !headers.get("access-control-allow-methods")?.split(",").map((value) => value.trim().toUpperCase()).includes(method.toUpperCase())) {
    throw new Error(`API CORS did not allow ${method}`);
  }
  const allowedHeaders = headers.get("access-control-allow-headers")?.split(",").map((value) => value.trim().toLowerCase()) || [];
  const missing = requestedHeaders.filter((header) => !allowedHeaders.includes(header.toLowerCase()));
  if (missing.length) throw new Error(`API CORS did not allow requested headers: ${missing.join(", ")}`);
}

export function buildPreviewEnvironmentName(pullRequest, commitSha, releaseId) {
  const name = `lp-pr-${pullRequest}-${commitSha.slice(0, 8)}-${releaseId.replaceAll("-", "").slice(0, 8)}`;
  if (!/^lp-pr-[0-9]{1,6}-[0-9a-f]{8}-[0-9a-f]{8}$/.test(name) || name.length > 30) {
    throw new Error("Preview environment name is outside the verified Railway-safe subset");
  }
  return name;
}

export function parseRailwayEnvironmentInventory(payload) {
  if (!payload || !Array.isArray(payload.environments)) {
    throw new Error("Railway environment inventory was not a complete list");
  }
  if (payload.nextCursor != null || payload.hasMore === true || payload.pageInfo?.hasNextPage === true) {
    throw new Error("Railway environment inventory was paginated");
  }
  for (const environment of payload.environments) {
    if (!environment || typeof environment.id !== "string" || typeof environment.name !== "string") {
      throw new Error("Railway environment inventory contained an invalid entry");
    }
  }
  return payload.environments;
}

export function unresolvedPreviewResources(state, { vercelDeployments, railwayEnvironments, neonBranches }) {
  if (!state || !Array.isArray(vercelDeployments) || !Array.isArray(railwayEnvironments) || !Array.isArray(neonBranches)) {
    throw new Error("Preview absence inventory was invalid");
  }
  const unresolved = [];
  if (vercelDeployments.length) unresolved.push("Vercel deployment");
  if (railwayEnvironments.some((environment) => environment.id === state.railwayEnvironmentId || environment.name === state.railwayEnvironment)) {
    unresolved.push("Railway environment");
  }
  if (neonBranches.some((branch) => branch.id === state.neonBranchId || branch.name === state.neonBranch)) {
    unresolved.push("Neon branch");
  }
  return unresolved;
}

export async function confirmStablePreviewAbsence({ state, readInventories, wait, now = Date.now, delays = [2, 3, 5, 10, 15, 20, 30], minimumGraceMs = 10_000, requiredConsecutive = 3 }) {
  if (typeof readInventories !== "function" || typeof wait !== "function" || !Number.isFinite(minimumGraceMs) || minimumGraceMs < 0 || !Number.isInteger(requiredConsecutive) || requiredConsecutive < 2) {
    throw new Error("Preview absence confirmation configuration was invalid");
  }
  const startedAt = now();
  const observations = [];
  let consecutiveEmpty = 0;
  let unresolved = ["Vercel deployment", "Railway environment", "Neon branch"];
  for (const seconds of delays) {
    await wait(seconds * 1000);
    const inventories = await readInventories();
    unresolved = unresolvedPreviewResources(state, inventories);
    observations.push({ checkedAt: new Date(now()).toISOString(), unresolved: [...unresolved] });
    consecutiveEmpty = unresolved.length ? 0 : consecutiveEmpty + 1;
    if (consecutiveEmpty >= requiredConsecutive && now() - startedAt >= minimumGraceMs) {
      return { observations, consecutiveEmpty, elapsedMs: now() - startedAt };
    }
  }
  const error = new Error(`Cleanup did not verify stable provider absence: ${unresolved.join(", ") || "empty inventories were not stable long enough"}`);
  Object.defineProperty(error, "unresolved", { value: unresolved, enumerable: false });
  throw error;
}

export function classifyRailwayEnvironmentCreateFailure(stderr) {
  return /(?:^|\r?\n)Error in name - Invalid input(?:\r?\n|$)/.test(stderr || "") ? "invalid-name" : "unknown";
}

export function buildRailwayApiServicePatch(apiServiceId) {
  return {
    services: {
      [apiServiceId]: {
        isCreated: true,
        build: { builder: "DOCKERFILE", dockerfilePath: "backend/Dockerfile.api", watchPatterns: ["backend/**", "database/**"] },
        deploy: { preDeployCommand: ["python -m backend.app.migrate"], healthcheckPath: "/health" },
      },
    },
  };
}

export function buildRailwayApiServiceMutation(environmentId, apiServiceId) {
  return {
    query: "mutation LocalReleaseApiService($environmentId: String!, $patch: EnvironmentConfig!) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: \"Parkdex isolated local preview API\") }",
    variables: { environmentId, patch: buildRailwayApiServicePatch(apiServiceId) },
  };
}

export function buildRailwayApiCommand(query, variables) {
  return { args: ["api", query, "--variables", "@-", "--compact"], input: JSON.stringify(variables) };
}

export function verifyRailwayApiServicePatchResult(config, apiServiceId) {
  const services = config?.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) throw new Error("Railway service configuration was not returned");
  const ids = Object.keys(services).sort();
  if (ids.length !== 1 || ids[0] !== apiServiceId) throw new Error("Railway preview API service identity was not verified");
  const api = services[apiServiceId];
  if (api?.build?.builder !== "DOCKERFILE" || api?.build?.dockerfilePath !== "backend/Dockerfile.api" || api?.deploy?.healthcheckPath !== "/health" || api?.deploy?.preDeployCommand?.join(" ") !== "python -m backend.app.migrate") throw new Error("Railway API service configuration was not verified");
  if (api?.source != null || api?.networking != null || api?.configFile != null || Object.keys(api?.variables || {}).length || Object.keys(api?.volumeMounts || {}).length) throw new Error("Railway preview API inherited forbidden configuration");
  if (Object.keys(config.sharedVariables || {}).length || Object.keys(config.volumes || {}).length || Object.keys(config.buckets || {}).length) throw new Error("Railway preview environment inherited forbidden configuration");
  return true;
}

export function verifyRailwayDeploymentResult(deployments, message) {
  if (!Array.isArray(deployments)) throw new Error("Railway deployment inventory was invalid");
  const matches = deployments.filter((deployment) => deployment?.meta?.cliMessage === message);
  if (matches.length !== 1 || matches[0].status !== "SUCCESS" || typeof matches[0].id !== "string") {
    throw new Error("Railway deployment did not match the exact successful local release");
  }
  return matches[0].id;
}

export function verifyReadyPayload(payload, commitSha, releaseId) {
  if (payload?.status !== "ready" || payload?.commit !== commitSha || payload?.release !== releaseId) {
    throw new Error("Railway API readiness identity did not match the local release");
  }
  return true;
}

export function catalogueVisitedIds(payload) {
  if (!Array.isArray(payload?.visitedIds)) throw new Error("Preview catalogue visitedIds contract was not verified");
  return payload.visitedIds;
}

export function verifyGuestVisitRejection(status, payload) {
  if (status !== 409 || payload?.detail?.code !== "location_claim_required") {
    throw new Error("Preview guest visit enforcement was not verified");
  }
  return true;
}

export function verifyUnvisitedCatalogues(placeId, payloads) {
  if (!placeId || !Array.isArray(payloads) || payloads.length < 1) throw new Error("Preview catalogue isolation inputs were invalid");
  for (const payload of payloads) {
    if (catalogueVisitedIds(payload).includes(placeId)) throw new Error("Preview visit isolation was not verified");
  }
  return true;
}

export function provisionRailwayApiService({ projectId, environmentId, environmentName, apiServiceId, listEnvironments, recordIntent, commitPatch, readConfig }) {
  const matches = listEnvironments().filter((environment) => environment.id === environmentId && environment.name === environmentName);
  if (matches.length !== 1) throw new Error("Railway preview environment identity was not verified before service creation");
  const request = buildRailwayApiServiceMutation(environmentId, apiServiceId);
  recordIntent({ projectId, environmentId, serviceIds: Object.keys(request.variables.patch.services).sort() });
  commitPatch(request);
  const config = readConfig();
  verifyRailwayApiServicePatchResult(config, apiServiceId);
  return config;
}
