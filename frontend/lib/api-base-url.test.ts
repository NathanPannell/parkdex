import { describe, expect, it } from "vitest";

import { resolveApiBaseUrl } from "./api-base-url";

describe("static web API base URL", () => {
  it("uses the page origin for a park deep link", () => {
    const origin = new URL("https://preview.pages.dev/parks/goldstream-park").origin;
    const base = resolveApiBaseUrl(".", origin);
    expect(new URL(`${base}/api/places`).href).toBe("https://preview.pages.dev/api/places");
  });

  it("preserves an explicit API origin and the server snapshot", () => {
    expect(resolveApiBaseUrl("https://api.example.test", "https://preview.pages.dev")).toBe("https://api.example.test");
    expect(resolveApiBaseUrl(".")).toBe(".");
  });
});
