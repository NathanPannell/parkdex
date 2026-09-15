const MCP_PROXY_PATHS = [
  "/mcp",
  "/mcp/:path+",
  "/authorize",
  "/token",
  "/register",
  "/revoke",
  "/oauth/consent",
] as const;

export function apiOrigin(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL is required for the MCP proxy");
  }

  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must be an HTTP(S) origin");
  }
  return url.origin;
}

export function mcpProxyRewrites(apiBaseUrl: string | undefined) {
  const origin = apiOrigin(apiBaseUrl);
  return MCP_PROXY_PATHS.map((source) => ({
    source,
    destination: `${origin}${source}`,
  }));
}
