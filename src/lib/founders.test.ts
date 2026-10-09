import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAuthenticated = vi.fn();
const fetchAccountApi = vi.fn();
vi.mock("./accounts/authClient", () => ({
  fetchAuthenticated: (...args: unknown[]) => fetchAuthenticated(...args),
  fetchAccountApi: (...args: unknown[]) => fetchAccountApi(...args),
  accountApiUrl: (path: string) => new URL(path, "https://api.example.test/").href,
}));

const {
  FounderError, checkFlags, foundBackAction, coverImageUrl, defaultPark, fetchParkSummary, foundPark, isFreshFix, parkLabel, parseContainingPark, scanParks, targetFor,
} = await import("./founders");
type ContainingPark = import("./founders").ContainingPark;

const ACCOUNT = "ae172e85-a8ab-4e1d-a032-901100000001";
const square = { type: "MultiPolygon", coordinates: [[[[-123.06, 49.08], [-123.05, 49.08], [-123.05, 49.09], [-123.06, 49.09], [-123.06, 49.08]]]] };

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function candidate(overrides: Partial<ContainingPark> & { id: number }): ContainingPark {
  return {
    type: "way",
    name: null,
    kind: "leisure=park",
    areaM2: 1000,
    geometry: square as ContainingPark["geometry"],
    inCatalogue: null,
    founder: null,
    hasCover: false,
    ...overrides,
  };
}

const request = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  position: { lat: 49.089, lng: -123.0601, accuracyM: 12 },
  target: { osm: { type: "way" as const, id: 42 } },
  photo: { mime: "image/jpeg" as const, base64: "/9j/AAAA", width: 1280, height: 960 },
};

beforeEach(() => {
  fetchAuthenticated.mockReset();
  fetchAccountApi.mockReset();
});

