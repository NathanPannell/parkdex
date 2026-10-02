import { describe, expect, it, vi } from "vitest";
import { BuildMapSource } from "./buildMapSource";

const archive = { chunkBytes: 10, size: 25, chunkBaseUrl: "https://cdn.test/map/island" };
const bytes = (values: number[]) => new Uint8Array(values).buffer;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

function rangeFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const index = Number(url.match(/(\d{3})\.bin$/)![1]);
    const [, start, end] = String((init?.headers as Record<string, string>).Range).match(/bytes=(\d+)-(\d+)/)!;
    const base = index * archive.chunkBytes;
    return new Response(bytes(range(base + Number(start), base + Number(end) + 1)), { status: 206 });
  });
}

describe("BuildMapSource", () => {
  it("streams only the requested byte ranges from the CDN when online", async () => {
    const fetcher = rangeFetch();
    const readLocal = vi.fn();
    const source = new BuildMapSource({ key: "k", archive, isConnected: () => true, readLocal, fetch: fetcher as unknown as typeof fetch });

    const result = await source.getBytes(8, 5);

    expect([...new Uint8Array(result.data)]).toEqual([8, 9, 10, 11, 12]);
    expect(fetcher.mock.calls.map(([url, init]) => [url, (init!.headers as Record<string, string>).Range])).toEqual([
      ["https://cdn.test/map/island/000.bin", "bytes=8-9"],
      ["https://cdn.test/map/island/001.bin", "bytes=0-2"],
    ]);
    expect(readLocal).not.toHaveBeenCalled();
  });

  it("reads downloaded squares only when offline", async () => {
    const fetcher = rangeFetch();
    const readLocal = vi.fn(async (index: number, offset: number, length: number) =>
      bytes(range(index * 10 + offset, index * 10 + offset + length)));
    const source = new BuildMapSource({ key: "k", archive, isConnected: () => false, readLocal, fetch: fetcher as unknown as typeof fetch });

    const result = await source.getBytes(21, 3);

    expect([...new Uint8Array(result.data)]).toEqual([21, 22, 23]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(readLocal).toHaveBeenCalledWith(2, 1, 3);
  });

  it("falls back to a downloaded square when the network request fails", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const readLocal = vi.fn(async () => bytes([1, 2]));
    const source = new BuildMapSource({ key: "k", archive, isConnected: () => true, readLocal, fetch: fetcher as unknown as typeof fetch });

    expect([...new Uint8Array((await source.getBytes(0, 2)).data)]).toEqual([1, 2]);
  });

  it("reports an area that is neither online nor downloaded", async () => {
    const onUnavailable = vi.fn();
    const source = new BuildMapSource({ key: "k", archive, isConnected: () => false, readLocal: async () => null, onUnavailable });

    await expect(source.getBytes(0, 4)).rejects.toThrow(/not available offline/);
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it("slices a whole chunk when the server ignores Range", async () => {
    const fetcher = vi.fn(async () => new Response(bytes(range(0, 10)), { status: 200 }));
    const source = new BuildMapSource({ key: "k", archive, isConnected: () => true, readLocal: async () => null, fetch: fetcher as unknown as typeof fetch });

    expect([...new Uint8Array((await source.getBytes(3, 4)).data)]).toEqual([3, 4, 5, 6]);
  });
});
