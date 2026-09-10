export function buildNeonApiCommand(cli, path, { method = "GET", query = {}, body } = {}) {
  const args = [cli, "api", path, "--method", method, "--output", "json", "--analytics", "false"];
  for (const [name, value] of Object.entries(query)) args.push("--query", `${name}=${value}`);
  if (body !== undefined) args.push("--data=-");
  return { args, input: body === undefined ? undefined : JSON.stringify(body) };
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
