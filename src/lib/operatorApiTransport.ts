import { hasRawUrlCredentials, hasUrlCredentials, resolveUserDataApiOrigin } from "./userDataDestination";

export function operatorApiUrl(
  path: string,
  pageOrigin: string,
  allowLoopbackHttp = false,
): string {
  const apiOrigin = resolveUserDataApiOrigin(undefined, {
    native: false,
    webOrigin: pageOrigin,
    allowLoopbackHttp,
  });
  const url = new URL(path, `${apiOrigin || pageOrigin}/`);
  if (url.origin !== pageOrigin || hasUrlCredentials(url) || hasRawUrlCredentials(path) || !url.pathname.startsWith("/api/operator/")) {
    throw new Error("Operator requests must use this Parkdex page's secure review API.");
  }
  return url.href;
}

export function fetchOperatorApi(
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = globalThis.fetch,
  options: { pageOrigin?: string; allowLoopbackHttp?: boolean } = {},
): Promise<Response> {
  const pageOrigin = options.pageOrigin ?? (typeof location === "undefined" ? "" : location.origin);
  const url = operatorApiUrl(path, pageOrigin, options.allowLoopbackHttp);
  return fetcher(url, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
}
