import type { NextConfig } from "next";

import { mcpProxyRewrites } from "./lib/mcp-proxy-rewrites";

const isAndroidBuild = process.env.PARKDEX_ANDROID_BUILD === "1";
const isCloudflareBuild = process.env.PARKDEX_CLOUDFLARE_BUILD === "1";
const isStaticBuild = isAndroidBuild || isCloudflareBuild;
const sharedPageExtensions = ["js", "jsx", "ts", "tsx"];
const nextConfig: NextConfig = {
  // Catalogue assets are already sized. The application owns bounded offline copies.
  images: { unoptimized: true },
  pageExtensions: isStaticBuild
    ? sharedPageExtensions
    : [...sharedPageExtensions, "web.ts"],
  ...(isStaticBuild
    ? { output: "export" as const }
    : {
        async headers() {
          return ["/places/:path*", "/data/:path*"].map((source) => ({ source, headers: [
            { key: "Cache-Control", value: "no-store" },
            { key: "Access-Control-Allow-Origin", value: "*" },
          ] }));
        },
        rewrites() {
          return mcpProxyRewrites(process.env.NEXT_PUBLIC_API_BASE_URL);
        },
      }),
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
