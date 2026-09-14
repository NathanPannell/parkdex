import type { NextConfig } from "next";

import { mcpProxyRewrites } from "./lib/mcp-proxy-rewrites";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  rewrites() {
    return mcpProxyRewrites(process.env.NEXT_PUBLIC_API_BASE_URL);
  },
};

export default nextConfig;
