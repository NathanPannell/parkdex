import { Capacitor, registerPlugin } from "@capacitor/core";
import { Network } from "@capacitor/network";
import { CONTENT_CDN_ORIGIN } from "./contracts";

const DEFAULT_API_URL = "https://parkdex-kip-staging.vercel.app/api/content/current";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BRIDGED_BASE64_CHARS = Math.ceil((MAX_RESPONSE_BYTES * 4) / 3) + 4;

type NativeWifiStatus = { wifi: boolean };
type NativeContentResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
  url: string;
};

type NativeContentTransport = {
  getWifiStatus(): Promise<NativeWifiStatus>;
  request(options: {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    approvedApiOrigin: string;
    approvedCdnOrigin: string;
    maxResponseBytes: number;
    timeoutMs: number;
  }): Promise<NativeContentResponse>;
  abort(options: { requestId: string }): Promise<void>;
};

const NativeTransport = registerPlugin<NativeContentTransport>("WifiContentTransport");
let nextRequestId = 0;

/** Return true only when the current native or browser network is affirmatively Wi-Fi. */
export async function isContentWifiAvailable(): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    if (Capacitor.getPlatform() !== "android") return false;
    try {
      return (await NativeTransport.getWifiStatus()).wifi === true;
    } catch {
      return false;
    }
  }

  try {
    const status = await Network.getStatus();
    return status.connected === true && status.connectionType === "wifi";
  } catch {
    return false;
  }
}

/** Fetch content through Android's Wi-Fi-bound network, or through a Wi-Fi-gated browser fetch. */
export async function contentFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
  const url = new URL(request.url);
  const apiOrigin = getContentApiOrigin();
  if (!apiOrigin) throw new Error("The content API is not configured for this environment.");
  assertApprovedContentUrl(url, apiOrigin, CONTENT_CDN_ORIGIN);
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new TypeError("Content transport only permits GET and HEAD requests");
  }
  if (request.body !== null) throw new TypeError("Content transport does not accept request bodies");
  throwIfAborted(request.signal);

  if (Capacitor.isNativePlatform()) {
    if (Capacitor.getPlatform() !== "android") {
      throw new Error("Wi-Fi-only content transport is unavailable on this native platform");
    }
    return nativeFetch(request, url, apiOrigin);
  }

  if (!(await isContentWifiAvailable())) throw wifiUnavailableError();
  throwIfAborted(request.signal);
  return globalThis.fetch(url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    redirect: "error",
    credentials: "omit",
    cache: request.cache,
  });
}

async function nativeFetch(request: Request, url: URL, apiOrigin: string): Promise<Response> {
  const requestId = createRequestId();
  const pending = NativeTransport.request({
    requestId,
    url: url.href,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    approvedApiOrigin: apiOrigin,
    approvedCdnOrigin: CONTENT_CDN_ORIGIN,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    timeoutMs: 20_000,
  });

  const signal = request.signal;
  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    abortHandler = () => {
      void NativeTransport.abort({ requestId }).catch(() => {});
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    if (signal.aborted) abortHandler();
  });

  try {
    const nativeResponse = await Promise.race([pending, aborted]);
    throwIfAborted(signal);
    if (nativeResponse.status < 200 || nativeResponse.status > 599) {
      throw new Error("The native content transport returned an invalid HTTP status");
    }
    if (nativeResponse.status >= 300 && nativeResponse.status < 400 && nativeResponse.status !== 304) {
      throw new Error("Content server redirects are not permitted");
    }
    const bytes = decodeBase64Body(nativeResponse.bodyBase64);
    const body = request.method === "HEAD" || [204, 205, 304].includes(nativeResponse.status) ? null : bytes;
    const response = new Response(body, {
      status: nativeResponse.status,
      statusText: nativeResponse.statusText,
      headers: nativeResponse.headers,
    });
    Object.defineProperty(response, "url", { value: nativeResponse.url || url.href });
    return response;
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}

export function getContentApiOrigin(): string | null {
  const explicit = import.meta.env.VITE_CONTENT_API_URL?.trim();
  const nativeOrDevelopment = Capacitor.isNativePlatform() || import.meta.env.DEV;
  if (!explicit && import.meta.env.VITE_CONTENT_ENV === "main" && nativeOrDevelopment) return null;
  const configured = explicit || (nativeOrDevelopment ? DEFAULT_API_URL : "/api/content/current");
  if (nativeOrDevelopment && explicit && !/^https:\/\//i.test(explicit)) return null;
  if (!explicit && !nativeOrDevelopment && typeof globalThis.location === "undefined") return null;
  const base = typeof globalThis.location === "undefined" ? DEFAULT_API_URL : globalThis.location.href;
  let url: URL;
  try {
    url = new URL(configured, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) {
    return null;
  }
  return url.origin;
}

function assertApprovedContentUrl(url: URL, apiOrigin: string, cdnOrigin: string): void {
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) {
    throw new TypeError("Content downloads require an approved HTTPS URL");
  }
  if (url.origin === apiOrigin) return;
  if (url.origin === cdnOrigin && cdnOrigin === CONTENT_CDN_ORIGIN && url.hostname.toLowerCase() === "kip-assets.parkdex.app") return;
  throw new TypeError("The content URL origin is not approved");
}

function decodeBase64Body(encoded: string): ArrayBuffer {
  if (typeof encoded !== "string" || encoded.length > MAX_BRIDGED_BASE64_CHARS) {
    throw new RangeError("The bridged content response exceeds its byte limit");
  }
  const binary = globalThis.atob(encoded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new RangeError("The bridged content response exceeds its byte limit");
  return buffer;
}

function createRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  nextRequestId += 1;
  return `content-${Date.now()}-${nextRequestId}`;
}

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException("The content request was aborted", "AbortError");
}

function wifiUnavailableError(): Error {
  const error = new Error("Connect to Wi-Fi to download Parkdex content.");
  error.name = "WifiUnavailableError";
  return error;
}
