import { describe, expect, it } from "vitest";
import { parseNativeAuthLink } from "./nativeIdentity";

const STAGING_ORIGIN = "https://parkdex-kip-staging.vercel.app";

describe("parseNativeAuthLink", () => {
  it("parses verification and password-reset tokens from the account fragment", () => {
    expect(parseNativeAuthLink(
      `${STAGING_ORIGIN}/account#verificationToken=verify_123`,
      STAGING_ORIGIN,
    )).toEqual({ kind: "verification", token: "verify_123" });

    expect(parseNativeAuthLink(
      `${STAGING_ORIGIN}/account#resetToken=reset_456`,
      STAGING_ORIGIN,
    )).toEqual({ kind: "password_reset", token: "reset_456" });
  });

  it("rejects a different environment, non-HTTPS links, and paths outside the account screen", () => {
    expect(parseNativeAuthLink("https://staging.web.parkdex.app/account#resetToken=x", STAGING_ORIGIN)).toBeNull();
    expect(parseNativeAuthLink("http://parkdex-kip-staging.vercel.app/account#resetToken=x", STAGING_ORIGIN)).toBeNull();
    expect(parseNativeAuthLink(`${STAGING_ORIGIN}/accounting#resetToken=x`, STAGING_ORIGIN)).toBeNull();
  });

  it("accepts action tokens only in a single fragment field", () => {
    expect(parseNativeAuthLink(`${STAGING_ORIGIN}/account?resetToken=x`, STAGING_ORIGIN)).toBeNull();
    expect(parseNativeAuthLink(`${STAGING_ORIGIN}/account#resetToken=x&verificationToken=y`, STAGING_ORIGIN)).toBeNull();
    expect(parseNativeAuthLink(`${STAGING_ORIGIN}/account#resetToken=`, STAGING_ORIGIN)).toBeNull();
    expect(parseNativeAuthLink(`${STAGING_ORIGIN}/account#resetToken=${"x".repeat(2049)}`, STAGING_ORIGIN)).toBeNull();
  });
});
