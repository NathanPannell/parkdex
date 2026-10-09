import { HttpError } from "../http.js";

/**
 * A small client for the public content bucket through the Cloudflare REST API
 * (api.cloudflare.com), using CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The dashboard only
 * reads bundles and moves channel pointers; building and uploading bundles stays in
 * scripts/publish-app-bundle.mjs on the operator's machine.
 *
 * The REST object PUT takes no If-Match header, so callers guard writes by reading first and
 * reading back afterwards (see ota.ts).
 */

export const DEFAULT_ASSETS_BUCKET = "parkdex-kip-content";
const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const TIMEOUT_MS = 10_000;
const MAX_LIST_PAGES = 10;
/** Pointers are a few hundred bytes; anything bigger is not one. */
const MAX_OBJECT_BYTES = 64 * 1024;

export interface R2Env {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** The public content bucket behind kip-assets.parkdex.app. */
  ASSETS_BUCKET?: string;
}

export interface R2ObjectInfo {
  key: string;
  size: number;
  /** Unquoted, as R2 reports it. */
  etag: string;
  uploadedAt: string | null;
}

export interface R2Client {
  readonly bucket: string;
  /** The object's text, or null when it does not exist. Only for small JSON objects. */
  getText(key: string): Promise<string | null>;
  putJson(key: string, body: string, cacheControl: string): Promise<void>;
  list(prefix: string): Promise<R2ObjectInfo[]>;
  /** One object's size and ETag, or null. */
  stat(key: string): Promise<R2ObjectInfo | null>;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export function assetsBucket(env: R2Env): string {
  const bucket = env.ASSETS_BUCKET?.trim() || DEFAULT_ASSETS_BUCKET;
  if (!BUCKET.test(bucket)) throw new HttpError(503, "bucket_invalid", "ASSETS_BUCKET is not a valid R2 bucket name.");
  return bucket;
}

export function cloudflareConfigured(env: R2Env): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN?.trim() && env.CLOUDFLARE_ACCOUNT_ID?.trim());
}

/** Strips quotes and a weak prefix so R2 listing ETags and HTTP ETags compare. */
export function bareEtag(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().replace(/^W\//, "").replace(/^"|"$/g, "") || null;
}

export async function timedFetch(fetcher: Fetcher, input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetcher(input, { ...init, signal: controller.signal, redirect: "error" });
  } finally {
    clearTimeout(timer);
  }
}

function objectPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function failure(status: number, action: string): HttpError {
  if (status === 401 || status === 403) {
    return new HttpError(502, "cloudflare_denied", `Cloudflare refused to ${action} (HTTP ${status}). The token needs R2 read and write on the content bucket.`);
  }
  return new HttpError(502, "cloudflare_failed", `Cloudflare could not ${action} (HTTP ${status}).`);
}

export function createCloudflareR2(env: R2Env, fetcher: Fetcher): R2Client | null {
  if (!cloudflareConfigured(env)) return null;
  const account = env.CLOUDFLARE_ACCOUNT_ID!.trim();
  if (!ACCOUNT_ID.test(account)) throw new HttpError(503, "cloudflare_invalid", "CLOUDFLARE_ACCOUNT_ID is not a Cloudflare account id.");
  const bucket = assetsBucket(env);
  const base = `${API}/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}`;
  const auth = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN!.trim()}` };

  async function call(url: string, init: RequestInit, action: string): Promise<Response> {
    let response: Response;
    try {
      response = await timedFetch(fetcher, url, { ...init, headers: { ...auth, ...init.headers as Record<string, string> } });
    } catch {
      throw new HttpError(502, "cloudflare_unreachable", `Cloudflare did not answer in time while trying to ${action}.`);
    }
    return response;
  }

  async function list(prefix: string): Promise<R2ObjectInfo[]> {
    const rows: R2ObjectInfo[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const query = new URLSearchParams({ prefix, per_page: "1000" });
      if (cursor) query.set("cursor", cursor);
      const response = await call(`${base}/objects?${query}`, { method: "GET" }, "list the bucket");
      if (!response.ok) throw failure(response.status, "list the bucket");
      const body = await response.json() as { success?: boolean; result?: unknown; result_info?: { cursor?: unknown; is_truncated?: unknown } };
      if (body.success !== true || !Array.isArray(body.result)) throw new HttpError(502, "cloudflare_failed", "Cloudflare returned an incomplete bucket listing.");
      for (const item of body.result as Array<Record<string, unknown>>) {
        if (typeof item.key !== "string") continue;
        rows.push({
          key: item.key,
          size: Number(item.size ?? 0),
          etag: bareEtag(typeof item.etag === "string" ? item.etag : null) ?? "",
          uploadedAt: typeof item.last_modified === "string" ? item.last_modified : null,
        });
      }
      const next = body.result_info?.is_truncated === true && typeof body.result_info.cursor === "string" ? body.result_info.cursor : null;
      if (!next) return rows;
      if (seen.has(next)) throw new HttpError(502, "cloudflare_failed", "Cloudflare's bucket listing did not advance.");
      seen.add(next);
      cursor = next;
    }
    throw new HttpError(502, "cloudflare_failed", "The bucket listing is longer than the dashboard reads.");
  }

  return {
    bucket,
    async getText(key) {
      const response = await call(`${base}/objects/${objectPath(key)}`, { method: "GET" }, "read the pointer");
      if (response.status === 404) return null;
      if (!response.ok) throw failure(response.status, "read the pointer");
      const text = await response.text();
      if (text.length > MAX_OBJECT_BYTES) throw new HttpError(502, "pointer_invalid", "The stored pointer is too large to be a channel pointer.");
      return text;
    },
    async putJson(key, body, cacheControl) {
      const response = await call(`${base}/objects/${objectPath(key)}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "cache-control": cacheControl },
        body,
      }, "write the pointer");
      if (!response.ok) throw failure(response.status, "write the pointer");
    },
    list,
    async stat(key) {
      return (await list(key)).find((item) => item.key === key) ?? null;
    },
  };
}
