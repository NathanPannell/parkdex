import { describe, expect, it } from "vitest";

import { callbackRedirect } from "./page";

describe("Google callback redirect", () => {
  it("keeps only the supported one-use callback values", () => {
    expect(callbackRedirect("?code=one&state=two&ignored=three")).toBe("/?code=one&state=two");
    expect(callbackRedirect("?error=access_denied&error_description=No+thanks&state=two")).toBe(
      "/?state=two&error=access_denied&error_description=No+thanks",
    );
  });

  it("rejects ambiguous duplicate values", () => {
    expect(callbackRedirect("?code=one&code=two&state=three")).toBe("/?state=three");
  });

  it("returns home when no supported values are present", () => {
    expect(callbackRedirect("?ignored=value")).toBe("/");
  });
});
