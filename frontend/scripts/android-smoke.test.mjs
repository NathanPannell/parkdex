import { expect, test } from "vitest";

import {
  blockingDiagnostics,
  chooseWebViewTarget,
  hasExpectedOfflineCatalogueResponse,
  hasPreviewAuthJourney,
  hasLiveClaimImportJourney,
  countEndpointResponses,
  hasNewEndpointResponse,
  isAllowedLocalRuntimeEndpoints,
  isAllowedClaimFixture,
  isAllowedPreviewApiUrl,
  isFullCommitSha,
  previewReadyMatches,
  releaseFooterMatches,
  isTrackedApplicationUrl,
  syntheticAccountEmail,
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

test("allows only the PR 20 Railway preview origin", () => {
  expect(isAllowedPreviewApiUrl("https://api-pr-20-152f.up.railway.app")).toBe(true);
  expect(isAllowedPreviewApiUrl("https://api-pr-21-152f.up.railway.app")).toBe(false);
  expect(isAllowedPreviewApiUrl("https://api-pr-20-152f.up.railway.app.attacker.test")).toBe(false);
  expect(isAllowedPreviewApiUrl("http://api-pr-20-152f.up.railway.app")).toBe(false);
});

test("allows only the fixed local runtime endpoint pair", () => {
  expect(isAllowedLocalRuntimeEndpoints("https://10.0.2.2:8443", "https://127.0.0.1:8443")).toBe(true);
  expect(isAllowedLocalRuntimeEndpoints("https://127.0.0.1:8443", "https://127.0.0.1:8443")).toBe(false);
  expect(isAllowedLocalRuntimeEndpoints("http://10.0.2.2:8443", "https://127.0.0.1:8443")).toBe(false);
  expect(isAllowedLocalRuntimeEndpoints("https://10.0.2.2:8443", "https://localhost:8443")).toBe(false);
});

test("allows only the named guarded claim fixture", () => {
  expect(isAllowedClaimFixture("inside-goldstream")).toBe(true);
  expect(isAllowedClaimFixture("inside-saltspring")).toBe(false);
  expect(isAllowedClaimFixture("")).toBe(false);
});

test("treats the emulator TLS API as an application diagnostic origin", () => {
  expect(isTrackedApplicationUrl("https://10.0.2.2:8443/api/auth/me")).toBe(true);
  expect(isTrackedApplicationUrl("https://127.0.0.1:8443/ready")).toBe(false);
});

test("requires live registration and restart authentication responses", () => {
  const api = "https://api-pr-20-152f.up.railway.app";
  expect(hasPreviewAuthJourney({ responses: [
    { status: 201, url: `${api}/api/auth/register` },
    { status: 200, url: `${api}/api/auth/me` },
  ] }, api)).toBe(true);
  expect(hasPreviewAuthJourney({ responses: [
    { status: 201, url: `${api}/api/auth/register` },
  ] }, api)).toBe(false);
});

test("requires real fixture recommendation, claim, and guest import responses", () => {
  const api = "https://api-pr-20-152f.up.railway.app";
  expect(hasLiveClaimImportJourney({ responses: [
    { status: 200, url: `${api}/api/claim-recommendations` },
    { status: 200, url: `${api}/api/claims` },
    { status: 200, url: `${api}/api/account/import-guest` },
  ] }, api)).toBe(true);
  expect(hasLiveClaimImportJourney({ responses: [
    { status: 200, url: `${api}/api/claim-recommendations` },
    { status: 201, url: `${api}/api/claims` },
    { status: 200, url: `${api}/api/account/import-guest` },
  ] }, api)).toBe(false);
});

test("waits for a distinct completed recommendation before advancing", () => {
  const endpoint = "https://10.0.2.2:8443/api/claim-recommendations";
  const diagnostics = { responses: [{ status: 200, url: endpoint }] };
  const beforeFixture = countEndpointResponses(diagnostics, endpoint);
  expect(beforeFixture).toBe(1);
  expect(hasNewEndpointResponse(diagnostics, endpoint, beforeFixture)).toBe(false);
  diagnostics.responses.push({ status: 204, url: endpoint });
  expect(hasNewEndpointResponse(diagnostics, endpoint, beforeFixture)).toBe(false);
  diagnostics.responses.push({ status: 200, url: "https://10.0.2.2:8443/api/places" });
  expect(hasNewEndpointResponse(diagnostics, endpoint, beforeFixture)).toBe(false);
  diagnostics.responses.push({ status: 200, url: endpoint });
  expect(hasNewEndpointResponse(diagnostics, endpoint, beforeFixture)).toBe(true);
});

test("requires one exact full commit identity from API readiness", () => {
  const expected = "a".repeat(40);
  expect(isFullCommitSha(expected)).toBe(true);
  expect(isFullCommitSha("a".repeat(39))).toBe(false);
  expect(previewReadyMatches({ status: "ready", commit: expected }, expected)).toBe(true);
  expect(previewReadyMatches({ status: "ready", commit: "b".repeat(40) }, expected)).toBe(false);
  expect(previewReadyMatches({ status: "starting", commit: expected }, expected)).toBe(false);
});

test("rejects a stale commit in the visible Account release footer", () => {
  const expected = "1234567" + "a".repeat(33);
  expect(releaseFooterMatches("Parkdex v0.1.123 · 1234567 · Sep 8, 2026", expected)).toBe(true);
  expect(releaseFooterMatches("Parkdex v0.1.123 · 7654321 · Sep 8, 2026", expected)).toBe(false);
});

test("generates a unique-shaped account only in the accepted example domain", () => {
  expect(syntheticAccountEmail("123e4567-e89b-12d3-a456-426614174000"))
    .toBe("android-smoke-123e4567-e89b-12d3-a456-426614174000@example.com");
});
