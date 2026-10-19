import { createDashboardApi, type DashboardEnv } from "./api.js";

const api = createDashboardApi();

// Vercel routes every /api/* request to this one function and passes the original
// sub-path as __path, so rebuild the URL the handler expects.
export function originalRequest(request: Request): Request {
  const url = new URL(request.url);
  const subPath = url.searchParams.get("__path");
  if (subPath === null) return request;
  url.searchParams.delete("__path");
  url.pathname = `/api/${subPath.replace(/^\/+/, "")}`;
  return new Request(url, request);
}

export function createEdgeHandler(env: DashboardEnv & { VERCEL_ENV?: string }) {
  return function handler(request: Request): Promise<Response> {
    // On the Hobby plan Vercel login only covers preview deployments. A production
    // deployment of this app would be public, so its API refuses to serve any data.
    if (env.VERCEL_ENV === "production") {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "preview_only", message: "The operator dashboard only runs as a protected preview deployment." } }), {
          status: 403,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        }),
      );
    }
    return api(originalRequest(request), env);
  };
}

// Vercel Edge Function entry. Vercel Authentication has already admitted the request.
export default createEdgeHandler(process.env as DashboardEnv & { VERCEL_ENV?: string });
