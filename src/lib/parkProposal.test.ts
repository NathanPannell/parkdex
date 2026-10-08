import { describe, expect, it, vi } from "vitest";

vi.mock("./feedbackReport", () => ({ feedbackApiOrigin: () => "https://api.example.test" }));

import type { LngLat } from "./geo";
import { MAX_OUTLINE_POINTS, simplifyOutline, submitParkProposal } from "./parkProposal";

const proposal = {
  submissionId: "11111111-1111-4111-8111-111111111111",
  name: "Cedar Hill Woods",
  note: "",
  point: [-123.35, 48.45] as LngLat,
  outline: null,
};

describe("simplifyOutline", () => {
  it("keeps short outlines and thins long ones to the server limit", () => {
    const short: LngLat[] = [[0, 0], [1, 0], [1, 1]];
    expect(simplifyOutline(short)).toBe(short);
    const long = Array.from({ length: 1000 }, (_, i) => [i, i] as LngLat);
    const thinned = simplifyOutline(long);
    expect(thinned).toHaveLength(MAX_OUTLINE_POINTS);
    expect(thinned[0]).toEqual([0, 0]);
  });
});

describe("submitParkProposal", () => {
  it("posts the proposal with its build context", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 201 }));
    await submitParkProposal(proposal, fetcher as unknown as typeof fetch);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/park-proposals");
    const body = JSON.parse(String(init.body));
    expect(body.name).toBe("Cedar Hill Woods");
    expect(Object.keys(body.context).sort()).toEqual(["build", "platform", "version"]);
  });

  it("sends the analytics labels with the request", async () => {
    vi.stubGlobal("__APP_BUILD__", "abc1234");
    try {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 201 }));
      await submitParkProposal(proposal, fetcher as unknown as typeof fetch);
      const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect((init.headers as Record<string, string>)["X-Kip-Bundle-Id"]).toBe("abc1234");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("explains rate limits and server messages", async () => {
    const limited = vi.fn(async () => new Response("{}", { status: 429 }));
    await expect(submitParkProposal(proposal, limited as unknown as typeof fetch)).rejects.toThrow(/a lot of parks/);
    const invalid = vi.fn(async () => new Response(JSON.stringify({ message: "Give the park a name." }), { status: 400 }));
    await expect(submitParkProposal(proposal, invalid as unknown as typeof fetch)).rejects.toThrow("Give the park a name.");
  });
});
