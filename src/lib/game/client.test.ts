import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAuthenticated = vi.fn();
const fetchAccountApi = vi.fn();
vi.mock("../accounts/authClient", () => ({
  fetchAuthenticated: (...args: unknown[]) => fetchAuthenticated(...args),
  fetchAccountApi: (...args: unknown[]) => fetchAccountApi(...args),
}));

const {
  GameError,
  createVisitId,
  fetchFlags,
  fetchGameLeaderboard,
  fetchGameMe,
  handleProblem,
  isOfflineError,
  markTakeoversSeen,
  savePatches,
  normalizeHandle,
  saveHandle,
  sendVisit,
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
    fetchAuthenticated.mockResolvedValueOnce(
      reply(200, {
        player: { handle: "robin", flagSeed: "abc" },
        score: 1234,
        parks: [
          { parkId: "beacon-hill", since: "2026-10-01T00:00:00Z", days: 6, hours: 150 },
          { parkId: "thetis", since: "2026-10-05T00:00:00Z", days: 2 },
          { parkId: 7 },
        ],
        takeovers: [{ parkId: "blueberry", byHandle: "sam", byFlagSeed: "def", at: "2026-10-06T00:00:00Z" }],
      }),
    );
    await expect(fetchGameMe(ACCOUNT)).resolves.toEqual({
      player: { handle: "robin", flagSeed: "abc" },
      score: 1234,
      // A park without hours comes from a server before #169: at least 24 hours a day.
      parks: [
        { parkId: "beacon-hill", since: "2026-10-01T00:00:00Z", days: 6, hours: 150, crew: null },
        { parkId: "thetis", since: "2026-10-05T00:00:00Z", days: 2, hours: 48, crew: null },
      ],
      takeovers: [{ parkId: "blueberry", byHandle: "sam", byFlagSeed: "def", at: "2026-10-06T00:00:00Z" }],
      flagSeed: "abc",
      visitedToday: [],
      visitedTodayUntil: null,
      loggedToday: [],
      foundingReviews: { pending: [], decided: [] },
      // A server from before #175 sends no badges: undefined, so the app hides the shelf.
      badges: undefined,
      flagPatches: [],
      newBadges: [],
    });
    expect(fetchAuthenticated).toHaveBeenCalledWith("/api/game/me", expect.anything(), ACCOUNT);
  });

  it("reads badges, flag patches and new badges, dropping malformed ones (#175)", async () => {
    fetchAuthenticated.mockResolvedValueOnce(
      reply(200, {
        player: { handle: "robin", flagSeed: "abc" },
        score: 0,
        parks: [],
        takeovers: [],
        badges: [
          { id: "parks-1", progress: 1, goal: 1, unlockedAt: "2026-10-01T00:00:00Z" },
          { id: "parks-10", progress: 14, goal: 10, unlockedAt: null },
          { id: "Bad Id", progress: 1, goal: 1, unlockedAt: null },
          { progress: 1 },
        ],
        flagPatches: ["parks-1", "parks-1", "<script>", "hold-7", "crew-1", "founder"],
        newBadges: [
          { id: "hold-7", unlockedAt: "2026-10-08T00:00:00Z" },
          { id: "x", unlockedAt: "never" },
        ],
      }),
    );
    const me = await fetchGameMe(ACCOUNT);
    expect(me.badges).toEqual([
      { id: "parks-1", progress: 1, goal: 1, unlockedAt: "2026-10-01T00:00:00Z" },
      { id: "parks-10", progress: 10, goal: 10, unlockedAt: null },
    ]);
    expect(me.flagPatches).toEqual(["parks-1", "hold-7", "crew-1"]);
    expect(me.newBadges).toEqual([{ id: "hold-7", unlockedAt: "2026-10-08T00:00:00Z" }]);
  });

  it("saves flag patches and reads back what the server kept (#175)", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { patches: ["hold-7", "parks-1"] }));
    await expect(savePatches(ACCOUNT, ["hold-7", "parks-1"])).resolves.toEqual(["hold-7", "parks-1"]);
    const [path, init] = fetchAuthenticated.mock.calls[0];
    expect(path).toBe("/api/game/me/patches");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ patches: ["hold-7", "parks-1"] });
    fetchAuthenticated.mockResolvedValueOnce(reply(409, { code: "badge_locked" }));
    await expect(savePatches(ACCOUNT, ["hold-30"])).rejects.toMatchObject({ code: "badge_locked", status: 409 });
  });

  it("reads pending founding reviews and unseen decisions, dropping malformed ones", async () => {
    fetchAuthenticated.mockResolvedValueOnce(
      reply(200, {
        player: null,
        score: 0,
        parks: [],
        takeovers: [],
        foundingReviews: {
          pending: [
            { requestId: "r1", parkId: "beacon-hill", parkName: "Beacon Hill", createdAt: "2026-10-10T01:00:00Z" },
            { requestId: "r2", parkId: null, parkName: "Paterson Park", createdAt: "2026-10-10T02:00:00Z" },
            { requestId: "r3", parkId: "x", parkName: "X", createdAt: "not a time" },
          ],
          decided: [
            {
              requestId: "d1",
              status: "approved",
              parkId: "osm-way-1",
              parkName: "Paterson Park",
              reason: null,
              coverUrl: "/api/parks/osm-way-1/cover/a.jpg",
              founderHandle: "tester_one",
              decidedAt: "2026-10-10T03:00:00Z",
            },
            {
              requestId: "d2",
              status: "rejected",
              parkId: "beacon-hill",
              parkName: "Beacon Hill",
              reason: "  Too dark or blurry  ",
              coverUrl: null,
              founderHandle: null,
              decidedAt: "2026-10-10T04:00:00Z",
            },
            { requestId: "d3", status: "superseded", parkId: "beacon-hill", founderHandle: "sam", decidedAt: "2026-10-10T05:00:00Z" },
            { requestId: "d4", status: "maybe", parkId: "p", parkName: "P", decidedAt: "2026-10-10T05:00:00Z" },
          ],
        },
      }),
    );
    const me = await fetchGameMe(ACCOUNT);
    expect(me.foundingReviews).toEqual({
      pending: [
        { requestId: "r1", parkId: "beacon-hill", parkName: "Beacon Hill", createdAt: "2026-10-10T01:00:00Z" },
        { requestId: "r2", parkId: null, parkName: "Paterson Park", createdAt: "2026-10-10T02:00:00Z" },
      ],
      decided: [
        {
          requestId: "d1",
          status: "approved",
          parkId: "osm-way-1",
          parkName: "Paterson Park",
          reason: null,
          coverUrl: "/api/parks/osm-way-1/cover/a.jpg",
          founderHandle: "tester_one",
          decidedAt: "2026-10-10T03:00:00Z",
        },
        {
          requestId: "d2",
          status: "rejected",
          parkId: "beacon-hill",
          parkName: "Beacon Hill",
          reason: "Too dark or blurry",
          coverUrl: null,
          founderHandle: null,
          decidedAt: "2026-10-10T04:00:00Z",
        },
        {
          requestId: "d3",
          status: "superseded",
          parkId: "beacon-hill",
          parkName: "this park",
          reason: null,
          coverUrl: null,
          founderHandle: "sam",
          decidedAt: "2026-10-10T05:00:00Z",
        },
      ],
    });
  });

  it("reads today's visited parks and when the server's day ends", async () => {
    fetchAuthenticated.mockResolvedValueOnce(
      reply(200, {
        player: { handle: "robin", flagSeed: "abc" },
        score: 0,
        parks: [],
        takeovers: [],
        visitedToday: ["beacon-hill", 7, ""],
        visitedTodayUntil: "2026-10-09T07:00:00.000Z",
      }),
    );
    await expect(fetchGameMe(ACCOUNT)).resolves.toMatchObject({ visitedToday: ["beacon-hill"], visitedTodayUntil: "2026-10-09T07:00:00.000Z" });
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { player: null, score: 0, parks: [], takeovers: [], visitedTodayUntil: "soon" }));
    await expect(fetchGameMe(ACCOUNT)).resolves.toMatchObject({ visitedToday: [], visitedTodayUntil: null });
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
    fetchAuthenticated.mockResolvedValueOnce(
      reply(200, {
        visit: {
          visitId: "v1",
          parkId: "blueberry",
          outcome: "took",
          pointsEarned: 4,
          previousHolder: { handle: "sam", flagSeed: "x" },
          flagSince: "2026-10-07T00:00:00Z",
        },
      }),
    );
    await expect(sendVisit(ACCOUNT, { visitId: "v1", parkId: "blueberry" })).resolves.toEqual({
      visitId: "v1",
      parkId: "blueberry",
      outcome: "took",
      pointsEarned: 4,
      pointsBreakdown: { base: 4, days: 0 },
      previousHolder: { handle: "sam", flagSeed: "x" },
      flagSince: "2026-10-07T00:00:00Z",
      protected: null,
    });
    const [path, init] = fetchAuthenticated.mock.calls[0];
    expect(path).toBe("/api/game/visits");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ visitId: "v1", parkId: "blueberry" });
  });

  it("reads the badges a visit unlocked (#175)", async () => {
    fetchAuthenticated.mockResolvedValueOnce(
      reply(200, {
        visit: { visitId: "v3", parkId: "blueberry", outcome: "planted", pointsEarned: 6, previousHolder: null, flagSince: null },
        newBadges: [{ id: "parks-1", unlockedAt: "2026-10-07T00:00:00Z" }, { id: 3 }],
      }),
    );
    await expect(sendVisit(ACCOUNT, { visitId: "v3", parkId: "blueberry" })).resolves.toMatchObject({
      newBadges: [{ id: "parks-1", unlockedAt: "2026-10-07T00:00:00Z" }],
    });
  });

  it("reads the points breakdown of a take", async () => {
    fetchAuthenticated.mockResolvedValueOnce(
      reply(200, {
        visit: {
          visitId: "v2",
          parkId: "blueberry",
          outcome: "took",
          pointsEarned: 14,
          pointsBreakdown: { base: 4, days: 10 },
          previousHolder: null,
          flagSince: null,
        },
      }),
    );
    await expect(sendVisit(ACCOUNT, { visitId: "v2", parkId: "blueberry" })).resolves.toMatchObject({
      pointsEarned: 14,
      pointsBreakdown: { base: 4, days: 10 },
    });
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
    fetchAccountApi.mockResolvedValueOnce(
      reply(200, {
        flags: [
          { parkId: "a", handle: "robin", flagSeed: "s", since: "2026-10-01T00:00:00Z" },
          { parkId: "c", handle: "sam", flagSeed: "t", since: "2026-10-01T00:00:00Z", patches: ["hold-7", "parks-1", "crew-1", "founder"] },
          { parkId: "b" },
        ],
        serverTime: "2026-10-07T00:00:00Z",
      }),
    );
    await expect(fetchFlags()).resolves.toEqual({
      // patches are additive (#175): none from an older server, at most 3.
      flags: [
        { parkId: "a", handle: "robin", flagSeed: "s", since: "2026-10-01T00:00:00Z", crew: null, patches: [] },
        { parkId: "c", handle: "sam", flagSeed: "t", since: "2026-10-01T00:00:00Z", crew: null, patches: ["hold-7", "parks-1", "crew-1"] },
      ],
      founders: [],
      serverTime: "2026-10-07T00:00:00Z",
    });
    expect(fetchAccountApi).toHaveBeenCalledWith("/api/game/flags", expect.anything());
    expect(fetchAuthenticated).not.toHaveBeenCalled();
  });

  it("reads founded parks and their covers with the flags", async () => {
    fetchAccountApi.mockResolvedValueOnce(
      reply(200, {
        flags: [],
        founders: [{ parkId: "a", handle: "robin", coverUrl: "/api/parks/a/cover/x.jpg" }, { parkId: "b", handle: null, coverUrl: null }, { handle: "x" }],
        serverTime: "2026-10-07T00:00:00Z",
      }),
    );
    await expect(fetchFlags()).resolves.toMatchObject({
      founders: [
        { parkId: "a", handle: "robin", coverUrl: "/api/parks/a/cover/x.jpg" },
        { parkId: "b", handle: null, coverUrl: null },
      ],
    });
  });

  it("reads the leaderboard", async () => {
    fetchAccountApi.mockResolvedValueOnce(
      reply(200, {
        players: [{ rank: 1, handle: "robin", flagSeed: "s", score: 9, parksHeld: 2 }],
        serverTime: "2026-10-07T00:00:00Z",
      }),
    );
    await expect(fetchGameLeaderboard()).resolves.toMatchObject({ players: [{ rank: 1, handle: "robin", score: 9, parksHeld: 2 }] });
  });

  it("reports a server failure as unavailable", async () => {
    fetchAccountApi.mockResolvedValueOnce(new Response("oops", { status: 503 }));
    await expect(fetchFlags()).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });
});

