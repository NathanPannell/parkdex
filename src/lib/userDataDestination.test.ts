import { describe, expect, it } from "vitest";
import { assertUserDataApiBuildConfiguration, isApprovedKipOrigin, resolveUserDataApiOrigin } from "./userDataDestination";

const STAGING = "https://staging.web.parkdex.app";
const STAGING_ALIAS = "https://parkdex-kip-staging.vercel.app";
const PRODUCTION = "https://web.parkdex.app";

describe("user-data API destination policy", () => {
  it("accepts only clean HTTPS origins for native transport", () => {
    for (const invalid of [
      "http://staging.web.parkdex.app",
      "https://user:password@staging.web.parkdex.app",
      "https://@staging.web.parkdex.app",
      "https://staging.web.parkdex.app:444",
      "https://staging.web.parkdex.app/api",
      "https://staging.web.parkdex.app/?token=x",
      "https://staging.web.parkdex.app/#token",
    ]) {
      expect(() => resolveUserDataApiOrigin(invalid, { native: true, environment: "staging" }), invalid).toThrow();
    }
    expect(resolveUserDataApiOrigin(STAGING, { native: true, environment: "staging" })).toBe(STAGING);
    expect(resolveUserDataApiOrigin(STAGING_ALIAS, { native: true, environment: "staging" })).toBe(STAGING_ALIAS);
    expect(isApprovedKipOrigin(STAGING_ALIAS)).toBe(true);
    expect(isApprovedKipOrigin("https://random-branch.vercel.app")).toBe(false);
  });

  it("rejects destinations from another stable environment", () => {
    expect(() => resolveUserDataApiOrigin(PRODUCTION, { native: true, environment: "staging" })).toThrow();
    expect(() => resolveUserDataApiOrigin(STAGING, { native: true, environment: "main" })).toThrow();
    expect(resolveUserDataApiOrigin(PRODUCTION, { native: true, environment: "main" })).toBe(PRODUCTION);
  });

  it("binds a native preview to one exact configured origin", () => {
    const previewA = "https://parkdex-kip-abc123-nathanpannells-projects.vercel.app";
    const previewB = "https://parkdex-kip-def456-nathanpannells-projects.vercel.app";
    expect(resolveUserDataApiOrigin(previewA, { native: true, environment: "preview", previewOrigin: previewA })).toBe(previewA);
    expect(() => resolveUserDataApiOrigin(previewB, { native: true, environment: "preview", previewOrigin: previewA })).toThrow();
    expect(() => resolveUserDataApiOrigin("https://arbitrary.vercel.app", { native: true, environment: "preview", previewOrigin: previewA })).toThrow();
    expect(() => resolveUserDataApiOrigin(previewA, { native: true, environment: "preview" })).toThrow();
  });

  it("keeps browser requests on the current origin, including isolated previews", () => {
    const browserOrigin = "https://feature-pr35.example.test";
    expect(resolveUserDataApiOrigin(undefined, { native: false, webOrigin: browserOrigin })).toBe(browserOrigin);
    expect(resolveUserDataApiOrigin(browserOrigin, { native: false, webOrigin: browserOrigin })).toBe(browserOrigin);
    expect(() => resolveUserDataApiOrigin(STAGING, { native: false, webOrigin: browserOrigin })).toThrow();
    expect(() => resolveUserDataApiOrigin("http://feature-pr35.example.test", { native: false, webOrigin: browserOrigin })).toThrow();
  });

  it("permits HTTP only for loopback development", () => {
    const local = "http://127.0.0.1:5190";
    expect(resolveUserDataApiOrigin(local, { native: false, webOrigin: local, allowLoopbackHttp: true })).toBe(local);
    expect(() => resolveUserDataApiOrigin(local, { native: false, webOrigin: local })).toThrow();
    expect(() =>
      resolveUserDataApiOrigin("http://192.168.1.12:5190", {
        native: false,
        webOrigin: "http://192.168.1.12:5190",
        allowLoopbackHttp: true,
      }),
    ).toThrow();
  });
});

describe("user-data build destination guard", () => {
  it("requires an exact deployment identity for preview builds", () => {
    const host = "parkdex-kip-abc123-nathanpannells-projects.vercel.app";
    const origin = `https://${host}`;
    expect(() =>
      assertUserDataApiBuildConfiguration(
        {
          VITE_CONTENT_ENV: "preview",
          VITE_PREVIEW_API_ORIGIN: origin,
          VITE_APP_URL: origin,
          VITE_ACCOUNT_API_URL: origin,
          VITE_FEEDBACK_API_URL: origin,
        },
        { mode: "production", vercelUrl: host },
      ),
    ).not.toThrow();
    expect(() =>
      assertUserDataApiBuildConfiguration(
        {
          VITE_CONTENT_ENV: "preview",
          VITE_PREVIEW_API_ORIGIN: origin,
        },
        { mode: "production", vercelUrl: "parkdex-kip-other.vercel.app" },
      ),
    ).toThrow();
    expect(() =>
      assertUserDataApiBuildConfiguration(
        {
          VITE_CONTENT_ENV: "preview",
          VITE_PREVIEW_API_ORIGIN: "https://*.vercel.app",
        },
        { mode: "production", vercelUrl: host },
      ),
    ).toThrow();
  });

  it("rejects cross-environment and unsafe build URLs", () => {
    expect(() =>
      assertUserDataApiBuildConfiguration(
        {
          VITE_CONTENT_ENV: "staging",
          VITE_ACCOUNT_API_URL: PRODUCTION,
        },
        { mode: "production" },
      ),
    ).toThrow();
    for (const invalid of [
      "http://parkdex-kip-staging.vercel.app",
      "https://user@parkdex-kip-staging.vercel.app",
      "https://parkdex-kip-staging.vercel.app:444",
      "https://parkdex-kip-staging.vercel.app/api",
      "https://parkdex-kip-staging.vercel.app/?token=x",
    ]) {
      expect(
        () =>
          assertUserDataApiBuildConfiguration(
            {
              VITE_CONTENT_ENV: "staging",
              VITE_FEEDBACK_API_URL: invalid,
            },
            { mode: "production" },
          ),
        invalid,
      ).toThrow();
    }
  });
});
