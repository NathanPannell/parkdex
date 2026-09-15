import { apiOrigin } from "./mcp-proxy-rewrites";

const METADATA_RESPONSE_HEADERS = ["cache-control", "content-type"] as const;

export async function proxyMcpMetadata(
  request: Request,
  apiBaseUrl: string | undefined = process.env.NEXT_PUBLIC_API_BASE_URL,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, apiOrigin(apiBaseUrl));
  const upstream = await fetch(upstreamUrl, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "manual",
  });
  const headers = new Headers({ "Access-Control-Allow-Origin": "*" });
  for (const name of METADATA_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
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