describe("the protected hour (#170)", () => {
  it("reads logged and joined outcomes and the protected hour, which every build gets", async () => {
    fetchAuthenticated.mockResolvedValueOnce(
      reply(200, {
        visit: {
          visitId: "v1",
          parkId: "beacon-hill",
          outcome: "logged",
          pointsEarned: 1,
          pointsBreakdown: { base: 1, days: 0 },
          previousHolder: null,
          flagSince: null,
          protected: { until: "2026-10-13T18:00:00.000Z", leader: { handle: "tom", flagSeed: "t1" }, crewSize: 3 },
        },
      }),
    );
    await expect(sendVisit(ACCOUNT, { visitId: "v1", parkId: "beacon-hill" })).resolves.toEqual({
      visitId: "v1",
      parkId: "beacon-hill",
      outcome: "logged",
      pointsEarned: 1,
      pointsBreakdown: { base: 1, days: 0 },
      previousHolder: null,
      flagSince: null,
      protected: { until: "2026-10-13T18:00:00.000Z", leader: { handle: "tom", flagSeed: "t1" }, crewSize: 3 },
    });
    // already_today during another crew's hour carries the details too; a malformed one is dropped.
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { visit: { visitId: "v2", parkId: "p", outcome: "already_today", protected: { until: "later" } } }));
    await expect(sendVisit(ACCOUNT, { visitId: "v2", parkId: "p" })).resolves.toMatchObject({ outcome: "already_today", protected: null });
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { visit: { visitId: "v3", parkId: "p", outcome: "joined", pointsEarned: 2, protected: null } }));
    await expect(sendVisit(ACCOUNT, { visitId: "v3", parkId: "p" })).resolves.toMatchObject({ outcome: "joined", pointsEarned: 2, protected: null });
  });

  it("reads crews on flags and held parks, and parks with only a logged visit today", async () => {
    fetchAccountApi.mockResolvedValueOnce(
      reply(200, {
        flags: [
          {
            parkId: "a",
            handle: "tom",
            flagSeed: "t1",
            since: "2026-10-13T17:00:00Z",
            crew: { size: 6, memberSeeds: ["s1", "s2", "s3", "s4", 5], protectedUntil: "2026-10-13T18:00:00.000Z" },
          },
          { parkId: "b", handle: "sam", flagSeed: "s", since: "2026-10-01T00:00:00Z", crew: { size: 1, memberSeeds: [], protectedUntil: null } },
        ],
        serverTime: "2026-10-13T17:30:00Z",
      }),
    );
    const board = await fetchFlags();
    expect(board.flags[0].crew).toEqual({ size: 6, memberSeeds: ["s1", "s2", "s3"], protectedUntil: "2026-10-13T18:00:00.000Z" });
    expect(board.flags[1].crew).toEqual({ size: 1, memberSeeds: [], protectedUntil: null });

    fetchAuthenticated.mockResolvedValueOnce(
      reply(200, {
        player: { handle: "sara", flagSeed: "s1" },
        score: 3,
        parks: [
          { parkId: "a", since: "2026-10-13T17:00:00Z", days: 0, hours: 0, crew: { size: 2, leader: false, protectedUntil: "2026-10-13T18:00:00.000Z" } },
        ],
        takeovers: [],
        visitedToday: ["a"],
        loggedToday: ["b", 3],
        visitedTodayUntil: "2026-10-14T07:00:00.000Z",
      }),
    );
    const me = await fetchGameMe(ACCOUNT);
    expect(me.parks[0].crew).toEqual({ size: 2, leader: false, protectedUntil: "2026-10-13T18:00:00.000Z" });
    expect(me.loggedToday).toEqual(["b"]);
  });
});
