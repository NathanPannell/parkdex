import type { NextConfig } from "next";

const isAndroidBuild = process.env.PARKDEX_ANDROID_BUILD === "1";

const nextConfig: NextConfig = {
  ...(isAndroidBuild ? { output: "export" as const, images: { unoptimized: true } } : {}),
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
