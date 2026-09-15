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
  const isLocalHttp = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !isLocalHttp)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("API_BASE_URL must be an HTTPS origin (or local HTTP for development)");
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

  const upstreamOrigin = apiOrigin(apiBaseUrl);
  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, upstreamOrigin);
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
  const location = responseHeaders.get("Location");
  if (location) {
    const redirectUrl = new URL(location, upstreamOrigin);
    if (redirectUrl.host === new URL(upstreamOrigin).host) {
      responseHeaders.set("Location", `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`);
    }
  }
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
