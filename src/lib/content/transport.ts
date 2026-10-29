import { Capacitor, registerPlugin } from "@capacitor/core";
import { Network } from "@capacitor/network";
import {
  canDownloadContent,
  CONTENT_CDN_ORIGIN,
  contentTransportPausedError,
  requiresContentWifi,
  type Connectivity,
  type ContentRequestInit,
} from "./contracts";
import { contentChannelOverride } from "../contentChannel";
import { KIP_PRODUCTION_ORIGIN, KIP_STAGING_ORIGIN } from "../userDataDestination";
import { withRequestContext } from "../requestContext";

const DEFAULT_API_URL = "https://staging.web.parkdex.app/api/content/current";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BRIDGED_BASE64_CHARS = Math.ceil((MAX_RESPONSE_BYTES * 4) / 3) + 4;

export type ContentConnectivity = Connectivity;
type BrowserNetworkInformation = EventTarget & { type?: string; effectiveType?: string };

type NativeWifiStatus = { wifi: boolean };
type NativeContentResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
  url: string;
};

export type NativeAccountBackupRequestOptions = {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64: string;
  approvedApiOrigin: string;
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
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
    /** Lets a detailed map chunk use any validated network instead of Wi-Fi only. */
    anyNetwork: boolean;
  }): Promise<NativeContentResponse>;
  accountRequest(options: NativeAccountBackupRequestOptions): Promise<NativeContentResponse>;
  abort(options: { requestId: string }): Promise<void>;
};

const NativeTransport = registerPlugin<NativeContentTransport>("WifiContentTransport");

/** Android and iOS both ship the WifiContentTransport plugin, with the same rules. */
export function hasNativeContentTransport(platform = Capacitor.getPlatform()): boolean {
  return platform === "android" || platform === "ios";
}
let nextRequestId = 0;

// Native builds up to vc14 stop content requests on Activity pause, which a permission dialog
// causes while Parkdex stays visible. The web layer only sees a stop as backgrounding.
const NATIVE_FOREGROUND_REJECTIONS = new Set([
  "Content requests stop when Parkdex leaves the foreground",
  "Content requests require Parkdex to be in the foreground",
]);

function isNativeForegroundRejection(error: unknown): boolean {
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : error;
  return typeof message === "string" && NATIVE_FOREGROUND_REJECTIONS.has(message.trim());
}

/** Account backup shares the Wi-Fi plugin registration but keeps its own strict native request method. */
export function nativeAccountBackupRequest(options: NativeAccountBackupRequestOptions): Promise<NativeContentResponse> {
  return NativeTransport.accountRequest(options);
}

export function abortNativeAccountBackupRequest(requestId: string): Promise<void> {
  return NativeTransport.abort({ requestId });
}

function browserNetworkInformation(): BrowserNetworkInformation | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: BrowserNetworkInformation }).connection;
}

function readBrowserConnectivity(): ContentConnectivity {
  const connected = typeof navigator !== "undefined" && navigator.onLine === true;
  const connection = browserNetworkInformation();
  return {
    connected,
    wifi: connected && connection?.type === "wifi",
    contentDownloadAllowed: connected,
  };
}

/** Report connectivity without treating an effective connection speed as a network type. */
export async function getContentConnectivity(): Promise<ContentConnectivity> {
  if (!Capacitor.isNativePlatform()) return readBrowserConnectivity();
  if (!hasNativeContentTransport()) return { connected: false, wifi: false, contentDownloadAllowed: false };

  const [networkResult, wifiResult] = await Promise.allSettled([Network.getStatus(), NativeTransport.getWifiStatus()]);
  const connected = networkResult.status === "fulfilled" && networkResult.value.connected === true;
  const wifi = wifiResult.status === "fulfilled" && wifiResult.value.wifi === true;
  const connectedOrWifi = connected || wifi;
  return { connected: connectedOrWifi, wifi, contentDownloadAllowed: connectedOrWifi };
}

/** Subscribe to online state and the browser's physical network type, or native network changes. */
export function subscribeContentConnectivity(listener: (connectivity: ContentConnectivity) => void): () => void {
  if (Capacitor.isNativePlatform()) {
    if (!hasNativeContentTransport()) {
      listener({ connected: false, wifi: false, contentDownloadAllowed: false });
      return () => {};
    }

    let active = true;
    let networkListener: { remove: () => Promise<void> } | undefined;
    const publish = () => {
      void getContentConnectivity().then((connectivity) => {
        if (active) listener(connectivity);
      });
    };
    publish();
    void Network.addListener("networkStatusChange", publish)
      .then((handle) => {
        if (active) networkListener = handle;
        else void handle.remove();
      })
      .catch(() => {});
    return () => {
      active = false;
      void networkListener?.remove();
    };
  }

  const publish = () => listener(readBrowserConnectivity());
  const browserWindow = typeof window === "undefined" ? undefined : window;
  const connection = browserNetworkInformation();
  browserWindow?.addEventListener("online", publish);
  browserWindow?.addEventListener("offline", publish);
  connection?.addEventListener("change", publish);
  publish();
  return () => {
    browserWindow?.removeEventListener("online", publish);
    browserWindow?.removeEventListener("offline", publish);
    connection?.removeEventListener("change", publish);
  };
}

/** Convenience check for callers that need to display the physical Wi-Fi signal. */
export async function isContentWifiAvailable(): Promise<boolean> {
  return (await getContentConnectivity()).wifi;
}

