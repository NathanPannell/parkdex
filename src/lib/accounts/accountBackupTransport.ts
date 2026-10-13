import { Capacitor } from "@capacitor/core";
import {
  abortNativeAccountBackupRequest,
  getContentConnectivity,
  nativeAccountBackupRequest,
  subscribeContentConnectivity,
} from "../content/transport";
import { isAccountBackupAvailable, mapAccountBackupConnectivity } from "./accountBackupConnectivity";
import { isDevLoopbackHttp } from "../userDataDestination";

const MAX_ACCOUNT_BACKUP_BYTES = 2_621_440;
const MAX_CLAIM_JSON_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

let nextRequestId = 0;

const CLAIM_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLAIM_RECORD_PATH = new RegExp(`^/api/claims/${CLAIM_ID}$`, "i");
const PHOTO_PATH = new RegExp(`^/api/claims/${CLAIM_ID}/photo$`, "i");
const DISPLAY_PATH = new RegExp(`^/api/claims/${CLAIM_ID}/display$`, "i");

/** `displays` and `display` back up each photo's crop, cover and removal (#174). */
type RouteKind = "claims" | "claim" | "photo" | "displays" | "display";

/** Returns true for the account-claims namespace, including malformed routes that must fail closed. */
export function isAccountBackupPath(url: URL): boolean {
  return url.pathname.startsWith("/api/claims");
}

/** Validate the small set of account endpoints permitted to use the account backup transport. */
export function assertAccountBackupRequest(url: URL, method: string, approvedApiOrigin: string): RouteKind {
  let apiOrigin: string;
  let devLoopback = false;
  try {
    const configured = new URL(approvedApiOrigin);
    devLoopback = isDevLoopbackHttp(configured) && !configured.search && !configured.hash && ["", "/"].includes(configured.pathname);
    if ((configured.protocol !== "https:" && !devLoopback) || configured.username || configured.password || configured.search || configured.hash ||
        (configured.port && configured.port !== "443" && !devLoopback) || !["", "/"].includes(configured.pathname)) throw new Error();
    apiOrigin = configured.origin;
  } catch {
    throw new Error("Account backup requires a configured HTTPS API origin.");
  }

  if ((url.protocol !== "https:" && !devLoopback) || url.origin !== apiOrigin || url.username || url.password || url.href.includes("#") ||
      (url.port && url.port !== "443" && !devLoopback)) {
    throw new Error("Account backup must use the configured HTTPS account API.");
  }

  const normalizedMethod = method.toUpperCase();
  if (url.pathname === "/api/claims") {
    if (normalizedMethod !== "GET") throw new Error("The account collection only permits GET requests.");
    const query = url.href.includes("?") ? url.search.slice(1) : null;
    if (query !== null && !/^cursor=[A-Za-z0-9_-]{1,1024}$/.test(query)) {
      throw new Error("The account collection cursor is invalid.");
    }
    return "claims";
  }

  if (url.pathname === "/api/claims/display") {
    if (normalizedMethod !== "GET" || url.href.includes("?")) throw new Error("Photo display choices only permit GET requests to the exact list route.");
    return "displays";
  }

  if (DISPLAY_PATH.test(url.pathname)) {
    if (normalizedMethod !== "PUT" || url.href.includes("?")) throw new Error("A photo's display choices only permit PUT requests to an exact route.");
    return "display";
  }

  if (CLAIM_RECORD_PATH.test(url.pathname)) {
    if (normalizedMethod !== "PUT" || url.href.includes("?")) throw new Error("Saved claims only permit PUT requests to an exact claim route.");
    return "claim";
  }

  if (PHOTO_PATH.test(url.pathname)) {
    if (!(["GET", "PUT"] as string[]).includes(normalizedMethod) || url.href.includes("?")) {
      throw new Error("Saved photos only permit GET or PUT requests to an exact photo route.");
    }
    return "photo";
  }

  throw new Error("The account backup route is not approved.");
}

/** Route account claims and private photos through the platform's account backup policy. */
export async function accountBackupFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  approvedApiOrigin: string,
): Promise<Response> {
  const sourceRequest = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
  const rawUrl = sourceRequest?.url ?? String(input);
  const url = new URL(rawUrl, approvedApiOrigin);
  const method = (init.method ?? sourceRequest?.method ?? "GET").toUpperCase();
  const route = assertAccountBackupRequest(url, method, approvedApiOrigin);
  const headers = new Headers(sourceRequest?.headers);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const callerSignal = init.signal ?? sourceRequest?.signal ?? null;
  assertAccountBackupContentType(headers, route, method);
  const body = await readRequestBody(input, { ...init, method }, method, callerSignal);
  if (method === "GET" && body.byteLength !== 0) throw new TypeError("Account backup GET requests cannot contain a body.");
  if (method === "PUT" && body.byteLength === 0) throw new TypeError("Account backup PUT requests require a body.");
  const maxRequestBytes = route === "claim" || route === "display" ? MAX_CLAIM_JSON_BYTES : MAX_ACCOUNT_BACKUP_BYTES;
  if (body.byteLength > maxRequestBytes) throw new RangeError("The account backup request exceeds its byte limit.");

  if (Capacitor.isNativePlatform()) {
    if (Capacitor.getPlatform() !== "android") throw new Error("Native account backup is unavailable on this platform.");
    return nativeAccountBackupFetch(url, method, headers, body, approvedApiOrigin, callerSignal, maxRequestBytes);
  }
  return browserAccountBackupFetch(url, method, headers, body, approvedApiOrigin, callerSignal);
}

