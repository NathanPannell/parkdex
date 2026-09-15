import type { NextConfig } from "next";

import { mcpProxyRewrites } from "./lib/mcp-proxy-rewrites";

const isAndroidBuild = process.env.PARKDEX_ANDROID_BUILD === "1";

const nextConfig: NextConfig = {
  ...(isAndroidBuild ? { output: "export" as const, images: { unoptimized: true } } : {}),
  turbopack: {
    root: process.cwd(),
  },
  rewrites() {
    return mcpProxyRewrites(process.env.NEXT_PUBLIC_API_BASE_URL);
  },
};

export default nextConfig;
