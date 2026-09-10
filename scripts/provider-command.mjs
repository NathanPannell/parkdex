export function buildNeonApiCommand(cli, path, { method = "GET", query = {}, body } = {}) {
  const args = [cli, "api", path, "--method", method, "--output", "json", "--analytics", "false"];
  for (const [name, value] of Object.entries(query)) args.push("--query", `${name}=${value}`);
  if (body !== undefined) args.push("--data=-");
  return { args, input: body === undefined ? undefined : JSON.stringify(body) };
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

export function classifyRailwayEnvironmentCreateFailure(stderr) {
  return /(?:^|\r?\n)Error in name - Invalid input(?:\r?\n|$)/.test(stderr || "") ? "invalid-name" : "unknown";
}

export function buildRailwayServicePatch(apiServiceId, workerServiceId) {
  return {
    services: {
      [apiServiceId]: {
        isCreated: true,
        build: { builder: "DOCKERFILE", dockerfilePath: "backend/Dockerfile.api", watchPatterns: ["backend/**", "database/**"] },
        deploy: { preDeployCommand: ["python -m backend.app.migrate"], healthcheckPath: "/health" },
      },
      [workerServiceId]: {
        isCreated: true,
        build: { builder: "DOCKERFILE", dockerfilePath: "backend/Dockerfile.worker", watchPatterns: ["backend/**", "database/**"] },
      },
    },
  };
}

export function buildRailwayServiceMutation(environmentId, apiServiceId, workerServiceId) {
  return {
    query: "mutation LocalReleaseServices($environmentId: String!, $patch: EnvironmentConfig!) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: \"Parkdex isolated local preview services\") }",
    variables: { environmentId, patch: buildRailwayServicePatch(apiServiceId, workerServiceId) },
  };
}

export function buildRailwayApiCommand(query, variables) {
  return { args: ["api", query, "--variables", "@-", "--compact"], input: JSON.stringify(variables) };
}

export function verifyRailwayServicePatchResult(config, apiServiceId, workerServiceId) {
  const services = config?.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) throw new Error("Railway service configuration was not returned");
  const ids = Object.keys(services).sort();
  if (ids.join(",") !== [apiServiceId, workerServiceId].sort().join(",")) throw new Error("Railway preview service identities were not verified");
  const api = services[apiServiceId];
  const worker = services[workerServiceId];
  if (api?.build?.builder !== "DOCKERFILE" || api?.build?.dockerfilePath !== "backend/Dockerfile.api" || api?.deploy?.healthcheckPath !== "/health" || api?.deploy?.preDeployCommand?.join(" ") !== "python -m backend.app.migrate") throw new Error("Railway API service configuration was not verified");
  if (worker?.build?.builder !== "DOCKERFILE" || worker?.build?.dockerfilePath !== "backend/Dockerfile.worker") throw new Error("Railway worker service configuration was not verified");
  for (const service of [api, worker]) {
    if (service?.source != null || service?.networking != null || service?.configFile != null || Object.keys(service?.variables || {}).length || Object.keys(service?.volumeMounts || {}).length) throw new Error("Railway preview service inherited forbidden configuration");
  }
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

export function workerCatalogueReady(logs, commitSha, releaseId) {
  return String(logs || "").split(/\r?\n/).some((line) => {
    const marker = line.match(/(?:Every Park|Parkdex) catalogue ready commit=([^ ]+) release=([^ ]+) places=([0-9]+)/);
    return marker?.[1] === commitSha && marker?.[2] === releaseId && Number(marker[3]) > 0;
  });
}

export function provisionRailwayServiceInstances({ projectId, environmentId, environmentName, apiServiceId, workerServiceId, listEnvironments, recordIntent, commitPatch, readConfig }) {
  const matches = listEnvironments().filter((environment) => environment.id === environmentId && environment.name === environmentName);
  if (matches.length !== 1) throw new Error("Railway preview environment identity was not verified before service creation");
  const request = buildRailwayServiceMutation(environmentId, apiServiceId, workerServiceId);
  recordIntent({ projectId, environmentId, serviceIds: Object.keys(request.variables.patch.services).sort() });
  commitPatch(request);
  const config = readConfig();
  verifyRailwayServicePatchResult(config, apiServiceId, workerServiceId);
  return config;
}
