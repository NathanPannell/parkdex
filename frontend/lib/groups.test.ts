import { describe, expect, it, vi } from "vitest";
import { addGroupPlace, createGroup, GroupsApiError, listGroups, normalizeGroups, removeGroupPlace } from "./groups";

const place = { id: "park-1", name: "One", category: "provincial" as const, latitude: 49, longitude: -124, region: "South", description: "", sourceUrl: "https://example.test", sourceName: "Source" };
const response = (body: unknown, status = 200) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("groups API client", () => {
  it("normalizes group place ids and keeps wishlist metadata", () => {
    const [group, wishlist] = normalizeGroups([{ id: "g1", name: "Weekend", placeIds: [place.id], places: [place] }, { id: "w1", name: "Wishlist", isWishlist: true, placeIds: [] }]);
    expect(group).toMatchObject({ id: "g1", placeIds: [place.id] });
    expect(wishlist.isWishlist).toBe(true);
  });

  it("uses the authenticated groups contract and deduplicates create members", async () => {
    const request = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(() => response({ id: "g1", name: "Weekend", placeIds: [place.id], places: [place] }));
    await createGroup(request, "Weekend", [place.id, place.id]);
    expect(request).toHaveBeenCalledWith("/api/groups", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Weekend", placeIds: [place.id] }) }));
  });

  it("adds and removes membership with bounded placeIds payloads", async () => {
    const request = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(() => response({ id: "g1", name: "Weekend", placeIds: [place.id], places: [place] }));
    await addGroupPlace(request, "g1", place.id);
    await removeGroupPlace(request, "g1", place.id);
    expect(request.mock.calls[0][0]).toBe("/api/groups/g1/places");
    expect(request.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ placeIds: [place.id] }) });
    expect(request.mock.calls[1][1]).toMatchObject({ method: "DELETE", body: JSON.stringify({ placeIds: [place.id] }) });
  });

  it("surfaces API status and detail without leaking response internals", async () => {
    const request = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(() => response({ detail: "Group not found" }, 404));
    await expect(listGroups(request)).rejects.toMatchObject({ name: "GroupsApiError", status: 404, message: "Group not found" } satisfies Partial<GroupsApiError>);
  });
});
