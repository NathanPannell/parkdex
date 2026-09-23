import { afterEach, describe, expect, it, vi } from "vitest";

import { mcpMetadataOptions, proxyMcpMetadata } from "./mcp-metadata-proxy";

describe("MCP metadata proxy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [
      "https://parkdex.app",
      "https://api-production.example.test",
      "https://parkdex.app/mcp",
    ],
    [
      "https://staging.parkdex.app",
      "https://api-staging.example.test",
      "https://staging.parkdex.app/mcp",
    ],
    [
      "https://staging.web.parkdex.app",
      "https://api-staging.example.test",
      "https://staging.parkdex.app/mcp",
    ],
  ])(
    "fetches metadata for %s from the matching API without following redirects",
    async (requestOrigin, apiOrigin, resource) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ resource }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await proxyMcpMetadata(
        new Request(`${requestOrigin}/.well-known/oauth-protected-resource/mcp?version=1`),
        apiOrigin,
      );

      expect(fetchMock).toHaveBeenCalledWith(
        new URL(`${apiOrigin}/.well-known/oauth-protected-resource/mcp?version=1`),
        {
          headers: { Accept: "application/json" },
          cache: "no-store",
          redirect: "manual",
        },
      );
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      await expect(response.json()).resolves.toEqual({ resource });
    },
  );

  it("returns a CORS preflight for browser-based MCP clients", () => {
    const response = mcpMetadataOptions();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
