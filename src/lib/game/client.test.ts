import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAuthenticated = vi.fn();
const fetchAccountApi = vi.fn();
vi.mock("../accounts/authClient", () => ({
  fetchAuthenticated: (...args: unknown[]) => fetchAuthenticated(...args),
  fetchAccountApi: (...args: unknown[]) => fetchAccountApi(...args),
}));

const {
  GameError, createVisitId, fetchFlags, fetchGameLeaderboard, fetchGameMe, handleProblem, isOfflineError, markTakeoversSeen,
  normalizeHandle, saveHandle, sendVisit,
} = await import("./client");

const ACCOUNT = "ae172e85-a8ab-4e1d-a032-901100000001";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  fetchAuthenticated.mockReset();
  fetchAccountApi.mockReset();
});

describe("handles", () => {
  it("normalizes what the player typed", () => {
    expect(normalizeHandle("  @Robin_42 ")).toBe("robin_42");
    expect(normalizeHandle("@@sam")).toBe("sam");
  });

  it("explains a handle with the wrong shape", () => {
    expect(handleProblem("ab")).toMatch(/at least 3/);
    expect(handleProblem("a".repeat(21))).toMatch(/20 characters/);
    expect(handleProblem("robin-k")).toMatch(/letters, numbers/);
    expect(handleProblem("robin_k")).toBeNull();
  });

  it("saves a handle and returns the player", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { player: { handle: "robin", flagSeed: "f00d" } }));
    await expect(saveHandle(ACCOUNT, "robin")).resolves.toEqual({ handle: "robin", flagSeed: "f00d" });
    const [path, init, accountId] = fetchAuthenticated.mock.calls[0];
    expect(path).toBe("/api/game/handle");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ handle: "robin" });
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(accountId).toBe(ACCOUNT);
  });

  it("reports taken and rejected handles by code", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(409, { error: "handle_taken" }));
    await expect(saveHandle(ACCOUNT, "robin")).rejects.toMatchObject({ code: "handle_taken", status: 409 });
    fetchAuthenticated.mockResolvedValueOnce(reply(422, { code: "handle_rejected", message: "no" }));
    await expect(saveHandle(ACCOUNT, "robin")).rejects.toMatchObject({ code: "handle_rejected", status: 422 });
  });
});

describe("player state", () => {
  it("reads the player, score, held parks and takeovers", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, {
      player: { handle: "robin", flagSeed: "abc" },
      score: 12,
      parks: [{ parkId: "beacon-hill", since: "2026-10-01T00:00:00Z", days: 6 }, { parkId: 7 }],
      takeovers: [{ parkId: "blueberry", byHandle: "sam", byFlagSeed: "def", at: "2026-10-06T00:00:00Z" }],
    }));
    await expect(fetchGameMe(ACCOUNT)).resolves.toEqual({
      player: { handle: "robin", flagSeed: "abc" },
      score: 12,
      parks: [{ parkId: "beacon-hill", since: "2026-10-01T00:00:00Z", days: 6 }],
      takeovers: [{ parkId: "blueberry", byHandle: "sam", byFlagSeed: "def", at: "2026-10-06T00:00:00Z" }],
      flagSeed: "abc",
      visitedToday: [],
      visitedDay: null,
    });
    expect(fetchAuthenticated).toHaveBeenCalledWith("/api/game/me", expect.anything(), ACCOUNT);
  });

  it("reads today's visited parks with the Victoria day the server answered on", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, {
      player: { handle: "robin", flagSeed: "abc" }, score: 0, parks: [], takeovers: [],
      // 23:30 in Victoria on October 7 is already October 8 in UTC.
      visitedToday: ["beacon-hill", 7, ""], serverTime: "2026-10-08T06:30:00.000Z",
    }));
    await expect(fetchGameMe(ACCOUNT)).resolves.toMatchObject({ visitedToday: ["beacon-hill"], visitedDay: "2026-10-07" });
  });

  it("treats a missing player as no handle yet, keeping the flag seed if the server sends it", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { player: null, score: 0, parks: [], takeovers: [] }));
    await expect(fetchGameMe(ACCOUNT)).resolves.toMatchObject({ player: null, score: 0, flagSeed: null });
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { player: null, flagSeed: "early", score: 0, parks: [], takeovers: [] }));
    await expect(fetchGameMe(ACCOUNT)).resolves.toMatchObject({ player: null, flagSeed: "early" });
  });

  it("reads the server's shape for an invalid handle", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(400, { error: { code: "invalid_handle", message: "x" }, code: "invalid_handle", message: "x" }));
    await expect(saveHandle(ACCOUNT, "a")).rejects.toMatchObject({ code: "invalid_handle", status: 400 });
  });

  it("marks takeovers seen up to a time", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, {}));
    await markTakeoversSeen(ACCOUNT, "2026-10-06T00:00:00Z");
    const [path, init] = fetchAuthenticated.mock.calls[0];
    expect(path).toBe("/api/game/takeovers/seen");
    expect(JSON.parse(init.body)).toEqual({ at: "2026-10-06T00:00:00Z" });
  });
});

