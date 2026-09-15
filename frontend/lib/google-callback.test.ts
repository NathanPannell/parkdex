import { describe, expect, it } from "vitest";

import { buildGoogleCallbackDestination } from "./google-callback";

describe("Google OAuth callback", () => {
  it("forwards the supported callback parameters to the app shell", () => {
    expect(buildGoogleCallbackDestination("?code=oauth-code&state=signed-state"))
      .toBe("/?code=oauth-code&state=signed-state");
    expect(buildGoogleCallbackDestination("?error=access_denied&error_description=Not+now"))
      .toBe("/?error=access_denied&error_description=Not+now");
  });

  it("drops unrelated parameters and repeated values", () => {
    expect(buildGoogleCallbackDestination("?code=first&code=second&next=https%3A%2F%2Fevil.example"))
      .toBe("/?code=first");
  });

  it("never forwards an authorization code together with an OAuth error", () => {
    expect(buildGoogleCallbackDestination("?code=secret-code&state=signed-state&error=access_denied"))
      .toBe("/?error=access_denied&state=signed-state");
    expect(buildGoogleCallbackDestination("?error_description=orphaned&state=signed-state"))
      .toBe("/?state=signed-state");
  });

  it("returns the app root when no supported parameter is present", () => {
    expect(buildGoogleCallbackDestination("?next=%2Faccount")).toBe("/");
  });
});
