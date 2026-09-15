import { afterEach, describe, expect, it, vi } from "vitest";

import { apiOrigin, isBackendProxyPath, mcpMetadataOptions, proxyBackendRequest } from "./_mcp-proxy";

describe("Cloudflare Pages MCP proxy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires HTTPS except for local development", () => {
    expect(apiOrigin("https://api.example.test/")).toBe("https://api.example.test");
    expect(apiOrigin("http://localhost:8000")).toBe("http://localhost:8000");
    for (const value of ["", "http://api.example.test", "ftp://api.example.test", "https://user@example.test", "https://api.example.test/v1"]) {
      expect(() => apiOrigin(value)).toThrow();
    }
  });

  it("limits the function to the browser API plus public MCP and OAuth surface", () => {
    for (const path of ["/api/places", "/api/auth/config", "/mcp", "/mcp/", "/mcp/events", "/authorize", "/token", "/register", "/revoke", "/oauth/consent", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
      expect(isBackendProxyPath(path)).toBe(true);
    }
    for (const path of ["/", "/api", "/mcp-evil", "/auth/google/callback"]) {
      expect(isBackendProxyPath(path)).toBe(false);
    }
  });

  it("proxies browser API requests through the Pages origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"places":[]}'));
    vi.stubGlobal("fetch", fetchMock);

    await proxyBackendRequest(
      new Request("https://preview.pages.dev/api/places?limit=10"),
      "https://api-staging.example.test",
    );

    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.href).toBe("https://api-staging.example.test/api/places?limit=10");
  });

  it("proxies the original path, query, method, and body to the fixed API origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("upstream", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://staging.parkdex.app/register?version=1", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "staging.parkdex.app" },
      body: '{"client":"test"}',
    });

    const response = await proxyBackendRequest(request, "https://api-staging.example.test");

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://api-staging.example.test/register?version=1");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).has("host")).toBe(false);
    expect(await new Response(init.body).text()).toBe('{"client":"test"}');
  });

  it("returns a CORS preflight and hardened metadata response", async () => {
    const preflight = mcpMetadataOptions();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"issuer":"https://staging.parkdex.app/"}')));
    const response = await proxyBackendRequest(
      new Request("https://staging.parkdex.app/.well-known/oauth-authorization-server"),
      "https://api-staging.example.test",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps upstream same-origin redirects on the public Pages origin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
      status: 307,
      headers: { Location: "http://api-staging.example.test/mcp?transport=sse" },
    })));

    const response = await proxyBackendRequest(
      new Request("https://staging.parkdex.app/mcp/"),
      "https://api-staging.example.test",
    );

    expect(response.headers.get("location")).toBe("/mcp?transport=sse");
  });
});
