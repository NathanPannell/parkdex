import { afterEach, expect, it, vi } from "vitest";
import { publicAssetUrl } from "./public-assets";

afterEach(() => vi.unstubAllEnvs());
it("keeps web assets on the current origin", () => {
  vi.stubEnv("NEXT_PUBLIC_ASSET_BASE_URL", "");
  expect(publicAssetUrl("/places/park.webp")).toBe("/places/park.webp");
});
it("streams Android assets from the configured environment without rewriting external sources", () => {
  vi.stubEnv("NEXT_PUBLIC_ASSET_BASE_URL", "https://staging.web.parkdex.app/");
  expect(publicAssetUrl("/places/park.webp")).toBe("https://staging.web.parkdex.app/places/park.webp");
  expect(publicAssetUrl("https://example.org/source")).toBe("https://example.org/source");
});
