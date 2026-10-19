import { describe, expect, it } from "vitest";
import { BASE_OVERVIEW_KEY, BUILD_MAP_KEY, detailedAreaTile } from "./offlineTiles";

const request = (url: string) => ({ url, type: "arrayBuffer" as const });

describe("detailed map tiles", () => {
  it("answers tiles between content areas as empty without reading the archive", async () => {
    // No archive is registered, so any read would reject.
    await expect(detailedAreaTile(request(`pmtiles://${BUILD_MAP_KEY}/9/143/186`), new AbortController())).resolves.toMatchObject({ data: new Uint8Array() });
    await expect(detailedAreaTile(request(`pmtiles://${encodeURIComponent("release-v2")}/7/25/41`), new AbortController())).resolves.toMatchObject({
      data: new Uint8Array(),
    });
  });

  it("reads tiles inside an area, and every bundled base map tile, from the archive", async () => {
    await expect(detailedAreaTile(request(`pmtiles://${BUILD_MAP_KEY}/9/165/184`), new AbortController())).rejects.toThrow("not registered");
    await expect(detailedAreaTile(request(`pmtiles://${BASE_OVERVIEW_KEY}/5/8/11`), new AbortController())).rejects.toThrow("not registered");
  });
});
