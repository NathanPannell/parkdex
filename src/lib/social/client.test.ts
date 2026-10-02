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
  flushPendingCodes, formatFriendCode, friendLink, parseFriendCode, queueFriendCode, readPendingCodes, readSocialCache, writeSocialCache,
} = await import("./client");

const ACCOUNT = "ae172e85-a8ab-4e1d-a032-901100000001";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  localStorage.clear();
  fetchAuthenticated.mockReset();
});

describe("friend codes", () => {
  it("reads codes typed by hand or scanned from the QR link", () => {
    expect(parseFriendCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(parseFriendCode(" ABCD EFGH ")).toBe("ABCDEFGH");
    expect(parseFriendCode(friendLink("ABCDEFGH"))).toBe("ABCDEFGH");
    expect(parseFriendCode("ABCDEFG1")).toBeNull();
    expect(parseFriendCode("https://example.test/")).toBeNull();
    expect(formatFriendCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});

describe("offline friend codes", () => {
  it("queues each code once", () => {
    queueFriendCode(ACCOUNT, "ABCDEFGH");
    queueFriendCode(ACCOUNT, "ABCDEFGH");
    queueFriendCode(ACCOUNT, "HGFEDCBA");
    expect(readPendingCodes(ACCOUNT)).toEqual(["ABCDEFGH", "HGFEDCBA"]);
    expect(readPendingCodes("someone-else")).toEqual([]);
  });

  it("adds queued friends, drops codes the server rejects, and keeps the rest when offline", async () => {
    queueFriendCode(ACCOUNT, "AAAAAAAA");
    queueFriendCode(ACCOUNT, "BBBBBBBB");
    queueFriendCode(ACCOUNT, "CCCCCCCC");
    fetchAuthenticated
      .mockResolvedValueOnce(reply(201, { friend: { accountId: "f", displayName: "Robin", parksThisWeek: 0, totalParks: 3, isMe: false } }))
      .mockResolvedValueOnce(reply(404, { code: "code_not_found", message: "No one has that friend code." }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const result = await flushPendingCodes(ACCOUNT);
    expect(result.added.map((friend) => friend.displayName)).toEqual(["Robin"]);
    expect(result.rejected).toEqual([{ code: "BBBBBBBB", message: "No one has that friend code." }]);
    expect(readPendingCodes(ACCOUNT)).toEqual(["CCCCCCCC"]);
    expect(fetchAuthenticated).toHaveBeenCalledWith("/api/social/friends", expect.objectContaining({ method: "POST" }), ACCOUNT);
  });

  it("keeps codes when the session has expired", async () => {
    queueFriendCode(ACCOUNT, "AAAAAAAA");
    fetchAuthenticated.mockResolvedValueOnce(reply(401, { message: "Authentication required." }));
    await flushPendingCodes(ACCOUNT);
    expect(readPendingCodes(ACCOUNT)).toEqual(["AAAAAAAA"]);
  });
});

describe("cached board", () => {
  it("survives a reload per account", () => {
    const board = { weekStart: "2026-09-28T07:00:00Z", rows: [] };
    writeSocialCache(ACCOUNT, { profile: { displayName: "Nathan", friendCode: "ABCDEFGH" }, board, fetchedAt: "2026-10-02T08:00:00Z" });
    expect(readSocialCache(ACCOUNT).profile?.friendCode).toBe("ABCDEFGH");
    expect(readSocialCache("other").profile).toBeNull();
  });
});