describe("scanParks", () => {
  it("asks for the parks containing the position, with its accuracy", async () => {
    fetchAccountApi.mockResolvedValueOnce(reply(200, { parks: [] }));
    await scanParks({ point: [-123.0601, 49.089], accuracy: 12.4 });
    const [path] = fetchAccountApi.mock.calls[0];
    const url = new URL(path, "https://api.example.test");
    expect(url.pathname).toBe("/api/osm/parks");
    expect(Object.fromEntries(url.searchParams)).toEqual({ lat: "49.089000", lng: "-123.060100", accuracy: "12" });
  });

  it("reads founders and covers on catalogue matches and drops malformed outlines", async () => {
    fetchAccountApi.mockResolvedValueOnce(reply(200, {
      parks: [
        { type: "way", id: 1, name: "Paterson Park", kind: "leisure=park", areaM2: 52000, geometry: square, inCatalogue: { parkId: "paterson", name: "Paterson Park" }, founder: { handle: "robin" }, hasCover: true },
        { type: "relation", id: 2, name: null, kind: "leisure=garden", areaM2: 300, geometry: square, inCatalogue: null, founder: null },
        { type: "node", id: 3, geometry: square },
        { type: "way", id: 4, geometry: { type: "Polygon", coordinates: [] } },
      ],
    }));
    const parks = await scanParks({ point: [-123.0601, 49.089], accuracy: 10 });
    expect(parks).toHaveLength(2);
    expect(parks[0]).toMatchObject({ id: 1, founder: { handle: "robin" }, hasCover: true, inCatalogue: { parkId: "paterson" } });
    expect(parks[1]).toMatchObject({ id: 2, founder: null, hasCover: false, name: null });
    expect(parkLabel(parks[1])).toBe("Unnamed garden");
  });

  it("ignores a founder on an outline that is not a Parkdex park", () => {
    expect(parseContainingPark({ type: "way", id: 5, geometry: square, founder: { handle: "x" } })?.founder).toBeNull();
  });

  it("explains a refused scan with the server's message", async () => {
    fetchAccountApi.mockResolvedValueOnce(reply(422, { code: "location_imprecise", message: "Your location is not precise enough" }));
    await expect(scanParks({ point: [0, 0], accuracy: 150 })).rejects.toMatchObject({ code: "location_imprecise", message: "Your location is not precise enough" });
    fetchAccountApi.mockResolvedValueOnce(reply(429, { code: "rate_limited_osm", message: "Too many map searches." }));
    await expect(scanParks({ point: [0, 0], accuracy: 10 })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("defaultPark", () => {
  it("picks the largest named park when outlines nest", () => {
    const garden = candidate({ id: 1, name: "Rose Garden", areaM2: 800 });
    const park = candidate({ id: 2, name: "Paterson Park", areaM2: 52000 });
    const unnamed = candidate({ id: 3, name: null, areaM2: 90000 });
    expect(defaultPark([garden, unnamed, park])?.id).toBe(2);
  });

  it("never picks a park that already has a founder", () => {
    const founded = candidate({ id: 1, name: "Big Park", areaM2: 90000, inCatalogue: { parkId: "big", name: "Big Park" }, founder: { handle: "sam" } });
    const garden = candidate({ id: 2, name: "Small Garden", areaM2: 500 });
    expect(defaultPark([founded, garden])?.id).toBe(2);
    expect(defaultPark([founded])).toBeNull();
  });

  it("falls back to the largest outline when none has a name", () => {
    expect(defaultPark([candidate({ id: 1, areaM2: 10 }), candidate({ id: 2, areaM2: 20 })])?.id).toBe(2);
  });

  it("targets the Parkdex park for catalogue matches and the outline otherwise", () => {
    expect(targetFor(candidate({ id: 7, inCatalogue: { parkId: "p7", name: "P7" } }))).toEqual({ parkId: "p7" });
    expect(targetFor(candidate({ id: 8, type: "relation" }))).toEqual({ osm: { type: "relation", id: 8 } });
  });
});

describe("foundPark", () => {
  it("posts the attempt as the signed-in account and reads a founding", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, {
      outcome: "founded",
      park: { id: "osm-way-42", name: "Paterson Park" },
      coverUrl: "/api/parks/osm-way-42/cover/abc.jpg",
      visit: { visitId: "v1", parkId: "osm-way-42", outcome: "planted", pointsEarned: 0, previousHolder: null, flagSince: "2026-10-08T20:00:00Z" },
      founderPoints: 10,
    }));
    const result = await foundPark(ACCOUNT, request);
    const [path, init, accountId] = fetchAuthenticated.mock.calls[0];
    expect(path).toBe("/api/parks/found");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(request);
    expect(accountId).toBe(ACCOUNT);
    expect(result).toEqual({
      outcome: "founded",
      park: { id: "osm-way-42", name: "Paterson Park" },
      coverUrl: "/api/parks/osm-way-42/cover/abc.jpg",
      visit: { visitId: "v1", parkId: "osm-way-42", outcome: "planted", pointsEarned: 0, previousHolder: null, flagSince: "2026-10-08T20:00:00Z" },
      founderPoints: 10,
    });
  });

  it("accepts the visit with its wrapper and a missing bonus", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, {
      outcome: "founded",
      park: { id: "p", name: "P" },
      visit: { visit: { visitId: "v", parkId: "p", outcome: "took", pointsEarned: 3, previousHolder: { handle: "b", flagSeed: "s" }, flagSince: null } },
    }));
    const result = await foundPark(ACCOUNT, request);
    expect(result).toMatchObject({ outcome: "founded", founderPoints: 10, coverUrl: null, visit: { outcome: "took", pointsEarned: 3, previousHolder: { handle: "b" } } });
  });

  it("returns rejected and unsure photos with their flags", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { outcome: "rejected", flags: [{ code: "people", message: "We spotted people. Take one without anyone in it." }, { code: "lighting" }] }));
    const rejected = await foundPark(ACCOUNT, request);
    expect(rejected).toEqual({ outcome: "rejected", flags: [
      { code: "people", message: "We spotted people. Take one without anyone in it." },
      { code: "lighting", message: expect.stringMatching(/dark/) },
    ] });
    fetchAuthenticated.mockResolvedValueOnce(reply(422, { outcome: "unsure", flags: [] }));
    const unsure = await foundPark(ACCOUNT, request);
    expect(unsure).toEqual({ outcome: "unsure", flags: [] });
    if (unsure.outcome === "unsure") expect(checkFlags(unsure)).toEqual([{ code: "unsure", message: "We couldn't tell. Try another angle." }]);
  });

  it("marks an unavailable check as retryable", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(503, { code: "moderation_unavailable", message: "busy" }));
    const error = await foundPark(ACCOUNT, request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FounderError);
    expect(error).toMatchObject({ code: "unavailable", status: 503, retryable: true, message: "Try again in a moment." });
  });

  it("says who founded a park that was founded first", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(409, { code: "already_founded", message: "This park already has a founder.", founder: { handle: "sam" } }));
    await expect(foundPark(ACCOUNT, request)).rejects.toMatchObject({ code: "already_founded", founder: "sam", retryable: false });
  });

  it("reads the founder's handle from the server's message", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(409, { error: { code: "already_founded", message: "This park already has a founder: @tester_one." }, code: "already_founded", message: "This park already has a founder: @tester_one." }));
    await expect(foundPark(ACCOUNT, request)).rejects.toMatchObject({ code: "already_founded", founder: "tester_one" });
  });

  it("shows the server's reason for other refusals and limits", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(422, { code: "unnamed_park", message: "This park has no name on OpenStreetMap yet, so it can't be founded." }));
    await expect(foundPark(ACCOUNT, request)).rejects.toMatchObject({ code: "refused", retryable: false, message: "This park has no name on OpenStreetMap yet, so it can't be founded." });
    fetchAuthenticated.mockResolvedValueOnce(reply(429, { code: "rate_limited_founding", message: "You've founded a lot of parks today. Try again tomorrow." }));
    await expect(foundPark(ACCOUNT, request)).rejects.toMatchObject({ code: "rate_limited", message: "You've founded a lot of parks today. Try again tomorrow." });
    fetchAuthenticated.mockResolvedValueOnce(reply(401, { code: "authentication_required", message: "Sign in." }));
    await expect(foundPark(ACCOUNT, request)).rejects.toMatchObject({ code: "unauthenticated", message: "Sign in again to found a park." });
  });

  it("asks for a handle, and keeps the server's reason for being outside", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(409, { error: { code: "handle_required", message: "Pick a handle" }, code: "handle_required" }));
    await expect(foundPark(ACCOUNT, request)).rejects.toMatchObject({ code: "handle_required" });
    fetchAuthenticated.mockResolvedValueOnce(reply(422, { code: "not_in_park", message: "You need to be in the park to found it." }));
    await expect(foundPark(ACCOUNT, request)).rejects.toMatchObject({ code: "not_inside", message: "You need to be in the park to found it." });
  });

  it("treats a lost connection as offline and retryable", async () => {
    fetchAuthenticated.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(foundPark(ACCOUNT, request)).rejects.toMatchObject({ code: "offline", retryable: true });
  });

  it("refuses an answer it cannot read", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, { outcome: "maybe" }));
    await expect(foundPark(ACCOUNT, request)).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("fetchParkSummary", () => {
  const body = { parkId: "paterson", founder: { handle: "robin", foundedAt: "2026-10-08T20:00:00Z" }, coverUrl: "/api/parks/paterson/cover/abc.jpg", visits: { total: 12, last30Days: 5, mine: 2 } };

  it("reads the summary with the player's own count when signed in", async () => {
    fetchAuthenticated.mockResolvedValueOnce(reply(200, body));
    await expect(fetchParkSummary("paterson", ACCOUNT)).resolves.toEqual({
      parkId: "paterson",
      founder: { handle: "robin", foundedAt: "2026-10-08T20:00:00Z" },
      coverUrl: "/api/parks/paterson/cover/abc.jpg",
      visits: { total: 12, last30Days: 5, mine: 2 },
    });
    expect(fetchAuthenticated.mock.calls[0][0]).toBe("/api/parks/paterson/summary");
    expect(fetchAccountApi).not.toHaveBeenCalled();
  });

  it("reads public counts for guests and after a stale session", async () => {
    fetchAccountApi.mockResolvedValueOnce(reply(200, { ...body, founder: null, coverUrl: null, visits: { total: 3, last30Days: 1, mine: null } }));
    await expect(fetchParkSummary("a b", null)).resolves.toMatchObject({ founder: null, coverUrl: null, visits: { total: 3, last30Days: 1, mine: null } });
    expect(fetchAccountApi.mock.calls[0][0]).toBe("/api/parks/a%20b/summary");
    fetchAuthenticated.mockResolvedValueOnce(reply(401, { code: "unauthenticated" }));
    fetchAccountApi.mockResolvedValueOnce(reply(200, body));
    await expect(fetchParkSummary("paterson", ACCOUNT)).resolves.toMatchObject({ visits: { total: 12 } });
  });

  it("fails for a park the server does not know", async () => {
    fetchAccountApi.mockResolvedValueOnce(reply(404, { code: "park_not_found" }));
    await expect(fetchParkSummary("gone", null)).rejects.toMatchObject({ code: "park_not_found" });
  });
});