function assertAccountBackupContentType(headers: Headers, route: RouteKind, method: string): void {
  if (method !== "PUT") return;
  const contentType = headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  const allowed = route === "claim" || route === "display" ? contentType === "application/json" :
    ["image/jpeg", "image/png", "image/webp"].includes(contentType ?? "");
  if (!allowed) throw new TypeError("The account backup content type is not approved for this route.");
}

async function readRequestBody(
  input: RequestInfo | URL,
  init: RequestInit,
  method: string,
  signal: AbortSignal | null,
): Promise<Uint8Array> {
  if (signal?.aborted) throw signal.reason ?? abortError();
  if (method === "GET") {
    const sourceRequest = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    if (init.body != null || sourceRequest?.body !== null && sourceRequest?.body !== undefined) {
      throw new TypeError("Account backup GET requests cannot contain a body.");
    }
    return new Uint8Array(0);
  }

  const request = new Request(input, { ...init, method });
  const requestBody = request.body;
  if (requestBody === null) return new Uint8Array(0);
  if (requestBody === undefined) {
    // Firefox may omit the Request.body stream getter while still supporting arrayBuffer().
    if (signal?.aborted) throw signal.reason ?? abortError();
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (signal?.aborted) throw signal.reason ?? abortError();
    if (bytes.byteLength > MAX_ACCOUNT_BACKUP_BYTES) {
      throw new RangeError("The account backup request exceeds its byte limit.");
    }
    return bytes;
  }
  const reader = requestBody.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? abortError();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ACCOUNT_BACKUP_BYTES) {
        const error = new RangeError("The account backup request exceeds its byte limit.");
        void reader.cancel(error).catch(() => {});
        throw error;
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* A failed body stream may keep its reader locked. */ }
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function browserAccountBackupFetch(
  url: URL,
  method: string,
  headers: Headers,
  body: Uint8Array,
  approvedApiOrigin: string,
  callerSignal: AbortSignal | null,
): Promise<Response> {
  if (typeof location !== "undefined" && location.origin !== new URL(approvedApiOrigin).origin) {
    throw new Error("Browser account backup must use the same origin as the account API.");
  }
  headers.delete("Authorization");
  headers.delete("Cookie");
  if (!headers.has("X-Kip-Account-ID") || !isUuid(headers.get("X-Kip-Account-ID") ?? "")) {
    throw new Error("Account backup requires the signed-in account scope.");
  }
  if (callerSignal?.aborted) throw callerSignal.reason ?? abortError();
  const initial = await getContentConnectivity();
  if (!(await isAccountBackupAvailable(initial))) throw accountBackupUnavailableError();

  const controller = new AbortController();
  const abortForCaller = () => {
    if (!controller.signal.aborted) controller.abort(callerSignal?.reason ?? abortError());
  };
  const abortForUnavailable = () => {
    if (!controller.signal.aborted) controller.abort(accountBackupUnavailableError());
  };
  const abortForBackground = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden" && !controller.signal.aborted) {
      const error = new Error("Account backup stopped when Parkdex left the foreground.");
      error.name = "AbortError";
      controller.abort(error);
    }
  };
  const onConnectivity = (connectivity: { connected: boolean; wifi: boolean }) => {
    if (!mapAccountBackupConnectivity(connectivity).allowed) abortForUnavailable();
  };

  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  callerSignal?.addEventListener("abort", abortForCaller, { once: true });
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", abortForBackground);
  try {
    abortForBackground();
    if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
    unsubscribe = subscribeContentConnectivity(onConnectivity);
    const confirmed = await getContentConnectivity();
    onConnectivity(confirmed);
    if (controller.signal.aborted) throw controller.signal.reason ?? accountBackupUnavailableError();
    if (!(await isAccountBackupAvailable(confirmed))) throw accountBackupUnavailableError();
    timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        const error = new Error("The account backup request timed out.");
        error.name = "TimeoutError";
        controller.abort(error);
      }
    }, DEFAULT_TIMEOUT_MS);

    const uploadBody = method === "PUT" ? toArrayBuffer(body) : undefined;
    const response = await globalThis.fetch(url, {
      method,
      headers,
      body: uploadBody,
      signal: controller.signal,
      redirect: "error",
      credentials: "include",
      cache: "no-store",
    });
    if (response.status < 200 || response.status > 599 || (response.status >= 300 && response.status < 400 && response.status !== 304)) {
      throw new Error("Account backup redirects are not permitted.");
    }
    const bytes = await readBoundedResponseBody(response, (error) => controller.abort(error));
    if (controller.signal.aborted) throw controller.signal.reason ?? accountBackupUnavailableError();
    const responseBody = [204, 205, 304].includes(response.status) ? null : bytes;
    const buffered = new Response(responseBody, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(buffered, "url", { value: response.url || url.href });
    return buffered;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason ?? accountBackupUnavailableError();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    unsubscribe?.();
    callerSignal?.removeEventListener("abort", abortForCaller);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", abortForBackground);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

async function nativeAccountBackupFetch(
  url: URL,
  method: string,
  headers: Headers,
  body: Uint8Array,
  approvedApiOrigin: string,
  callerSignal: AbortSignal | null,
  maxRequestBytes: number,
): Promise<Response> {
  headers.delete("Cookie");
  if (!/^Bearer [^\s]{1,4096}$/.test(headers.get("Authorization") ?? "")) {
    throw new Error("Native account backup requires a secure account session.");
  }
  if (!isUuid(headers.get("X-Kip-Account-ID") ?? "")) {
    throw new Error("Account backup requires the signed-in account scope.");
  }
  if (headers.get("X-Kip-Auth-Transport") !== "native") {
    throw new Error("Native account backup requires the native account transport.");
  }
  if (callerSignal?.aborted) throw callerSignal.reason ?? abortError();

  const requestId = createRequestId();
  const pending = nativeAccountBackupRequest({
    requestId,
    url: url.href,
    method,
    headers: Object.fromEntries(headers.entries()),
    bodyBase64: encodeBase64(body),
    approvedApiOrigin: new URL(approvedApiOrigin).origin,
    maxRequestBytes,
    maxResponseBytes: MAX_ACCOUNT_BACKUP_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!callerSignal) return;
    abortHandler = () => {
      void abortNativeAccountBackupRequest(requestId).catch(() => {});
      reject(callerSignal.reason ?? abortError());
    };
    callerSignal.addEventListener("abort", abortHandler, { once: true });
    if (callerSignal.aborted) abortHandler();
  });
  try {
    const nativeResponse = await Promise.race([pending, aborted]);
    if (callerSignal?.aborted) throw callerSignal.reason ?? abortError();
    if (nativeResponse.status < 200 || nativeResponse.status > 599 ||
        (nativeResponse.status >= 300 && nativeResponse.status < 400 && nativeResponse.status !== 304)) {
      throw new Error("Account backup redirects are not permitted.");
    }
    const bytes = decodeBase64(nativeResponse.bodyBase64);
    const responseBody = [204, 205, 304].includes(nativeResponse.status) ? null : bytes;
    const response = new Response(responseBody, {
      status: nativeResponse.status,
      statusText: nativeResponse.statusText,
      headers: nativeResponse.headers,
    });
    Object.defineProperty(response, "url", { value: nativeResponse.url || url.href });
    return response;
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? abortError();
    throw error;
  } finally {
    if (abortHandler) callerSignal?.removeEventListener("abort", abortHandler);
  }
}

