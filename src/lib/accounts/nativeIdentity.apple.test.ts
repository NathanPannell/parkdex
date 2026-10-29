import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platform: "ios",
  getAppleCredential: vi.fn(async (_options: { nonce: string }) => ({}) as Record<string, unknown>),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mocks.platform,
    isNativePlatform: () => mocks.platform !== "web",
    isPluginAvailable: () => mocks.platform === "android",
  },
  registerPlugin: () => ({ getAppleCredential: mocks.getAppleCredential }),
}));
vi.mock("@capacitor/app", () => ({ App: {} }));

import { isAndroidNativeIdentityAvailable, isAppleSignInAvailable, isNativeIdentityAvailable, requestNativeAppleCredential } from "./nativeIdentity";

beforeEach(() => {
  mocks.platform = "ios";
  mocks.getAppleCredential.mockReset();
});

describe("native identity on iOS", () => {
  it("uses the iOS plugin for sign-in and offers Sign in with Apple only on iOS", () => {
    expect(isNativeIdentityAvailable()).toBe(true);
    expect(isAppleSignInAvailable()).toBe(true);
    expect(isAndroidNativeIdentityAvailable()).toBe(false);
    mocks.platform = "android";
    expect(isNativeIdentityAvailable()).toBe(true);
    expect(isAppleSignInAvailable()).toBe(false);
    mocks.platform = "web";
    expect(isNativeIdentityAvailable()).toBe(false);
    expect(isAppleSignInAvailable()).toBe(false);
  });

  it("passes the server nonce to Apple unchanged and returns only the fields the server accepts", async () => {
    mocks.getAppleCredential.mockResolvedValue({
      identityToken: "header.payload.sig",
      authorizationCode: "code",
      givenName: " Robin ",
      familyName: "",
      user: "001.abc",
    });
    await expect(requestNativeAppleCredential({ nonce: "server-nonce" })).resolves.toEqual({
      identityToken: "header.payload.sig",
      authorizationCode: "code",
      givenName: "Robin",
    });
    expect(mocks.getAppleCredential).toHaveBeenCalledWith({ nonce: "server-nonce" });
  });

  it("refuses a missing token, a bad nonce, or another platform", async () => {
    mocks.getAppleCredential.mockResolvedValue({ authorizationCode: "code" });
    await expect(requestNativeAppleCredential({ nonce: "server-nonce" })).rejects.toThrow("identity token");
    await expect(requestNativeAppleCredential({ nonce: " padded " })).rejects.toThrow("nonce");
    mocks.platform = "android";
    await expect(requestNativeAppleCredential({ nonce: "server-nonce" })).rejects.toThrow("iOS app");
  });
});
