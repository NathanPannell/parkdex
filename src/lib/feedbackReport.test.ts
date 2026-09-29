import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const feedbackMocks = vi.hoisted(() => ({
  native: true,
  getAttempt: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => feedbackMocks.native,
    getPlatform: () => feedbackMocks.native ? "android" : "web",
  },
}));

vi.mock("./feedbackDraft", () => ({
  createFeedbackDraftGeneration: () => "generation-fixture",
  getFeedbackSubmissionAttempt: feedbackMocks.getAttempt,
}));

import { submitFeedback, type FeedbackReport } from "./feedbackReport";

const report: FeedbackReport = {
  kind: "bug",
  message: "Private diagnostic fixture",
  contact: true,
  email: "person@example.test",
  screenshot: "data:image/png;base64,c2NyZWVuc2hvdA==",
  context: {
    version: "0.1.0",
    build: "abcdef1234567",
    platform: "android",
    screen: "Map",
    parkId: "provincial-goldstream-park",
    parkName: "Goldstream Provincial Park",
  },
};

describe("feedback transport destination policy", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CONTENT_ENV", "staging");
    vi.stubEnv("VITE_PREVIEW_API_ORIGIN", "");
    vi.stubEnv("VITE_FEEDBACK_API_URL", "https://staging.web.parkdex.app");
    feedbackMocks.native = true;
    feedbackMocks.getAttempt.mockReset().mockResolvedValue({ id: "submission-fixture", report });
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects an unapproved native host before reading or sending the report payload", async () => {
    vi.stubEnv("VITE_FEEDBACK_API_URL", "https://attacker.example.test");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(submitFeedback(report, "generation-fixture")).rejects.toThrow("invalid service destination");

    expect(feedbackMocks.getAttempt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends native feedback only to the approved origin with redirects and ambient credentials disabled", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ id: "feedback-123" }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetcher);

    await expect(submitFeedback(report, "generation-fixture")).resolves.toEqual({ id: "feedback-123" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(input)).toBe("https://staging.web.parkdex.app/api/feedback");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(new Headers(init.headers).has("cookie")).toBe(false);
  });

  it("binds a preview report to the exact configured preview origin", async () => {
    const preview = "https://parkdex-kip-pr35-nathanpannells-projects.vercel.app";
    vi.stubEnv("VITE_CONTENT_ENV", "preview");
    vi.stubEnv("VITE_PREVIEW_API_ORIGIN", preview);
    vi.stubEnv("VITE_FEEDBACK_API_URL", preview);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: "feedback-preview" }), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);

    await submitFeedback(report, "generation-fixture");

    expect(String(fetcher.mock.calls[0][0])).toBe(`${preview}/api/feedback`);
    vi.stubEnv("VITE_FEEDBACK_API_URL", "https://parkdex-kip-other-nathanpannells-projects.vercel.app");
    feedbackMocks.getAttempt.mockClear();
    fetcher.mockClear();
    await expect(submitFeedback(report, "generation-fixture")).rejects.toThrow("invalid service destination");
    expect(feedbackMocks.getAttempt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps browser feedback on the page origin and blocks cross-origin credentials", async () => {
    feedbackMocks.native = false;
    vi.stubGlobal("location", { origin: "https://feature-preview.example.test" });
    vi.stubEnv("VITE_FEEDBACK_API_URL", "https://feature-preview.example.test");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: "feedback-web" }), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    await submitFeedback(report, "generation-fixture");
    expect(String(fetcher.mock.calls[0][0])).toBe("https://feature-preview.example.test/api/feedback");

    vi.stubEnv("VITE_FEEDBACK_API_URL", "https://attacker.example.test");
    feedbackMocks.getAttempt.mockClear();
    fetcher.mockClear();
    await expect(submitFeedback(report, "generation-fixture")).rejects.toThrow("invalid service destination");
    expect(feedbackMocks.getAttempt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
