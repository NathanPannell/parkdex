import { expect, test } from "vitest";

import {
  blockingDiagnostics,
  chooseWebViewTarget,
  hasExpectedOfflineCatalogueResponse,
  parseWebViewSocket,
  sanitizedUrl,
} from "./android-smoke.mjs";

test("selects the Parkdex WebView socket and secure local page", () => {
  const sockets = "000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_4321";
  expect(parseWebViewSocket(sockets, "4321")).toBe("webview_devtools_remote_4321");
  expect(parseWebViewSocket(sockets, "9999")).toBeUndefined();
  expect(chooseWebViewTarget([
    { type: "page", url: "about:blank" },
    { type: "page", url: "https://localhost/", id: "parkdex" },
  ])?.id).toBe("parkdex");
});

test("removes query strings and fragments from diagnostic URLs", () => {
  expect(
    sanitizedUrl("https://staging.parkdex.app/auth/google/callback?code=secret&state=secret#token"),
  ).toBe("https://staging.parkdex.app/auth/google/callback");
  expect(sanitizedUrl("not a URL")).toBe("");
});

test("blocks application failures while retaining unrelated diagnostics", () => {
  const failures = blockingDiagnostics({
    exceptions: ["Uncaught TypeError"],
    responses: [
      { status: 503, url: "https://api-staging-882c.up.railway.app/api/visits" },
      { status: 404, url: "https://tiles.example.test/missing" },
    ],
    failedRequests: [
      { errorText: "net::ERR_CONNECTION_REFUSED", url: "https://localhost/_next/app.js" },
      { errorText: "net::ERR_ABORTED", url: "https://api-staging-882c.up.railway.app/api/visits" },
    ],
  });
  expect(failures).toEqual([
    "JavaScript exception: Uncaught TypeError",
    "HTTP 503: https://api-staging-882c.up.railway.app/api/visits",
    "net::ERR_CONNECTION_REFUSED: https://localhost/_next/app.js",
  ]);
});

test("distinguishes the expected isolated offline catalogue response", () => {
  expect(hasExpectedOfflineCatalogueResponse({ responses: [
    { status: 408, url: "https://api-staging-882c.up.railway.app/api/places" },
  ] })).toBe(true);
  expect(hasExpectedOfflineCatalogueResponse({ responses: [
    { status: 408, url: "https://api-staging-882c.up.railway.app/api/claims/recommend" },
  ] })).toBe(false);
});
