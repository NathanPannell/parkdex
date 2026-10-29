import { beforeEach, describe, expect, it, vi } from "vitest";

type NativeAccountRequestOptions = {
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

const mocks = vi.hoisted(() => ({
  native: false,
  connectivity: { connected: true, wifi: true },
  connectivityHandler: null as ((connectivity: { connected: boolean; wifi: boolean }) => void) | null,
  getConnectivity: vi.fn(async () => mocks.connectivity),
  unsubscribe: vi.fn(),
  subscribe: vi.fn((listener: (connectivity: { connected: boolean; wifi: boolean }) => void) => {
    mocks.connectivityHandler = listener;
    return mocks.unsubscribe;
  }),
  accountRequest: vi.fn(async (_options: NativeAccountRequestOptions) => ({
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    bodyBase64: "eyJvayI6dHJ1ZX0=",
    url: "https://parkdex-kip-staging.vercel.app/api/claims",
  })),
  abort: vi.fn(async (_options: { requestId: string }) => {}),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native, getPlatform: () => "android" },
}));
vi.mock("../content/transport", () => ({
  hasNativeContentTransport: () => true,
  getContentConnectivity: mocks.getConnectivity,
  subscribeContentConnectivity: mocks.subscribe,
  nativeAccountBackupRequest: mocks.accountRequest,
  abortNativeAccountBackupRequest: (requestId: string) => mocks.abort({ requestId }),
}));

import { accountBackupFetch, assertAccountBackupRequest } from "./accountBackupTransport";

const API_ORIGIN = "https://parkdex-kip-staging.vercel.app";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "33333333-3333-4333-8333-333333333333";

function scopedHeaders(extra: Record<string, string> = {}) {
  return new Headers({
    "X-Kip-Account-ID": ACCOUNT_ID,
    "Content-Type": "application/json",
    ...extra,
  });
}

function stubMissingRequestBodyGetter(arrayBuffer?: () => Promise<ArrayBuffer>) {
  const NativeRequest = globalThis.Request;
  class FirefoxRequest extends NativeRequest {
    override arrayBuffer(): Promise<ArrayBuffer> {
      return arrayBuffer ? arrayBuffer() : super.arrayBuffer();
    }
  }
  Object.defineProperty(FirefoxRequest.prototype, "body", { configurable: true, get: () => undefined });
  vi.stubGlobal("Request", FirefoxRequest);
  return () => vi.stubGlobal("Request", NativeRequest);
}

beforeEach(() => {
  mocks.native = false;
  mocks.connectivity = { connected: true, wifi: true };
  mocks.connectivityHandler = null;
  mocks.getConnectivity.mockImplementation(async () => mocks.connectivity);
  mocks.unsubscribe.mockClear();
  mocks.subscribe.mockClear();
  mocks.accountRequest.mockClear();
  mocks.accountRequest.mockImplementation(async () => ({
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    bodyBase64: "eyJvayI6dHJ1ZX0=",
    url: `${API_ORIGIN}/api/claims`,
  }));
  mocks.abort.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("ok", { headers: { "content-type": "text/plain" } })),
  );
  vi.stubGlobal("document", undefined);
});

