import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAuthenticated = vi.fn();
vi.mock("../accounts/authClient", () => ({
  fetchAuthenticated: (...args: unknown[]) => fetchAuthenticated(...args),
  accountApiUrl: (path: string) => new URL(path, "https://staging.web.parkdex.app/").href,
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(), getLaunchUrl: vi.fn() } }));

const { FriendsError, fetchFriendsBoard, isFinalAddError, parseBoard, removeFriend, resetFriendCode, sendCrewmate, sendFriendCode } = await import("./client");
const { dropFriendCode, flushOutbox, OUTBOX_LIMIT, queueFriendCode, readCachedBoard, readOutbox, writeCachedBoard } = await import("./outbox");
const { friendCodeFromText, friendLink } = await import("./links");
const { sinceLabel, weekLabel } = await import("./format");

const ACCOUNT = "ae172e85-a8ab-4e1d-a032-901100000001";
const OTHER = "ae172e85-a8ab-4e1d-a032-901100000002";
const NOW = new Date("2026-10-14T17:00:00.000Z");

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const boardBody = {
  code: "ABCD2345",
  week: { start: "2026-10-12", end: "2026-10-18", resetsAt: "2026-10-19T07:00:00.000Z" },
  players: [
    { rank: 1, handle: "bee", flagSeed: "fedcba9876543210", uniqueParks: 4, isMe: false },
    { rank: 2, handle: "sam", flagSeed: "0123456789abcdef", uniqueParks: 2, isMe: true },
    { rank: 3, handle: "", flagSeed: "x", uniqueParks: 1 },
  ],
  serverTime: "2026-10-14T17:00:00.000Z",
};

beforeEach(() => {
  fetchAuthenticated.mockReset();
});

describe("friends client", () => {
  it("reads the board and drops malformed rows", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, boardBody));
    const board = await fetchFriendsBoard(ACCOUNT);
    expect(board.code).toBe("ABCD2345");
    expect(board.week).toEqual(boardBody.week);
    expect(board.players.map((row) => [row.handle, row.uniqueParks, row.isMe])).toEqual([
      ["bee", 4, false],
      ["sam", 2, true],
    ]);
    expect(fetchAuthenticated.mock.calls[0][0]).toBe("/api/friends");
    expect(fetchAuthenticated.mock.calls[0][2]).toBe(ACCOUNT);
  });

  it("refuses a board it cannot read", () => {
    expect(() => parseBoard({ ...boardBody, code: null })).toThrow(FriendsError);
    expect(() => parseBoard({ ...boardBody, week: { start: "Monday", end: "2026-10-18", resetsAt: "2026-10-19T07:00:00.000Z" } })).toThrow(FriendsError);
  });

  it("sends a friend code and maps errors by code", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { status: "added", friend: { handle: "bee", flagSeed: "fedcba9876543210" } }));
    await expect(sendFriendCode(ACCOUNT, "ABCD2345")).resolves.toEqual({ status: "added", friend: { handle: "bee", flagSeed: "fedcba9876543210" } });
    const [path, init] = fetchAuthenticated.mock.calls[0];
    expect(path).toBe("/api/friends");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ code: "ABCD2345" });
    fetchAuthenticated.mockResolvedValueOnce(reply(404, { error: { code: "friend_code_not_found", message: "x" }, code: "friend_code_not_found" }));
    await expect(sendFriendCode(ACCOUNT, "ABCD2345")).rejects.toMatchObject({ code: "friend_code_not_found", status: 404 });
    fetchAuthenticated.mockResolvedValueOnce(reply(401, {}));
    await expect(sendFriendCode(ACCOUNT, "ABCD2345")).rejects.toMatchObject({ code: "unauthenticated" });
    fetchAuthenticated.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(sendFriendCode(ACCOUNT, "ABCD2345")).rejects.toMatchObject({ code: "offline" });
  });

  it("adds a crewmate by handle and maps its errors", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { status: "already_friends", friend: { handle: "sam", flagSeed: "0123456789abcdef" } }));
    await expect(sendCrewmate(ACCOUNT, "sam")).resolves.toEqual({ status: "already_friends", friend: { handle: "sam", flagSeed: "0123456789abcdef" } });
    const [path, init] = fetchAuthenticated.mock.calls[0];
    expect(path).toBe("/api/friends/crewmate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ handle: "sam" });
    fetchAuthenticated.mockResolvedValueOnce(reply(404, { error: { code: "crewmate_not_found", message: "x" }, code: "crewmate_not_found" }));
    await expect(sendCrewmate(ACCOUNT, "sam")).rejects.toMatchObject({
      code: "crewmate_not_found",
      message: "Add crewmates here within a day of your crew. After that, use their friend code.",
    });
    fetchAuthenticated.mockResolvedValueOnce(reply(409, { code: "own_handle" }));
    await expect(sendCrewmate(ACCOUNT, "sam")).rejects.toMatchObject({ code: "own_handle" });
  });

  it("removes friends by handle and replaces the code", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { removed: true }));
    await removeFriend(ACCOUNT, "bee_2");
    expect(fetchAuthenticated.mock.calls[0][0]).toBe("/api/friends/bee_2");
    expect(fetchAuthenticated.mock.calls[0][1].method).toBe("DELETE");
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { code: "WXYZ6789" }));
    await expect(resetFriendCode(ACCOUNT)).resolves.toBe("WXYZ6789");
  });

  it("knows which add errors are final", () => {
    for (const code of ["friend_code_not_found", "own_friend_code", "too_many_friends", "invalid_friend_code"] as const) {
      expect(isFinalAddError(new FriendsError(code, 409)), code).toBe(true);
    }
    for (const code of ["offline", "unavailable", "unauthenticated", "handle_required"] as const) {
      expect(isFinalAddError(new FriendsError(code, 0)), code).toBe(false);
    }
    expect(isFinalAddError(new Error("x"))).toBe(false);
  });
});

