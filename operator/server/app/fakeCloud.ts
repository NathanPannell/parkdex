import { decideUpdate, parseUpdateCheck, validatePointer, type AppBundleChannel } from "../../../worker/appUpdates.js";
import type { KnownBundle, OtaHistoryStore, OtaPublish, OtaPublishInput } from "./history.js";
import { CDN_ORIGIN, UPDATE_ENDPOINTS } from "./ota.js";
import type { Fetcher } from "./r2.js";

/**
 * A stand-in for Cloudflare's R2 REST API, the kip-assets CDN worker and the two update endpoints,
 * backed by one in-memory bucket. Tests use it to drive the pointer move; the local demo uses it
 * so the Updates page has live-looking data. Never used by a deployment.
 */

type StoredObject = { body: Uint8Array; etag: string; uploaded: string };

const encoder = new TextEncoder();

function cfJson(result: unknown, status = 200, info: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ success: status < 400, errors: [], messages: [], result, result_info: info }), { status, headers: { "content-type": "application/json" } });
}

export class FakeBundleCloud {
  readonly objects = new Map<string, StoredObject>();
  /** False mimics the CDN worker that predates app-bundles/ (the live state before its redeploy). */
  servesAppBundles = true;
  /** The CDN's 60 second pointer cache; a Range request skips it, as the real worker does. */
  readonly cdnCache = new Map<string, { object: StoredObject; at: number }>();
  readonly requests: Array<{ method: string; url: string }> = [];
  /** Runs after each pointer PUT, so a test can play a second writer racing the dashboard. */
  afterPut?: (key: string) => void;
  /** Makes the CDN return an older copy even for Range requests, to test a stuck CDN. */
  cdnFrozen = false;
  private counter = 0;

  put(key: string, body: string | Uint8Array, uploaded = new Date().toISOString()) {
    this.counter += 1;
    const bytes = typeof body === "string" ? encoder.encode(body) : body;
    this.objects.set(key, { body: bytes, etag: `${(this.counter * 2654435761 >>> 0).toString(16).padStart(8, "0")}${"0".repeat(24)}`, uploaded });
  }

  readonly fetch: Fetcher = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    this.requests.push({ method, url: url.toString() });
    if (url.hostname === "api.cloudflare.com") return this.cloudflare(url, method, init);
    if (url.origin === CDN_ORIGIN) return this.cdn(url, method, new Headers(init.headers));
    const channel = (Object.entries(UPDATE_ENDPOINTS).find(([, endpoint]) => endpoint === url.toString())?.[0] ?? null) as AppBundleChannel | null;
    if (channel && method === "POST") return this.endpoint(channel, String(init.body ?? ""));
    return new Response("not found", { status: 404 });
  };

  private async cloudflare(url: URL, method: string, init: RequestInit): Promise<Response> {
    const auth = new Headers(init.headers).get("authorization");
    if (auth !== "Bearer test-token") return cfJson(null, 403);
    const match = /^\/client\/v4\/accounts\/[a-f0-9]{32}\/r2\/buckets\/([^/]+)\/objects(?:\/(.+))?$/.exec(url.pathname);
    if (!match) return cfJson(null, 404);
    if (!match[2]) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const rows = [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, object]) => ({ key, size: object.body.byteLength, etag: object.etag, last_modified: object.uploaded, http_metadata: {} }));
      return cfJson(rows, 200, { is_truncated: false, cursor: "" });
    }
    const key = match[2].split("/").map(decodeURIComponent).join("/");
    if (method === "GET") {
      const object = this.objects.get(key);
      return object ? new Response(object.body.slice(), { status: 200, headers: { etag: `"${object.etag}"` } }) : cfJson(null, 404);
    }
    if (method === "PUT") {
      const body = init.body;
      this.put(key, typeof body === "string" ? body : new Uint8Array(await new Response(body as BodyInit).arrayBuffer()));
      this.afterPut?.(key);
      return cfJson({ key }, 200);
    }
    return cfJson(null, 405);
  }

  private cdn(url: URL, method: string, headers: Headers): Response {
    const path = url.pathname.slice(1);
    const pointer = /^app-bundles\/channels\/(staging|production)\/current\.json$/.test(path);
    const zip = /^app-bundles\/[a-f0-9]{64}\.zip$/.test(path);
    const routed = this.servesAppBundles && (pointer || zip);
    if (method === "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: routed && pointer ? "GET, HEAD" : "GET, HEAD, OPTIONS" } });
    if (!routed) return new Response("Not Found", { status: 404 });
    let object = this.objects.get(path);
    if (pointer && object) {
      const cached = this.cdnCache.get(path);
      const fresh = cached && Date.now() - cached.at < 60_000;
      if (cached && (this.cdnFrozen || (fresh && !headers.has("range")))) object = cached.object;
      else if (!headers.has("range")) this.cdnCache.set(path, { object, at: Date.now() });
    }
    if (!object) return new Response("Not Found", { status: 404 });
    const responseHeaders = { etag: `"${object.etag}"`, "content-length": String(object.body.byteLength), "x-content-cache": "MISS" };
    if (method === "HEAD") return new Response(null, { status: 200, headers: responseHeaders });
    return new Response(object.body.slice(), { status: headers.has("range") ? 206 : 200, headers: responseHeaders });
  }

  private endpoint(channel: AppBundleChannel, body: string): Response {
    let parsed: unknown = null;
    try { parsed = JSON.parse(body); } catch { /* invalid below */ }
    const check = parseUpdateCheck(parsed);
    if (!check) return Response.json({ kind: "failed", error: "invalid_request" }, { status: 400 });
    const object = this.servesAppBundles ? this.objects.get(`app-bundles/channels/${channel}/current.json`) : undefined;
    let pointer = null;
    if (object) {
      pointer = validatePointer(JSON.parse(new TextDecoder().decode(object.body)), channel, CDN_ORIGIN);
      if (!pointer) return Response.json({ kind: "failed", error: "pointer_unavailable" }, { status: 503 });
    }
    const answer = decideUpdate(check, pointer);
    return Response.json(answer.body, { status: answer.status });
  }
}

/** In-memory publish history with the same rules as the SQL store. */
export class MemoryOtaHistory implements OtaHistoryStore {
  readonly rows: OtaPublish[] = [];
  ready = true;

  async available() { return this.ready; }

  async list(limit: number) {
    return [...this.rows].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id - a.id).slice(0, limit);
  }

  async bundles(): Promise<KnownBundle[]> {
    const bySha = new Map<string, OtaPublish[]>();
    for (const row of this.rows) if (row.outcome !== "conflict") bySha.set(row.sha256, [...(bySha.get(row.sha256) ?? []), row]);
    return [...bySha.entries()].map(([sha256, rows]) => {
      const newest = [...rows].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id - a.id)[0];
      return {
        sha256, version: newest.version, sourceCommit: newest.sourceCommit, byteSize: newest.byteSize,
        minimumNativeBuild: Math.max(...rows.map((row) => row.minimumNativeBuild)), maximumNativeBuild: newest.maximumNativeBuild,
        channels: [...new Set(rows.map((row) => row.channel))], lastPublishedAt: newest.publishedAt,
      };
    });
  }

  async record(input: OtaPublishInput, recordedAt = new Date().toISOString()) {
    if (this.rows.some((row) => row.channel === input.channel && row.generation === input.generation && row.sha256 === input.sha256)) return null;
    const row = { ...input, id: this.rows.length + 1, recordedAt };
    this.rows.push(row);
    return row;
  }
}