async function readBoundedResponseBody(response: Response, abort: (reason: unknown) => void): Promise<ArrayBuffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ACCOUNT_BACKUP_BYTES) {
    const error = new RangeError("The account backup response exceeds its byte limit.");
    abort(error);
    if (response.body) void response.body.cancel(error).catch(() => {});
    throw error;
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_ACCOUNT_BACKUP_BYTES) {
        const error = new RangeError("The account backup response exceeds its byte limit.");
        abort(error);
        void reader.cancel(error).catch(() => {});
        throw error;
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* A failed response stream may keep its reader locked. */ }
  }

  const result = new ArrayBuffer(byteLength);
  const output = new Uint8Array(result);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 32 * 1024;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const chunk = bytes.subarray(start, Math.min(start + chunkSize, bytes.length));
    parts.push(String.fromCharCode(...chunk));
  }
  return globalThis.btoa(parts.join(""));
}

function decodeBase64(encoded: string): ArrayBuffer {
  const maxChars = Math.ceil((MAX_ACCOUNT_BACKUP_BYTES * 4) / 3) + 4;
  if (typeof encoded !== "string" || encoded.length > maxChars) {
    throw new RangeError("The account backup response exceeds its byte limit.");
  }
  const binary = globalThis.atob(encoded);
  if (binary.length > MAX_ACCOUNT_BACKUP_BYTES) throw new RangeError("The account backup response exceeds its byte limit.");
  const result = new ArrayBuffer(binary.length);
  const output = new Uint8Array(result);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return result;
}

function isUuid(value: string): boolean {
  return new RegExp(`^${CLAIM_ID}$`, "i").test(value);
}

function createRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  nextRequestId += 1;
  return `account-backup-${Date.now()}-${nextRequestId}`;
}

function accountBackupUnavailableError(): Error {
  const error = new Error("Connect to the internet to back up your saved progress.");
  error.name = "AccountBackupUnavailableError";
  return error;
}

function abortError(): DOMException {
  return new DOMException("The account backup request was aborted.", "AbortError");
}
