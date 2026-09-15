import { proxyBackendRequest } from "./_mcp-proxy";

type ParkdexPagesContext = {
  request: Request;
  env: { API_BASE_URL?: string };
};

export function onRequest(context: ParkdexPagesContext) {
  return proxyBackendRequest(context.request, context.env.API_BASE_URL ?? "");
}
