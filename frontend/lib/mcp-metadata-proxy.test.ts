import { afterEach, describe, expect, it, vi } from "vitest";

import { mcpMetadataOptions, proxyMcpMetadata } from "./mcp-metadata-proxy";

describe("MCP metadata proxy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the matching metadata path from the API without following redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"resource":"https://staging.parkdex.app/mcp"}', {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyMcpMetadata(
      new Request(
        "https://staging.parkdex.app/.well-known/oauth-protected-resource/mcp?version=1",
      ),
      "https://api-staging.example.test",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "https://api-staging.example.test/.well-known/oauth-protected-resource/mcp?version=1",
      ),
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
        redirect: "manual",
      },
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      resource: "https://staging.parkdex.app/mcp",
    });
  });

  it("returns a CORS preflight for browser-based MCP clients", () => {
    const response = mcpMetadataOptions();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
