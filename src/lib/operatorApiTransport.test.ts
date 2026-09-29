import { describe, expect, it, vi } from "vitest";
import { fetchOperatorApi, operatorApiUrl } from "./operatorApiTransport";

describe("operator private-data transport", () => {
  const pageOrigin = "https://staging.web.parkdex.app";

  it("builds only same-origin operator API paths", () => {
    expect(operatorApiUrl("/api/operator/feedback/123", pageOrigin)).toBe(`${pageOrigin}/api/operator/feedback/123`);
    expect(() => operatorApiUrl("https://attacker.example.test/api/operator/feedback", pageOrigin)).toThrow();
    expect(() => operatorApiUrl("https://@staging.web.parkdex.app/api/operator/feedback", pageOrigin)).toThrow();
    expect(() => operatorApiUrl("/api/auth/login", pageOrigin)).toThrow();
    expect(() => operatorApiUrl("/api/operator/feedback", "http://staging.web.parkdex.app")).toThrow();
  });

  it("allows explicit loopback HTTP only for local development", () => {
    const local = "http://localhost:5190";
    expect(operatorApiUrl("/api/operator/feedback", local, true)).toBe(`${local}/api/operator/feedback`);
    expect(() => operatorApiUrl("/api/operator/feedback", local, false)).toThrow();
    expect(() => operatorApiUrl("/api/operator/feedback", "http://192.168.1.3:5190", true)).toThrow();
  });

  it("uses same-origin cookies and rejects redirects for operator credentials and reports", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const response = await fetchOperatorApi(
      "/api/operator/feedback/123",
      { method: "POST", body: "private report fixture" },
      fetcher,
      { pageOrigin },
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(input)).toBe(`${pageOrigin}/api/operator/feedback/123`);
    expect(init.credentials).toBe("same-origin");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(init.body).toBe("private report fixture");
  });

  it("rejects cross-origin operator targets before invoking fetch", async () => {
    const fetcher = vi.fn();
    expect(() => fetchOperatorApi("https://attacker.example.test/api/operator/feedback", {}, fetcher, { pageOrigin })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