describe("helpers", () => {
  it("resolves cover photos on the API origin", () => {
    expect(coverImageUrl("/api/parks/p/cover/abc.jpg")).toBe("https://api.example.test/api/parks/p/cover/abc.jpg");
    expect(coverImageUrl("https://cdn.example.test/x.jpg")).toBe("https://cdn.example.test/x.jpg");
    expect(coverImageUrl("javascript:alert(1)")).toBeNull();
    expect(coverImageUrl(null)).toBeNull();
  });

  it("treats a position older than 30 seconds as stale", () => {
    expect(isFreshFix({ at: 1_000 }, 31_000)).toBe(true);
    expect(isFreshFix({ at: 1_000 }, 31_001)).toBe(false);
    expect(isFreshFix(null)).toBe(false);
  });
});

describe("foundBackAction", () => {
  it("steps back from the camera and answers to the scan result, and closes from the scan and the celebration", () => {
    expect(foundBackAction("camera")).toBe("results");
    expect(foundBackAction("rejected")).toBe("results");
    expect(foundBackAction("retry")).toBe("results");
    for (const step of ["locating", "scanning", "results", "problem", "taken", "founded"] as const) expect(foundBackAction(step)).toBe("close");
    expect(foundBackAction("checking")).toBe("stay");
  });
});
