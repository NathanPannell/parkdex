import { HttpError } from "../../worker/validation.js";
import type { BadgeAsset } from "./drafts.js";

/**
 * Badge images follow the same immutable layout as scripts/publish_park_update.py:
 * releases/<sha256>/art/badges/scenes/<slug>.webp on the Kip CDN, uploaded through the
 * Cloudflare R2 API and verified from the public CDN before the park row is written.
 */

export const CDN_ORIGIN = "https://kip-assets.parkdex.app";
export const DEFAULT_ASSETS_BUCKET = "parkdex-kip-content";
const CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface BadgeEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ASSETS_BUCKET?: string;
}

export function badgeUploadsConfigured(env: BadgeEnv): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** A structural check; the Edge runtime cannot decode WebP, so the header and chunk sizes must agree. */
export function assertWebp(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP" ||
    !["VP8 ", "VP8L", "VP8X"].includes(ascii(bytes, 12, 4)) || view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw new HttpError(415, "invalid_webp", "The badge must be a complete WebP image.");
  }
}

export function imageType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "image/png";
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/** A new image always gets a new slug, because a registered slug is immutable. */
export function sceneSlug(parkId: string, sha256: string): string {
  const base = parkId.slice(0, 60).replace(/-+$/g, "");
  return `${base}-${sha256.slice(0, 8)}`;
}

export function badgeAsset(scene: string, sha256: string, byteSize: number): BadgeAsset {
  const objectKey = `releases/${sha256}/art/badges/scenes/${scene}.webp`;
  return {
    logicalPath: `art/badges/scenes/${scene}.webp`,
    objectKey,
    url: `${CDN_ORIGIN}/${objectKey}`,
    sha256,
    byteSize,
    contentType: "image/webp",
  };
}

async function matches(response: Response, asset: BadgeAsset): Promise<boolean> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength === asset.byteSize && await sha256Hex(bytes) === asset.sha256;
}

/** Upload once, never overwrite a different object, then verify the bytes and headers on the CDN. */
export async function uploadAndVerifyBadge(env: BadgeEnv, asset: BadgeAsset, bytes: Uint8Array, fetcher: typeof fetch = fetch): Promise<"uploaded" | "already-present"> {
  if (!badgeUploadsConfigured(env)) {
    throw new HttpError(503, "badge_uploads_off", "Badge publishing needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID on this deployment.");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${env.ASSETS_BUCKET || DEFAULT_ASSETS_BUCKET}/objects/${asset.objectKey}`;
  const auth = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  let outcome: "uploaded" | "already-present" = "already-present";
  const existing = await fetcher(url, { headers: auth });
  if (existing.status === 200) {
    if (!await matches(existing, asset)) throw new HttpError(409, "object_conflict", "A different image already exists at this badge's storage key.");
  } else if (existing.status === 404) {
    const put = await fetcher(url, { method: "PUT", headers: { ...auth, "content-type": asset.contentType, "cache-control": CACHE_CONTROL }, body: new Uint8Array(bytes) });
    if (!put.ok) throw new HttpError(502, "upload_failed", `The badge upload failed (HTTP ${put.status}).`);
    outcome = "uploaded";
  } else {
    throw new HttpError(502, "upload_failed", `Could not check the badge storage (HTTP ${existing.status}).`);
  }
  const cdn = await fetcher(asset.url, { cache: "no-store" });
  if (cdn.status !== 200 || !await matches(cdn, asset)) throw new HttpError(502, "cdn_unverified", "The badge did not come back intact from the CDN.");
  if ((cdn.headers.get("content-type") ?? "").split(";")[0] !== asset.contentType || cdn.headers.get("access-control-allow-origin") !== "*" ||
    !(cdn.headers.get("cache-control") ?? "").includes("immutable")) {
    throw new HttpError(502, "cdn_unverified", "The CDN served the badge without the expected headers.");
  }
  return outcome;
}