describe("account backup transport", () => {
  it("allows browser backup on a connected network with unknown or cellular network type", async () => {
    mocks.connectivity = { connected: true, wifi: false };
    const fetchMock = vi.mocked(globalThis.fetch);

    await expect(
      accountBackupFetch(
        `${API_ORIGIN}/api/claims`,
        {
          method: "GET",
          headers: scopedHeaders(),
        },
        API_ORIGIN,
      ),
    ).resolves.toMatchObject({ status: 200 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("allows a bodyless GET when Firefox omits the Request body getter", async () => {
    const restoreRequest = stubMissingRequestBodyGetter();
    try {
      const request = new Request(`${API_ORIGIN}/api/claims`, { method: "GET", headers: scopedHeaders() });
      await expect(accountBackupFetch(request, {}, API_ORIGIN)).resolves.toMatchObject({ status: 200 });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    } finally {
      restoreRequest();
    }
  });

  it("uploads a PUT body through Request.arrayBuffer when Firefox omits its body getter", async () => {
    const restoreRequest = stubMissingRequestBodyGetter();
    const payload = new Uint8Array([7, 13, 21]);
    try {
      const request = new Request(`${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`, {
        method: "PUT",
        headers: scopedHeaders({ "Content-Type": "image/jpeg" }),
        body: new Blob([payload], { type: "image/jpeg" }),
      });
      await expect(accountBackupFetch(request, {}, API_ORIGIN)).resolves.toMatchObject({ status: 200 });
      const requestInit = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
      expect(requestInit?.method).toBe("PUT");
      expect(Array.from(new Uint8Array(requestInit?.body as ArrayBuffer))).toEqual(Array.from(payload));
    } finally {
      restoreRequest();
    }
  });

  it("bounds a PUT body read with Request.arrayBuffer when Firefox omits the body getter", async () => {
    const restoreRequest = stubMissingRequestBodyGetter();
    try {
      const request = new Request(`${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`, {
        method: "PUT",
        headers: scopedHeaders({ "Content-Type": "image/jpeg" }),
        body: new Blob([new Uint8Array(2_621_441)], { type: "image/jpeg" }),
      });
      await expect(accountBackupFetch(request, {}, API_ORIGIN)).rejects.toThrow("exceeds its byte limit");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      restoreRequest();
    }
  });

  it("honors cancellation after a Firefox Request.arrayBuffer body read finishes", async () => {
    let resolveBody: ((bytes: ArrayBuffer) => void) | undefined;
    const bodyRead = new Promise<ArrayBuffer>((resolve) => {
      resolveBody = resolve;
    });
    const restoreRequest = stubMissingRequestBodyGetter(() => bodyRead);
    const controller = new AbortController();
    try {
      const request = new Request(`${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`, {
        method: "PUT",
        headers: scopedHeaders({ "Content-Type": "image/jpeg" }),
        body: new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
      });
      const pending = accountBackupFetch(request, { signal: controller.signal }, API_ORIGIN);
      await vi.waitFor(() => expect(resolveBody).toBeDefined());
      controller.abort(new DOMException("Account changed", "AbortError"));
      resolveBody?.(new Uint8Array([1]).buffer);

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      restoreRequest();
    }
  });

  it("rejects browser backup while offline before sending a request", async () => {
    mocks.connectivity = { connected: false, wifi: false };
    const fetchMock = vi.mocked(globalThis.fetch);

    await expect(
      accountBackupFetch(
        `${API_ORIGIN}/api/claims`,
        {
          method: "GET",
          headers: scopedHeaders(),
        },
        API_ORIGIN,
      ),
    ).rejects.toMatchObject({ name: "AccountBackupUnavailableError" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("uses same-origin cookie credentials for browser backup and aborts when offline", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = accountBackupFetch(
      `${API_ORIGIN}/api/claims`,
      {
        method: "GET",
        headers: scopedHeaders(),
      },
      API_ORIGIN,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestInit).toMatchObject({ credentials: "include", redirect: "error", method: "GET" });
    mocks.connectivityHandler?.({ connected: false, wifi: false });

    await expect(pending).rejects.toMatchObject({ name: "AccountBackupUnavailableError" });
    expect(requestSignal?.aborted).toBe(true);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-flight browser backup when Wi-Fi changes to cellular while online", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          resolveFetch = resolve;
          requestSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = accountBackupFetch(
      `${API_ORIGIN}/api/claims`,
      {
        method: "GET",
        headers: scopedHeaders(),
      },
      API_ORIGIN,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    mocks.connectivityHandler?.({ connected: true, wifi: false });

    expect(requestSignal?.aborted).toBe(false);
    resolveFetch?.(new Response("ok"));
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it("forwards caller cancellation to an in-flight browser request", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = accountBackupFetch(
      `${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`,
      {
        method: "GET",
        headers: scopedHeaders(),
        signal: controller.signal,
      },
      API_ORIGIN,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    controller.abort(new DOMException("Account changed", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts browser backup when the request times out", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const pending = accountBackupFetch(
        `${API_ORIGIN}/api/claims`,
        {
          method: "GET",
          headers: scopedHeaders(),
        },
        API_ORIGIN,
      );
      const timedOut = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      for (let attempt = 0; attempt < 12 && fetchMock.mock.calls.length === 0; attempt += 1) await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(20_001);

      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts browser backup when the page leaves the foreground", async () => {
    let onVisibilityChange: ((event: Event) => void) | undefined;
    const browserDocument = {
      visibilityState: "visible",
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "visibilitychange" && typeof listener === "function") onVisibilityChange = listener;
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("document", browserDocument);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = accountBackupFetch(`${API_ORIGIN}/api/claims`, { method: "GET", headers: scopedHeaders() }, API_ORIGIN);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    browserDocument.visibilityState = "hidden";
    onVisibilityChange?.(new Event("visibilitychange"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(browserDocument.removeEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("blocks oversized photo uploads and oversized responses", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    await expect(
      accountBackupFetch(
        `${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`,
        {
          method: "PUT",
          headers: scopedHeaders({ "Content-Type": "image/jpeg" }),
          body: new Blob([new Uint8Array(2_621_441)], { type: "image/jpeg" }),
        },
        API_ORIGIN,
      ),
    ).rejects.toThrow("exceeds its byte limit");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(2_621_441))),
    );
    await expect(
      accountBackupFetch(
        `${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`,
        {
          method: "GET",
          headers: scopedHeaders(),
        },
        API_ORIGIN,
      ),
    ).rejects.toThrow("response exceeds its byte limit");
  });

  it("routes native writes through accountRequest with scoped bearer auth and bounded bytes", async () => {
    mocks.native = true;
    const body = new Blob(["private-photo"], { type: "image/jpeg" });
    await accountBackupFetch(
      `${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`,
      {
        method: "PUT",
        headers: scopedHeaders({
          Authorization: "Bearer native-session-token",
          "X-Kip-Auth-Transport": "native",
          Cookie: "must-not-cross-native-bridge",
          "Content-Type": "image/jpeg",
        }),
        body,
      },
      API_ORIGIN,
    );

    expect(mocks.accountRequest).toHaveBeenCalledTimes(1);
    const request = mocks.accountRequest.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      url: `${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`,
      method: "PUT",
      approvedApiOrigin: API_ORIGIN,
      maxRequestBytes: 2_621_440,
      maxResponseBytes: 2_621_440,
    });
    expect(request?.bodyBase64).toBe(btoa("private-photo"));
    const requestHeaders = new Headers(request?.headers);
    expect(requestHeaders.get("authorization")).toBe("Bearer native-session-token");
    expect(requestHeaders.get("x-kip-account-id")).toBe(ACCOUNT_ID);
    expect(requestHeaders.get("x-kip-auth-transport")).toBe("native");
    expect(requestHeaders.has("cookie")).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("routes native account backup over cellular without requiring Wi-Fi", async () => {
    mocks.native = true;
    mocks.connectivity = { connected: true, wifi: false };
    mocks.getConnectivity.mockClear();

    await accountBackupFetch(
      `${API_ORIGIN}/api/claims`,
      {
        method: "GET",
        headers: scopedHeaders({
          Authorization: "Bearer native-session-token",
          "X-Kip-Auth-Transport": "native",
        }),
      },
      API_ORIGIN,
    );

    expect(mocks.accountRequest).toHaveBeenCalledTimes(1);
    expect(mocks.getConnectivity).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("aborts the native account backup request when the caller cancels it", async () => {
    mocks.native = true;
    let requestId = "";
    mocks.accountRequest.mockImplementation((options: NativeAccountRequestOptions) => {
      requestId = options.requestId;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const pending = accountBackupFetch(
      `${API_ORIGIN}/api/claims/${CLAIM_ID}/photo`,
      {
        method: "GET",
        headers: scopedHeaders({
          Authorization: "Bearer native-session-token",
          "X-Kip-Auth-Transport": "native",
        }),
        signal: controller.signal,
      },
      API_ORIGIN,
    );
    await vi.waitFor(() => expect(mocks.accountRequest).toHaveBeenCalledTimes(1));

    controller.abort(new DOMException("Account changed", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.abort).toHaveBeenCalledWith({ requestId });
  });

  it("rejects unsupported account paths and collection writes before transport", () => {
    expect(() => assertAccountBackupRequest(new URL(`${API_ORIGIN}/api/claims`), "PUT", API_ORIGIN)).toThrow();
    expect(() => assertAccountBackupRequest(new URL(`${API_ORIGIN}/api/claims/${CLAIM_ID}/extra`), "GET", API_ORIGIN)).toThrow();
    expect(() => assertAccountBackupRequest(new URL(`https://attacker.example/api/claims`), "GET", API_ORIGIN)).toThrow();
  });

  it("permits the photo display routes (#174) only with their exact methods and a small JSON body", async () => {
    expect(assertAccountBackupRequest(new URL(`${API_ORIGIN}/api/claims/display`), "GET", API_ORIGIN)).toBe("displays");
    expect(assertAccountBackupRequest(new URL(`${API_ORIGIN}/api/claims/${CLAIM_ID}/display`), "PUT", API_ORIGIN)).toBe("display");
    expect(() => assertAccountBackupRequest(new URL(`${API_ORIGIN}/api/claims/display`), "PUT", API_ORIGIN)).toThrow();
    expect(() => assertAccountBackupRequest(new URL(`${API_ORIGIN}/api/claims/display?all=1`), "GET", API_ORIGIN)).toThrow();
    expect(() => assertAccountBackupRequest(new URL(`${API_ORIGIN}/api/claims/${CLAIM_ID}/display`), "GET", API_ORIGIN)).toThrow();
    const body = JSON.stringify({ crop: null, coverAt: null, removed: true });
    await expect(
      accountBackupFetch(`${API_ORIGIN}/api/claims/${CLAIM_ID}/display`, { method: "PUT", headers: scopedHeaders(), body }, API_ORIGIN),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      accountBackupFetch(
        `${API_ORIGIN}/api/claims/${CLAIM_ID}/display`,
        { method: "PUT", headers: scopedHeaders({ "Content-Type": "image/jpeg" }), body },
        API_ORIGIN,
      ),
    ).rejects.toThrow("content type");
    await expect(
      accountBackupFetch(
        `${API_ORIGIN}/api/claims/${CLAIM_ID}/display`,
        { method: "PUT", headers: scopedHeaders(), body: "x".repeat(16 * 1024 + 1) },
        API_ORIGIN,
      ),
    ).rejects.toThrow("byte limit");
  });
});
