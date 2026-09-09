// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(),
  getLaunchUrl: vi.fn(),
  browserOpen: vi.fn(),
  browserClose: vi.fn(),
  isNativePlatform: vi.fn(),
  preferenceValues: new Map<string, string>(),
}));

vi.mock("@capacitor/app", () => ({ App: { addListener: mocks.addListener, getLaunchUrl: mocks.getLaunchUrl } }));
vi.mock("@capacitor/browser", () => ({ Browser: { open: mocks.browserOpen, close: mocks.browserClose } }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: mocks.isNativePlatform } }));
vi.mock("@capacitor/preferences", () => ({ Preferences: {
  get: vi.fn(async ({ key }: { key: string }) => ({ value: mocks.preferenceValues.get(key) ?? null })),
  set: vi.fn(async ({ key, value }: { key: string; value: string }) => { mocks.preferenceValues.set(key, value); }),
  remove: vi.fn(async ({ key }: { key: string }) => { mocks.preferenceValues.delete(key); }),
} }));

import { NATIVE_OAUTH_CALLBACK_EVENT, NATIVE_OAUTH_CALLBACK_READY_EVENT, openNativeGoogleAuthorization, parseNativeOAuthCallback, startNativeOAuthBridge } from "@/lib/native-oauth";

const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&redirect_uri=https%3A%2F%2Fstaging.parkdex.app%2Fauth%2Fgoogle%2Fcallback&response_type=code&code_challenge_method=S256&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&state=expected-state";
const callbackUrl = "https://staging.parkdex.app/auth/google/callback?code=authorization-code&state=expected-state";

describe("native OAuth bridge", () => {
  beforeEach(() => {
    mocks.preferenceValues.clear();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.clearAllMocks();
    mocks.isNativePlatform.mockReturnValue(true);
    mocks.browserOpen.mockResolvedValue(undefined);
    mocks.browserClose.mockResolvedValue(undefined);
    mocks.getLaunchUrl.mockResolvedValue(undefined);
    mocks.addListener.mockResolvedValue({ remove: vi.fn() });
  });

  it("accepts only the configured HTTPS callback with one code and state", () => {
    expect(parseNativeOAuthCallback(callbackUrl)).toEqual({ code: "authorization-code", state: "expected-state" });
    expect(parseNativeOAuthCallback("http://staging.parkdex.app/auth/google/callback?code=a&state=b")).toBeNull();
    expect(parseNativeOAuthCallback("https://staging.parkdex.app/auth/google/other?code=a&state=b")).toBeNull();
    expect(parseNativeOAuthCallback("https://staging.parkdex.app/auth/google/callback?code=a&code=b&state=c")).toBeNull();
  });

  it("opens only the Google authorization endpoint and binds its state", async () => {
    await openNativeGoogleAuthorization(authorizationUrl);
    expect(mocks.browserOpen).toHaveBeenCalledWith({ url: authorizationUrl });
    expect(mocks.preferenceValues.get("parkdex:native-oauth-state:v1")).toBe("expected-state");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    await expect(openNativeGoogleAuthorization("https://example.test/auth?state=expected-state")).rejects.toThrow("unrecognized");
    await expect(openNativeGoogleAuthorization("https://accounts.google.com/o/oauth2/v2/auth?state=expected-state")).rejects.toThrow("unrecognized");
  });

  it("dispatches a matching callback once and consumes the pending state", async () => {
    mocks.preferenceValues.set("parkdex:native-oauth-state:v1", "expected-state");
    let callback: unknown;
    window.addEventListener(NATIVE_OAUTH_CALLBACK_EVENT, (event) => { callback = (event as CustomEvent).detail; });
    await startNativeOAuthBridge();
    window.dispatchEvent(new Event(NATIVE_OAUTH_CALLBACK_READY_EVENT));
    const handler = mocks.addListener.mock.calls[0][1];
    handler({ url: callbackUrl });
    await vi.waitFor(() => expect(callback).toEqual({ code: "authorization-code", state: "expected-state" }));
    expect(mocks.browserClose).toHaveBeenCalledTimes(1);
    expect(mocks.preferenceValues.get("parkdex:native-oauth-state:v1")).toBeUndefined();
    handler({ url: callbackUrl });
    await Promise.resolve();
    expect(mocks.browserClose).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a callback that is not bound to the pending state", async () => {
    await openNativeGoogleAuthorization(authorizationUrl);
    let dispatched = false;
    window.addEventListener(NATIVE_OAUTH_CALLBACK_EVENT, () => { dispatched = true; });
    await startNativeOAuthBridge();
    window.dispatchEvent(new Event(NATIVE_OAUTH_CALLBACK_READY_EVENT));
    const handler = mocks.addListener.mock.calls[0][1];
    handler({ url: "https://staging.parkdex.app/auth/google/callback?code=authorization-code&state=other-state" });
    await Promise.resolve();
    expect(dispatched).toBe(false);
    expect(mocks.browserClose).not.toHaveBeenCalled();
    expect(mocks.preferenceValues.get("parkdex:native-oauth-state:v1")).toBe("expected-state");
  });

  it("queues a matching cold-start URL until the shared auth listener is ready", async () => {
    await openNativeGoogleAuthorization(authorizationUrl);
    mocks.getLaunchUrl.mockResolvedValue({ url: callbackUrl });
    let callback: unknown;
    window.addEventListener(NATIVE_OAUTH_CALLBACK_EVENT, (event) => { callback = (event as CustomEvent).detail; });
    await startNativeOAuthBridge();
    expect(callback).toBeUndefined();
    expect(mocks.browserClose).not.toHaveBeenCalled();
    window.dispatchEvent(new Event(NATIVE_OAUTH_CALLBACK_READY_EVENT));
    await vi.waitFor(() => expect(callback).toEqual({ code: "authorization-code", state: "expected-state" }));
    expect(callback).toEqual({ code: "authorization-code", state: "expected-state" });
    expect(mocks.browserClose).toHaveBeenCalledTimes(1);
  });
});
