import { afterEach, describe, expect, it, vi } from "vitest";
import { prewarmBundledOverview } from "./offlineTiles";

const mapLibreMock = vi.hoisted(() => ({
  addProtocol: vi.fn(),
  removeProtocol: vi.fn(),
}));

vi.mock("maplibre-gl", () => mapLibreMock);

afterEach(() => vi.unstubAllGlobals());

describe("bundled overview prewarm", () => {
  it("shares a pending archive read and retries after a failed preload", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary local read failure"))
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array(256).buffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const first = prewarmBundledOverview();
    const concurrent = prewarmBundledOverview();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mapLibreMock.addProtocol).toHaveBeenCalledWith("pmtiles", expect.any(Function));
    expect(mapLibreMock.addProtocol).toHaveBeenCalledWith("contentglyph", expect.any(Function));
    await expect(first).rejects.toThrow("temporary local read failure");
    await expect(concurrent).rejects.toThrow("temporary local read failure");

    await prewarmBundledOverview();
    await prewarmBundledOverview();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
