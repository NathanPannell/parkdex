import { describe, expect, it } from "vitest";
import { assertDemoToolsBuild, demoToolsAllowed } from "./demo";

describe("demo tools", () => {
  it("are absent from production builds such as web.parkdex.app", () => {
    expect(demoToolsAllowed({ DEV: false })).toBe(false);
    expect(demoToolsAllowed({ DEV: false, VITE_DEMO_TOOLS: "" })).toBe(false);
    expect(demoToolsAllowed({ DEV: false, VITE_DEMO_TOOLS: "true" })).toBe(false);
    expect(demoToolsAllowed(undefined)).toBe(false);
  });

  it("are absent from field builds, even in dev or with the opt-in", () => {
    expect(demoToolsAllowed({ DEV: true, VITE_FIELD: "1" })).toBe(false);
    expect(demoToolsAllowed({ DEV: false, VITE_FIELD: "1", VITE_DEMO_TOOLS: "1" })).toBe(false);
  });

  it("show in dev builds and in a local build that opts in", () => {
    expect(demoToolsAllowed({ DEV: true })).toBe(true);
    expect(demoToolsAllowed({ DEV: false, VITE_DEMO_TOOLS: "1" })).toBe(true);
  });

  it("refuse the opt-in on a hosted build", () => {
    expect(() => assertDemoToolsBuild({ VITE_DEMO_TOOLS: "1" }, true)).toThrow(/local builds only/);
    expect(() => assertDemoToolsBuild({ VITE_DEMO_TOOLS: "1" }, false)).not.toThrow();
    expect(() => assertDemoToolsBuild({}, true)).not.toThrow();
  });
});