/** Convenience gate for content downloads under the current platform's network policy. */
export async function isContentDownloadAvailable(): Promise<boolean> {
  return canDownloadContent(await getContentConnectivity());
}

/** Download essential content on any connection; bind detailed map chunks to Wi-Fi unless a request allows any network. */
export async function contentFetch(input: RequestInfo | URL, init?: ContentRequestInit): Promise<Response> {
  const { anyNetwork = false, ...requestInit } = init ?? {};
  const request = input instanceof Request ? new Request(input, requestInit) : new Request(input, requestInit);
  const url = new URL(request.url);
  const apiOrigin = getContentApiOrigin();
  if (!apiOrigin) throw new Error("The content API is not configured for this environment.");
  assertApprovedContentUrl(url, apiOrigin, CONTENT_CDN_ORIGIN);
  // Only our API gets the labels; the CDN's CORS rules do not allow extra headers.
  if (url.origin === apiOrigin) withRequestContext(request.headers);
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new TypeError("Content transport only permits GET and HEAD requests");
  }
  // Firefox can expose a bodyless Request.body as undefined when its stream getter is unavailable.
  if (request.body != null) throw new TypeError("Content transport does not accept request bodies");
  throwIfAborted(request.signal);

  if (Capacitor.isNativePlatform()) {
    if (!hasNativeContentTransport()) {
      throw new Error("Content transport is unavailable on this native platform");
    }
    return nativeFetch(request, url, apiOrigin, anyNetwork);
  }

  return browserFetch(request, url, anyNetwork);
}

async function browserFetch(request: Request, url: URL, anyNetwork: boolean): Promise<Response> {
  const allowed = (connectivity: ContentConnectivity) =>
    canDownloadContent(connectivity) && (anyNetwork || !requiresContentWifi(url.pathname) || connectivity.wifi);
  const initialConnectivity = await getContentConnectivity();
  if (!allowed(initialConnectivity)) throw contentUnavailableError(initialConnectivity);
  throwIfAborted(request.signal);

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    controller.abort(new DOMException("Content download timed out. Retrying is safe.", "TimeoutError"));
  }, 60_000);
  const abortForConnectivity = (connectivity: ContentConnectivity) => {
    if (!controller.signal.aborted) controller.abort(contentUnavailableError(connectivity));
  };
  const abortForCaller = () => {
    if (!controller.signal.aborted) controller.abort(abortReason(request.signal));
  };
  const onConnectivity = (connectivity: ContentConnectivity) => {
    if (!allowed(connectivity)) abortForConnectivity(connectivity);
  };
  const unsubscribe = subscribeContentConnectivity(onConnectivity);
  request.signal.addEventListener("abort", abortForCaller, { once: true });

  try {
    if (request.signal.aborted) abortForCaller();
    const connectivity = await getContentConnectivity();
    if (!allowed(connectivity)) abortForConnectivity(connectivity);
    if (controller.signal.aborted) throw abortReason(controller.signal);

    const response = await globalThis.fetch(url, {
      method: request.method,
      headers: request.headers,
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      cache: request.cache,
    });
    if (response.status < 200 || response.status > 599) {
      throw new Error("The browser content transport returned an invalid HTTP status");
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      throw new Error("Content server redirects are not permitted");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      const error = new RangeError("The content response exceeds its byte limit");
      controller.abort(error);
      if (response.body) void response.body.cancel(error).catch(() => {});
      throw error;
    }
    const bytes = await readBoundedResponseBody(response, MAX_RESPONSE_BYTES, (error) => controller.abort(error));
    if (controller.signal.aborted) throw abortReason(controller.signal);

    const body = request.method === "HEAD" || [204, 205, 304].includes(response.status) ? null : bytes;
    const bufferedResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperty(bufferedResponse, "url", { value: response.url || url.href });
    return bufferedResponse;
  } catch (error) {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    unsubscribe();
    request.signal.removeEventListener("abort", abortForCaller);
  }
}

async function readBoundedResponseBody(response: Response, maxBytes: number, abort: (reason: unknown) => void): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (byteLength + value.byteLength > maxBytes) {
        const error = new RangeError("The content response exceeds its byte limit");
        abort(error);
        void reader.cancel(error).catch(() => {});
        throw error;
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* A failed stream may keep its reader locked. */
    }
  }

  const buffer = new ArrayBuffer(byteLength);
  const output = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

async function nativeFetch(request: Request, url: URL, apiOrigin: string, anyNetwork: boolean): Promise<Response> {
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
    anyNetwork,
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
    if (isNativeForegroundRejection(error)) throw contentTransportPausedError();
    throw error;
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}

export function getContentApiOrigin(): string | null {
  // A build remotely switched to the other content database reads that environment's host.
  const override = contentChannelOverride();
  if (override) return override === "main" ? KIP_PRODUCTION_ORIGIN : KIP_STAGING_ORIGIN;
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
  const error = new Error("Connect to Wi-Fi to download detailed maps.");
  error.name = "WifiUnavailableError";
  return error;
}

function contentUnavailableError(connectivity: ContentConnectivity): Error {
  if (connectivity.connected && !connectivity.wifi) return wifiUnavailableError();
  const error = new Error("Content downloads are unavailable while offline.");
  error.name = "ContentOfflineError";
  return error;
}
