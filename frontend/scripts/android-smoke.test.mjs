import assert from "node:assert/strict";
import test from "node:test";

import {
  blockingDiagnostics,
  chooseWebViewTarget,
  parseWebViewSocket,
  sanitizedUrl,
} from "./android-smoke.mjs";

test("selects the Parkdex WebView socket and secure local page", () => {
  const sockets = "000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_4321";
  assert.equal(parseWebViewSocket(sockets, "4321"), "webview_devtools_remote_4321");
  assert.equal(parseWebViewSocket(sockets, "9999"), undefined);
  assert.equal(chooseWebViewTarget([
    { type: "page", url: "about:blank" },
    { type: "page", url: "https://localhost/", id: "parkdex" },
  ]).id, "parkdex");
});

test("removes query strings and fragments from diagnostic URLs", () => {
  assert.equal(
    sanitizedUrl("https://staging.parkdex.app/auth/google/callback?code=secret&state=secret#token"),
    "https://staging.parkdex.app/auth/google/callback",
  );
  assert.equal(sanitizedUrl("not a URL"), "");
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
  assert.deepEqual(failures, [
    "JavaScript exception: Uncaught TypeError",
    "HTTP 503: https://api-staging-882c.up.railway.app/api/visits",
    "net::ERR_CONNECTION_REFUSED: https://localhost/_next/app.js",
  ]);
});
