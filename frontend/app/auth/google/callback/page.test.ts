import { describe, expect, it } from "vitest";

import { callbackRedirect } from "./page";

describe("Google callback redirect", () => {
  it("forwards one value for each supported callback field", () => {
    expect(callbackRedirect("?code=code-value&state=state-value&ignored=secret")).toBe(
      "/?code=code-value&state=state-value",
    );
    expect(callbackRedirect("?error=access_denied&error_description=cancelled")).toBe(
      "/?error=access_denied&error_description=cancelled",
    );
  });

  it("drops ambiguous duplicate callback fields", () => {
    expect(callbackRedirect("?code=first&code=second&state=expected")).toBe("/?state=expected");
  });
});
