// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Place } from "./places";
import { useGroups } from "./use-groups";

const place: Place = {
  id: "park-1",
  name: "One",
  category: "provincial",
  latitude: 49,
  longitude: -124,
  region: "South",
  description: "",
  sourceUrl: "https://example.test",
  sourceName: "Source",
  sourceId: null,
};

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(cleanup);

describe("useGroups account isolation", () => {
  it("discards a list response from the previous account", async () => {
    const first = deferred<Response>();
    const requestA = vi.fn(() => first.promise);
    const requestB = vi.fn(() => json([{ id: "group-b", name: "B", isWishlist: false, placeIds: [] }]));
    const { result, rerender } = renderHook(
      ({ identityKey, request }) => useGroups({
        apiBaseUrl: "https://api.example.test",
        authenticated: true,
        identityKey,
        places: [place],
        request,
      }),
      { initialProps: { identityKey: "account-a", request: requestA } },
    );
    await waitFor(() => expect(requestA).toHaveBeenCalled());

    rerender({ identityKey: "account-b", request: requestB });
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["group-b"]));

    await act(async () => {
      first.resolve(await json([{ id: "group-a", name: "A", isWishlist: false, placeIds: [] }]));
      await first.promise;
    });
    expect(result.current.groups.map((group) => group.id)).toEqual(["group-b"]);
  });

  it("discards an in-flight membership mutation after account switch", async () => {
    const mutation = deferred<Response>();
    const requestA = vi.fn((path: string, init?: RequestInit) => init?.method === "POST"
      ? mutation.promise
      : json([{ id: "group-a", name: "A", isWishlist: false, placeIds: [] }]));
    const requestB = vi.fn(() => json([{ id: "group-b", name: "B", isWishlist: false, placeIds: [] }]));
    const { result, rerender } = renderHook(
      ({ identityKey, request }) => useGroups({
        apiBaseUrl: "https://api.example.test",
        authenticated: true,
        identityKey,
        places: [place],
        request,
      }),
      { initialProps: { identityKey: "account-a", request: requestA } },
    );
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["group-a"]));

    let pending!: Promise<void>;
    act(() => { pending = result.current.addPlace("group-a", place.id); });
    await waitFor(() => expect(requestA).toHaveBeenCalledWith(
      "/api/groups/group-a/places",
      expect.objectContaining({ method: "POST" }),
    ));

    rerender({ identityKey: "account-b", request: requestB });
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["group-b"]));
    expect(result.current.busy).toBe(false);
    await act(async () => {
      mutation.resolve(await json([{ id: "group-a", name: "A", isWishlist: false, placeIds: [place.id] }]));
      await pending;
    });
    expect(result.current.groups.map((group) => group.id)).toEqual(["group-b"]);
    expect(result.current.busy).toBe(false);
  });

  it("clears stale groups before reloading the empty Wishlist after a successful reset", async () => {
    const reload = deferred<Response>();
    let reads = 0;
    const request = vi.fn((path: string) => {
      expect(path).toBe("/api/groups");
      reads += 1;
      return reads === 1
        ? json([{ id: "old-group", name: "Old plans", isWishlist: false, placeIds: [place.id] }])
        : reload.promise;
    });
    const { result } = renderHook(() => useGroups({
      apiBaseUrl: "https://api.example.test",
      authenticated: true,
      identityKey: "account-a",
      places: [place],
      request,
    }));
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["old-group"]));

    let refreshing!: Promise<void>;
    act(() => { refreshing = result.current.refreshAfterReset(); });
    await waitFor(() => expect(result.current.groups).toEqual([]));
    await act(async () => {
      reload.resolve(await json([{ id: "new-wishlist", name: "Wishlist", isWishlist: true, placeIds: [] }]));
      await refreshing;
    });
    expect(result.current.groups.map((group) => group.id)).toEqual(["new-wishlist"]);
    expect(result.current.selectedGroupId).toBeNull();
  });
});