describe("visits", () => {
  it("sends the visit id and park and reads the outcome", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, {
      visit: { visitId: "v1", parkId: "blueberry", outcome: "took", pointsEarned: 4, previousHolder: { handle: "sam", flagSeed: "x" }, flagSince: "2026-10-07T00:00:00Z" },
    }));
    await expect(sendVisit(ACCOUNT, { visitId: "v1", parkId: "blueberry" })).resolves.toEqual({
      visitId: "v1", parkId: "blueberry", outcome: "took", pointsEarned: 4, previousHolder: { handle: "sam", flagSeed: "x" }, flagSince: "2026-10-07T00:00:00Z",
    });
    const [path, init] = fetchAuthenticated.mock.calls[0];
    expect(path).toBe("/api/game/visits");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ visitId: "v1", parkId: "blueberry" });
  });

  it("rejects an outcome this build does not know", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { visit: { visitId: "v1", parkId: "p", outcome: "exploded" } }));
    await expect(sendVisit(ACCOUNT, { visitId: "v1", parkId: "p" })).rejects.toBeInstanceOf(GameError);
  });

  it("says when a handle is required", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(409, { error: "handle_required" }));
    await expect(sendVisit(ACCOUNT, { visitId: "v1", parkId: "p" })).rejects.toMatchObject({ code: "handle_required" });
  });

  it("turns a network failure into an offline error", async () => {
    fetchAuthenticated.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const error = await sendVisit(ACCOUNT, { visitId: "v1", parkId: "p" }).catch((caught: unknown) => caught);
    expect(isOfflineError(error)).toBe(true);
  });

  it("keeps other request failures distinct from being offline", async () => {
    fetchAuthenticated.mockRejectedValueOnce(new Error("The security token is missing."));
    const error = await sendVisit(ACCOUNT, { visitId: "v1", parkId: "p" }).catch((caught: unknown) => caught);
    expect(isOfflineError(error)).toBe(false);
    expect(error).toMatchObject({ code: "unavailable", message: "The security token is missing." });
  });

  it("makes a fresh lower-case UUID per visit", () => {
    const a = createVisitId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createVisitId()).not.toBe(a);
  });
});

describe("public reads", () => {
  it("reads flags without an account and drops malformed rows", async () => {
    fetchAccountApi.mockResolvedValueOnce(reply(200, {
      flags: [{ parkId: "a", handle: "robin", flagSeed: "s", since: "2026-10-01T00:00:00Z" }, { parkId: "b" }],
      serverTime: "2026-10-07T00:00:00Z",
    }));
    await expect(fetchFlags()).resolves.toEqual({
      flags: [{ parkId: "a", handle: "robin", flagSeed: "s", since: "2026-10-01T00:00:00Z" }],
      founders: [],
      serverTime: "2026-10-07T00:00:00Z",
    });
    expect(fetchAccountApi).toHaveBeenCalledWith("/api/game/flags", expect.anything());
    expect(fetchAuthenticated).not.toHaveBeenCalled();
  });

  it("reads founded parks and their covers with the flags", async () => {
    fetchAccountApi.mockResolvedValueOnce(reply(200, {
      flags: [],
      founders: [{ parkId: "a", handle: "robin", coverUrl: "/api/parks/a/cover/x.jpg" }, { parkId: "b", handle: null, coverUrl: null }, { handle: "x" }],
      serverTime: "2026-10-07T00:00:00Z",
    }));
    await expect(fetchFlags()).resolves.toMatchObject({ founders: [
      { parkId: "a", handle: "robin", coverUrl: "/api/parks/a/cover/x.jpg" },
      { parkId: "b", handle: null, coverUrl: null },
    ] });
  });

  it("reads the leaderboard", async () => {
    fetchAccountApi.mockResolvedValueOnce(reply(200, {
      players: [{ rank: 1, handle: "robin", flagSeed: "s", score: 9, parksHeld: 2 }],
      serverTime: "2026-10-07T00:00:00Z",
    }));
    await expect(fetchGameLeaderboard()).resolves.toMatchObject({ players: [{ rank: 1, handle: "robin", score: 9, parksHeld: 2 }] });
  });

  it("reports a server failure as unavailable", async () => {
    fetchAccountApi.mockResolvedValueOnce(new Response("oops", { status: 503 }));
    await expect(fetchFlags()).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });
});
