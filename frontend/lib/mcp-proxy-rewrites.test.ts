import { describe, expect, it } from "vitest";

import { mcpProxyRewrites } from "./mcp-proxy-rewrites";

describe("mcpProxyRewrites", () => {
  it("proxies the MCP transport and complete OAuth surface to the API origin", () => {
    expect(mcpProxyRewrites("https://api-staging.example.test/")).toEqual([
      {
        source: "/mcp/:path*",
        destination: "https://api-staging.example.test/mcp/:path*",
      },
      {
        source: "/authorize",
        destination: "https://api-staging.example.test/authorize",
      },
      {
        source: "/token",
        destination: "https://api-staging.example.test/token",
      },
      {
        source: "/register",
        destination: "https://api-staging.example.test/register",
      },
      {
        source: "/revoke",
        destination: "https://api-staging.example.test/revoke",
      },
      {
        source: "/oauth/consent",
        destination: "https://api-staging.example.test/oauth/consent",
      },
    ]);
  });

  it.each([undefined, "", "ftp://api.example.test", "https://api.example.test/v1"])(
    "rejects an invalid API origin: %s",
    (value) => {
      expect(() => mcpProxyRewrites(value)).toThrow();
    },
  );
});
