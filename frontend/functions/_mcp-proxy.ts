const EXACT_PROXY_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource/mcp",
  "/authorize",
  "/token",
  "/register",
  "/revoke",
  "/oauth/consent",
]);

const METADATA_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource/mcp",
]);

export function apiOrigin(value: string | undefined): string {
  if (!value?.trim()) throw new Error("API_BASE_URL is required for the MCP proxy");
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("API_BASE_URL must be an HTTP(S) origin");
  }
  return url.origin;
}

export function isBackendProxyPath(pathname: string): boolean {
  return EXACT_PROXY_PATHS.has(pathname)
    || pathname === "/mcp"
    || pathname.startsWith("/mcp/")
    || pathname.startsWith("/api/");
}

export function mcpMetadataOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function proxyBackendRequest(request: Request, apiBaseUrl: string): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (!isBackendProxyPath(requestUrl.pathname)) return new Response("Not found", { status: 404 });
  if (request.method === "OPTIONS" && METADATA_PATHS.has(requestUrl.pathname)) return mcpMetadataOptions();

  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, apiOrigin(apiBaseUrl));
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });

  const responseHeaders = new Headers(upstream.headers);
  if (METADATA_PATHS.has(requestUrl.pathname)) {
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Cache-Control", "no-store");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
