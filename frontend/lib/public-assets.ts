/** Android streams public catalogue assets from the matching web environment. */
export function publicAssetUrl(path: string): string {
  const origin = process.env.NEXT_PUBLIC_ASSET_BASE_URL?.replace(/\/$/, "");
  return origin && path.startsWith("/") && !path.startsWith("//") ? `${origin}${path}` : path;
}
