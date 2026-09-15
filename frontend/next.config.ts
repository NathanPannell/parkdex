import type { NextConfig } from "next";

import { mcpProxyRewrites } from "./lib/mcp-proxy-rewrites";

const isAndroidBuild = process.env.PARKDEX_ANDROID_BUILD === "1";
const isCloudflareBuild = process.env.PARKDEX_CLOUDFLARE_BUILD === "1";
const isStaticBuild = isAndroidBuild || isCloudflareBuild;
const sharedPageExtensions = ["js", "jsx", "ts", "tsx"];
const nextConfig: NextConfig = {
  pageExtensions: isStaticBuild
    ? sharedPageExtensions
    : [...sharedPageExtensions, "web.ts"],
  ...(isStaticBuild
    ? { output: "export" as const, images: { unoptimized: true } }
    : {
        rewrites() {
          return mcpProxyRewrites(process.env.NEXT_PUBLIC_API_BASE_URL);
        },
      }),
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
