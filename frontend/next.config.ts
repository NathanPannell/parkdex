import type { NextConfig } from "next";

const isAndroidBuild = process.env.PARKDEX_ANDROID_BUILD === "1";
const sharedPageExtensions = ["js", "jsx", "ts", "tsx"];

const nextConfig: NextConfig = {
  pageExtensions: isAndroidBuild
    ? sharedPageExtensions
    : [...sharedPageExtensions, "web.ts"],
  output: "export",
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
