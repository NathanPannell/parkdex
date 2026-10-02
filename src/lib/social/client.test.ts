import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAuthenticated = vi.fn();
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
});
vi.mock("../accounts/authClient", async (original) => ({
  ...(await original<typeof import("../accounts/authClient")>()),
  fetchAuthenticated: (...args: unknown[]) => fetchAuthenticated(...args),
}));

const {
  GUEST_OWNER, adoptGuestFriends, flushPendingFriends, formatFriendCode, friendLink, parseFriendLink, readPendingFriends, readSocialCache,
  saveFriend, writeSocialCache,
} = await import("./client");

const ACCOUNT = "ae172e85-a8ab-4e1d-a032-901100000001";
const ORIGIN = "https://staging.web.parkdex.app";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  localStorage.clear();
  fetchAuthenticated.mockReset();
});

describe("friend links", () => {
  it("round-trips the code and name through the QR link", () => {
    const link = friendLink(ORIGIN, "ABCDEFGH", "Robin & Sam");
    expect(link).toBe("https://staging.web.parkdex.app/friend/ABCDEFGH?n=Robin+%26+Sam");
    expect(parseFriendLink(link)).toEqual({ code: "ABCDEFGH", name: "Robin & Sam" });
    expect(parseFriendLink(friendLink(ORIGIN, "ABCDEFGH", null))).toEqual({ code: "ABCDEFGH", name: null });
  });

  it("rejects links that are not friend links", () => {
    expect(parseFriendLink("https://staging.web.parkdex.app/account?code=ABCDEFGH")).toBeNull();
    expect(parseFriendLink("https://example.test/")).toBeNull();
    expect(parseFriendLink("ABCDEFG1")).toBeNull();
    expect(parseFriendLink("abcd-efgh")).toEqual({ code: "ABCDEFGH", name: null });
    expect(formatFriendCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});

describe("saved friends", () => {
  it("saves each friend once per owner", () => {
    saveFriend(ACCOUNT, { code: "ABCDEFGH", name: "Robin" });
    saveFriend(ACCOUNT, { code: "ABCDEFGH", name: "Robin" });
    saveFriend(ACCOUNT, { code: "HGFEDCBA", name: null });
    expect(readPendingFriends(ACCOUNT).map((friend) => friend.code)).toEqual(["ABCDEFGH", "HGFEDCBA"]);
    expect(readPendingFriends("someone-else")).toEqual([]);
  });

  it("hands a guest's saved friends to the account they sign in with", () => {
    saveFriend(GUEST_OWNER, { code: "ABCDEFGH", name: "Robin" });
    saveFriend(ACCOUNT, { code: "HGFEDCBA", name: "Sam" });
    expect(adoptGuestFriends(ACCOUNT)).toBe(1);
    expect(readPendingFriends(GUEST_OWNER)).toEqual([]);
    expect(readPendingFriends(ACCOUNT).map((friend) => friend.name)).toEqual(["Sam", "Robin"]);
    expect(adoptGuestFriends(ACCOUNT)).toBe(0);
  });

  it("sends saved friends, drops codes the server rejects, and keeps the rest when offline", async () => {
    saveFriend(ACCOUNT, { code: "AAAAAAAA", name: "Robin" });
    saveFriend(ACCOUNT, { code: "BBBBBBBB", name: "Old code" });
    saveFriend(ACCOUNT, { code: "CCCCCCCC", name: "Sam" });
    fetchAuthenticated
      .mockResolvedValueOnce(reply(201, { friend: { accountId: "f", displayName: "Robin", parksThisMonth: 0, totalParks: 3, isMe: false } }))
      .mockResolvedValueOnce(reply(404, { code: "code_not_found", message: "No one has that friend code." }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const result = await flushPendingFriends(ACCOUNT);
    expect(result.added.map((friend) => friend.displayName)).toEqual(["Robin"]);
    expect(result.rejected.map((entry) => [entry.friend.name, entry.message])).toEqual([["Old code", "No one has that friend code."]]);
    expect(readPendingFriends(ACCOUNT).map((friend) => friend.code)).toEqual(["CCCCCCCC"]);
    expect(fetchAuthenticated).toHaveBeenCalledWith("/api/social/friends", expect.objectContaining({ method: "POST" }), ACCOUNT);
  });

  it("keeps saved friends when the session has expired", async () => {
    saveFriend(ACCOUNT, { code: "AAAAAAAA", name: null });
    fetchAuthenticated.mockResolvedValueOnce(reply(401, { message: "Authentication required." }));
    await flushPendingFriends(ACCOUNT);
    expect(readPendingFriends(ACCOUNT)).toHaveLength(1);
  });
});

describe("cached board", () => {
  it("survives a reload per account", () => {
    const board = { monthStart: "2026-10-01T07:00:00Z", rows: [] };
    writeSocialCache(ACCOUNT, { profile: { displayName: "Nathan", friendCode: "ABCDEFGH" }, board, fetchedAt: "2026-10-02T08:00:00Z" });
    expect(readSocialCache(ACCOUNT).profile?.friendCode).toBe("ABCDEFGH");
    expect(readSocialCache("other").profile).toBeNull();
  });
});
