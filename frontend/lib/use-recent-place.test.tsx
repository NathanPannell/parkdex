// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const cacheMock = vi.hoisted(() => ({ get: vi.fn(), view: vi.fn() }));

vi.mock("./place-cache", () => ({
  getRecentPlaceCache: () => ({ get: cacheMock.get, view: cacheMock.view }),
}));

import type { CachedPlaceBundle } from "./place-cache";
import { getPlaceImage, getPlaceImages } from "./place-images";
import { useRecentPlace } from "./use-recent-place";

function bundle(id: string): CachedPlaceBundle {
  const place = {
    id,
    name: `Place ${id}`,
    category: "regional" as const,
    latitude: 49,
    longitude: -124,
    region: "Coast",
    description: "Place details",
    sourceUrl: "https://example.test/place",
    sourceName: "Example",
  };
  return {
    place,
    boundary: null,
    boundaryVersion: "v1",
    visitorInformation: null,
    image: null,
    descriptionSource: null,
    area: null,
    sourceAttribution: { place: { name: "Example", url: place.sourceUrl }, boundary: null, photo: null },
    photo: new Blob([id], { type: "image/webp" }),
    photoError: null,
    galleryPhotos: [],
    viewedAt: Date.now(),
  };
}

afterEach(() => {
  cleanup();
  cacheMock.get.mockReset();
  cacheMock.view.mockReset();
});

describe("useRecentPlace", () => {
  it("loads only the selected place and ignores a late completion from the previous selection", async () => {
    let releaseOld!: (value: CachedPlaceBundle) => void;
    cacheMock.get.mockResolvedValue(null);
    cacheMock.view.mockImplementation((id: string) => id === "old"
      ? new Promise<CachedPlaceBundle>((resolve) => { releaseOld = resolve; })
      : Promise.resolve(bundle(id)));

    const { result, rerender, unmount } = renderHook(
      ({ selectedId }: { selectedId: string | null }) => useRecentPlace({ selectedId, apiBaseUrl: "https://api.example.test" }),
      { initialProps: { selectedId: "old" } },
    );
    rerender({ selectedId: "new" });
    await waitFor(() => expect(result.current.place?.id).toBe("new"));

    await act(async () => { releaseOld(bundle("old")); });
    expect(result.current.selectedId).toBe("new");
    expect(result.current.place?.id).toBe("new");
    expect(cacheMock.view.mock.calls.map(([id]) => id)).toEqual(["old", "new"]);
    unmount();
  });

  it("shows durable cached details before a slow refresh finishes", async () => {
    cacheMock.get.mockResolvedValue(bundle("cached"));
    cacheMock.view.mockImplementation(() => new Promise<CachedPlaceBundle>(() => undefined));

    const { result } = renderHook(() => useRecentPlace({ selectedId: "cached", apiBaseUrl: "https://api.example.test" }));
    await waitFor(() => expect(result.current.place?.id).toBe("cached"));
    expect(result.current.status).toBe("ready");
    expect(cacheMock.view).toHaveBeenCalledOnce();
  });

  it("releases the selected full-photo object URL when selection changes", async () => {
    const createObjectUrl = vi.fn(() => "blob:recent-place-photo");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    cacheMock.get.mockResolvedValue(null);
    cacheMock.view.mockImplementation((id: string) => Promise.resolve(bundle(id)));

    const { result, rerender, unmount } = renderHook(
      ({ selectedId }: { selectedId: string | null }) => useRecentPlace({ selectedId, apiBaseUrl: "https://api.example.test" }),
      { initialProps: { selectedId: "one" } },
    );
    await waitFor(() => expect(result.current.photoUrl).toBe("blob:recent-place-photo"));
    rerender({ selectedId: "two" });
    await waitFor(() => expect(result.current.place?.id).toBe("two"));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:recent-place-photo");
    unmount();
  });

  it("warns when the full photo is missing and retries on reconnect", async () => {
    const placeId = "provincial-goldstream-park";
    const image = getPlaceImage(placeId) ?? null;
    expect(image).not.toBeNull();
    cacheMock.get.mockResolvedValue(null);
    cacheMock.view
      .mockResolvedValueOnce({ ...bundle(placeId), image, photo: null, photoError: "offline" })
      .mockResolvedValueOnce({ ...bundle(placeId), image });

    const { result } = renderHook(() => useRecentPlace({ selectedId: placeId, apiBaseUrl: "https://api.example.test" }));
    await waitFor(() => expect(result.current.warning).toContain("not fully saved for offline use"));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(cacheMock.view).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.photo).not.toBeNull());
    expect(result.current.warning).toBeNull();
  });

  it("keeps saved gallery metadata aligned with its bytes and releases every URL", async () => {
    const placeId = "provincial-bear-creek-park";
    const [primary, alternate] = getPlaceImages(placeId);
    expect(alternate).toBeDefined();
    const savedAlternate = { ...alternate, alt: "Previously saved description" };
    const cached = {
      ...bundle(placeId), image: primary,
      galleryPhotos: [{ image: savedAlternate, photo: new Blob(["alternate"]), photoError: null }],
    };
    const createObjectUrl = vi.fn().mockReturnValueOnce("blob:primary").mockReturnValueOnce("blob:alternate");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    cacheMock.get.mockResolvedValue(cached);
    cacheMock.view.mockRejectedValue(new Error("offline"));
    const { result, rerender, unmount } = renderHook(
      ({ selectedId }: { selectedId: string | null }) => useRecentPlace({ selectedId, apiBaseUrl: "https://api.example.test" }),
      { initialProps: { selectedId: placeId as string | null } },
    );
    await waitFor(() => expect(result.current.photoUrls).toEqual(["blob:primary", "blob:alternate"]));
    expect(result.current.images).toEqual([primary, savedAlternate]);
    expect(createObjectUrl.mock.calls.map(([photo]) => photo)).toEqual([cached.photo, cached.galleryPhotos[0].photo]);
    rerender({ selectedId: null });
    expect(result.current.photoUrls).toEqual([]);
    expect(revokeObjectUrl.mock.calls.map(([url]) => url)).toEqual(["blob:primary", "blob:alternate"]);
    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
  });

  it("retries a missing alternate photo on reconnect even when the primary is saved", async () => {
    const placeId = "provincial-bear-creek-park";
    const [image, alternate] = getPlaceImages(placeId);
    const incomplete = { ...bundle(placeId), image,
      galleryPhotos: [{ image: alternate, photo: null, photoError: "offline" }],
    };
    cacheMock.get.mockResolvedValue(null);
    cacheMock.view.mockResolvedValueOnce(incomplete).mockResolvedValueOnce({
      ...incomplete, galleryPhotos: [{ image: alternate, photo: new Blob(["alternate"]), photoError: null }],
    });
    const { result } = renderHook(() => useRecentPlace({ selectedId: placeId, apiBaseUrl: "https://api.example.test" }));
    await waitFor(() => expect(result.current.warning).toContain("not fully saved"));
    expect(result.current.photo).not.toBeNull();
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(result.current.warning).toBeNull());
    expect(result.current.bundle?.galleryPhotos[0].photo).not.toBeNull();
    expect(cacheMock.view).toHaveBeenCalledTimes(2);
  });
});