describe("offline outbox", () => {
  it("queues each code once per account", () => {
    const storage = new MemoryStorage();
    queueFriendCode(ACCOUNT, "ABCD2345", "scan", NOW, storage);
    queueFriendCode(ACCOUNT, "ABCD2345", "typed", NOW, storage);
    queueFriendCode(ACCOUNT.toUpperCase(), "WXYZ6789", "link", NOW, storage);
    expect(readOutbox(ACCOUNT, storage)).toEqual([
      { code: "ABCD2345", queuedAt: NOW.toISOString(), source: "scan" },
      { code: "WXYZ6789", queuedAt: NOW.toISOString(), source: "link" },
    ]);
    expect(readOutbox(OTHER, storage)).toEqual([]);
    expect(dropFriendCode(ACCOUNT, "ABCD2345", storage).map((item) => item.code)).toEqual(["WXYZ6789"]);
    dropFriendCode(ACCOUNT, "WXYZ6789", storage);
    expect(storage.values.size).toBe(0);
  });

  it("keeps only the newest codes and ignores damaged storage", () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < OUTBOX_LIMIT + 5; index += 1) queueFriendCode(ACCOUNT, `CODE${String(index).padStart(4, "0")}`, "typed", NOW, storage);
    expect(readOutbox(ACCOUNT, storage)).toHaveLength(OUTBOX_LIMIT);
    storage.setItem(`parkdex.friends.outbox.v1.${ACCOUNT}`, "{not json");
    expect(readOutbox(ACCOUNT, storage)).toEqual([]);
    storage.setItem(`parkdex.friends.outbox.v1.${ACCOUNT}`, JSON.stringify([{ code: "ABCD2345", queuedAt: "x", source: "pigeon" }, { code: 5 }]));
    expect(readOutbox(ACCOUNT, storage)).toEqual([]);
  });

  it("sends waiting codes in order, drops final refusals and stops at the first retryable error", async () => {
    const storage = new MemoryStorage();
    for (const code of ["AAAA2222", "BBBB3333", "CCCC4444", "DDDD5555"]) queueFriendCode(ACCOUNT, code, "typed", NOW, storage);
    const sent: string[] = [];
    const result = await flushOutbox(
      ACCOUNT,
      async (code) => {
        sent.push(code);
        if (code === "BBBB3333") throw new FriendsError("friend_code_not_found", 404);
        if (code === "CCCC4444") throw new FriendsError("offline", 0);
        return { status: "added", friend: { handle: `h_${code.toLowerCase()}`, flagSeed: "0123456789abcdef" } };
      },
      storage,
    );
    expect(sent).toEqual(["AAAA2222", "BBBB3333", "CCCC4444"]);
    expect(result.outcomes.map((outcome) => [outcome.code, outcome.status])).toEqual([
      ["AAAA2222", "added"],
      ["BBBB3333", "rejected"],
    ]);
    expect(result.remaining.map((item) => item.code)).toEqual(["CCCC4444", "DDDD5555"]);

    // The next sync sends the rest; a code that was already added answers already_friends.
    const next = await flushOutbox(
      ACCOUNT,
      async (code) => ({ status: code === "CCCC4444" ? "already_friends" : "added", friend: { handle: "x_y", flagSeed: "0123456789abcdef" } }),
      storage,
    );
    expect(next.outcomes.map((outcome) => outcome.status)).toEqual(["already_friends", "added"]);
    expect(next.remaining).toEqual([]);
  });

  it("caches the last board per account", () => {
    const storage = new MemoryStorage();
    const board = parseBoard(boardBody);
    writeCachedBoard(ACCOUNT, board, NOW, storage);
    expect(readCachedBoard(ACCOUNT, storage)).toEqual({ board, fetchedAt: NOW.toISOString() });
    expect(readCachedBoard(OTHER, storage)).toBeNull();
  });
});

describe("friend links and labels", () => {
  it("finds the code in a scanned link or typed text", () => {
    expect(friendCodeFromText("https://web.parkdex.app/friend/ABCD2345")).toBe("ABCD2345");
    expect(friendCodeFromText(" abcd-2345 ")).toBe("ABCD2345");
    expect(friendCodeFromText("https://web.parkdex.app/crew/ABC234")).toBeNull();
    expect(friendCodeFromText("https://evil.test/friend/ABCD2345")).toBeNull();
    expect(friendCodeFromText("WIFI:S:park;;")).toBeNull();
  });

  it("builds links on the account host in the app", () => {
    expect(friendLink("ABCD2345")).toBe("https://staging.web.parkdex.app/friend/ABCD2345");
    expect(friendLink("ABCD2345", "https://web.parkdex.app")).toBe("https://web.parkdex.app/friend/ABCD2345");
  });

  it("labels the week and the age of an offline board", () => {
    expect(weekLabel({ start: "2026-10-12", end: "2026-10-18" })).toBe("12 – 18 Oct");
    expect(weekLabel({ start: "2026-10-26", end: "2026-11-01" })).toBe("26 Oct – 1 Nov");
    const now = Date.parse("2026-10-14T17:00:00.000Z");
    expect(sinceLabel("2026-10-14T16:59:40.000Z", now)).toBe("just now");
    expect(sinceLabel("2026-10-14T16:20:00.000Z", now)).toBe("40 min ago");
    expect(sinceLabel("2026-10-14T12:00:00.000Z", now)).toBe("5 h ago");
    expect(sinceLabel("2026-10-13T17:00:00.000Z", now)).toBe("1 day ago");
  });
});
