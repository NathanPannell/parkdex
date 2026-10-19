import { describe, expect, it } from "vitest";
import type { Crew, GameMe, ParkFlag } from "./client";
import { crewCodeFromText, crewHeadline, crewLink, crewMemberNote, crewPhase, formatClockTime, formatMinutesLeft, friendOffers, loggedVisitLine } from "./crew";
import { buildPins, pinIconId, pinImageSvg } from "./mapPins";
import { flagPinSvg, flagSpec } from "./flag";

const MIN = 60_000;
const start = Date.parse("2026-10-13T17:00:00.000Z");
const until = new Date(start + 60 * MIN).toISOString();
const flag = (crew: ParkFlag["crew"] = { size: 2, memberSeeds: ["s1"], protectedUntil: until }): ParkFlag => ({
  parkId: "beacon-hill",
  handle: "tom",
  flagSeed: "t1",
  since: new Date(start).toISOString(),
  crew,
});
const me = (handle: string, extra: Partial<GameMe> = {}): GameMe => ({
  player: { handle, flagSeed: `${handle}-seed` },
  score: 0,
  parks: [],
  takeovers: [],
  flagSeed: `${handle}-seed`,
  ...extra,
});
const crew = (extra: Partial<Crew> = {}): Crew => ({
  parkId: "beacon-hill",
  leader: { handle: "tom", flagSeed: "t1" },
  members: [
    { handle: "tom", flagSeed: "t1", joinedAt: new Date(start).toISOString(), leader: true },
    { handle: "sara", flagSeed: "s1", joinedAt: new Date(start + 12 * MIN).toISOString(), leader: false },
  ],
  size: 2,
  cap: 8,
  flagSince: new Date(start).toISOString(),
  protectedUntil: until,
  member: false,
  code: null,
  codeExpiresAt: null,
  ...extra,
});

describe("park page crew states", () => {
  const during = start + 18 * MIN;
  const after = start + 61 * MIN;

  it("picks the leader, member, outsider and after-the-hour states", () => {
    expect(crewPhase({ enabled: true, flag: flag(), myHandle: "tom", me: me("tom"), now: during })).toEqual({ kind: "leader", until });
    // A member is known from /me's held parks, or from the crew read on the park page.
    const sara = me("sara", { parks: [{ parkId: "beacon-hill", since: flag().since, days: 0, hours: 0 }] });
    expect(crewPhase({ enabled: true, flag: flag(), myHandle: "sara", me: sara, now: during })).toEqual({ kind: "member", until, leader: "tom" });
    expect(crewPhase({ enabled: true, flag: flag(), myHandle: "sara", me: me("sara"), crew: crew({ member: true }), now: during })).toMatchObject({
      kind: "member",
    });
    expect(crewPhase({ enabled: true, flag: flag(), myHandle: "bee", me: me("bee"), now: during })).toEqual({
      kind: "outsider",
      until,
      leader: "tom",
      logged: false,
    });
    expect(crewPhase({ enabled: true, flag: flag(), myHandle: "tom", me: me("tom"), now: after })).toEqual({ kind: "closed", size: 2 });
    // A solo flag after its hour is the normal V1 park.
    expect(crewPhase({ enabled: true, flag: flag({ size: 1, memberSeeds: [], protectedUntil: until }), myHandle: "bee", me: me("bee"), now: after })).toEqual({
      kind: "none",
    });
    expect(crewPhase({ enabled: true, flag: null, myHandle: "bee", me: me("bee"), now: during })).toEqual({ kind: "none" });
  });

  it("knows an outsider who already logged a visit today", () => {
    const logged = me("bee", { loggedToday: ["beacon-hill"], visitedTodayUntil: "2026-10-14T07:00:00.000Z" });
    expect(crewPhase({ enabled: true, flag: flag(), myHandle: "bee", me: logged, now: start + 20 * MIN })).toMatchObject({ kind: "outsider", logged: true });
    // The list expires when the server's day ends.
    expect(
      crewPhase({ enabled: true, flag: flag(), myHandle: "bee", me: { ...logged, visitedTodayUntil: new Date(start).toISOString() }, now: start + 20 * MIN }),
    ).toMatchObject({ logged: false });
  });

  it("shows nothing of crews with the flag off", () => {
    for (const handle of ["tom", "sara", "bee"]) {
      expect(crewPhase({ enabled: false, flag: flag(), myHandle: handle, me: me(handle), now: start + MIN })).toEqual({ kind: "none" });
    }
  });

  it("ignores a crew read for an earlier flag at the same park", () => {
    const old = crew({ flagSince: "2026-10-12T10:00:00.000Z", member: true, protectedUntil: until });
    expect(crewPhase({ enabled: true, flag: flag(), myHandle: "bee", me: me("bee"), crew: old, now: start + MIN })).toMatchObject({ kind: "outsider" });
  });

  it("writes the status lines with a live countdown", () => {
    const now = start + 18 * MIN + 10_000;
    expect(formatMinutesLeft(until, now)).toBe("42 min");
    expect(formatMinutesLeft(until, start + 59 * MIN + 59_000)).toBe("1 min");
    expect(formatMinutesLeft(until, start + 61 * MIN)).toBe("0 min");
    expect(crewHeadline({ kind: "leader", until }, start + 2 * MIN)).toBe("Your flag is protected · 58 min");
    expect(crewHeadline({ kind: "member", until, leader: "tom" }, now)).toBe("You're in @tom's crew · protected 42 min");
    expect(crewHeadline({ kind: "outsider", until, leader: "tom", logged: false }, now)).toBe("@tom's crew flag is protected · 42 min");
    const clock = new Date(2026, 9, 13, 15, 42).toISOString();
    expect(formatClockTime(clock)).toBe("3:42 pm");
    expect(formatClockTime(new Date(2026, 9, 13, 0, 5).getTime())).toBe("12:05 am");
    expect(loggedVisitLine(clock)).toBe("Visit logged · +1. Come back after 3:42 pm to take this park.");
  });

  it("notes when each member joined", () => {
    const [leader, sara] = crew().members;
    expect(crewMemberNote(leader, crew().flagSince)).toBe("planted");
    expect(crewMemberNote(sara, crew().flagSince)).toBe("joined +12 min");
  });

  it("offers crew members who aren't friends yet", () => {
    const members = crew({ members: [...crew().members, { handle: "bee", flagSeed: "b", joinedAt: crew().flagSince, leader: false }] });
    expect(friendOffers(members, "bee", new Set(["tom"])).map((member) => member.handle)).toEqual(["sara"]);
  });
});

describe("crew links", () => {
  it("builds a link on the App Link host with the park", () => {
    expect(crewLink("K7QX2M", "beacon-hill", "https://staging.web.parkdex.app")).toBe("https://staging.web.parkdex.app/crew/K7QX2M?park=beacon-hill");
    expect(crewLink("K7QX2M", null, "https://web.parkdex.app")).toBe("https://web.parkdex.app/crew/K7QX2M");
  });

  it("parses scanned links, typed codes and nothing else", () => {
    expect(crewCodeFromText("https://web.parkdex.app/crew/K7QX2M?park=beacon-hill")).toEqual({ code: "K7QX2M", parkId: "beacon-hill" });
    expect(crewCodeFromText("https://staging.web.parkdex.app/crew/k7q-x2m")).toEqual({ code: "K7QX2M", parkId: null });
    expect(crewCodeFromText(" k7q x2m ")).toEqual({ code: "K7QX2M", parkId: null });
    expect(crewCodeFromText("https://web.parkdex.app/crew/K7QX2M?park=%3Cscript%3E")).toEqual({ code: "K7QX2M", parkId: null });
    // Friend links, other hosts, wrong lengths and letters outside the alphabet are not crew codes.
    expect(crewCodeFromText("https://web.parkdex.app/friend/ABCD2345")).toBeNull();
    expect(crewCodeFromText("https://evil.example/crew/K7QX2M")).toBeNull();
    expect(crewCodeFromText("K7QX2")).toBeNull();
    expect(crewCodeFromText("K7QX2O")).toBeNull();
  });
});

describe("crew map pins", () => {
  const now = start + 10 * MIN;
  const parks = [{ id: "beacon-hill", lng: -123.36, lat: 48.41 }];
  const crewFlag = (size: number, seeds: string[], protectedUntil: string | null): ParkFlag => ({
    ...flag(),
    crew: { size, memberSeeds: seeds, protectedUntil },
  });

  it("names the image by leader, up to 3 member seeds, the count, the hour and the weather", () => {
    const { collection, images } = buildPins(parks, new Map([["beacon-hill", crewFlag(6, ["s1", "s2", "s3"], until)]]), now, { crews: true });
    const icon = collection.features[0].properties.icon;
    expect(icon).toBe(pinIconId("t1", 0, "10m", { pennants: ["s1", "s2", "s3"], size: 6, shield: true }));
    expect(icon).toBe("pin:0:10m:t1:crew:6:p:s1,s2,s3");
    expect(images.get(icon)).toMatchObject({ pennants: ["s1", "s2", "s3"], extra: 2, shield: true });
    // After the hour the shield goes, and the pennants stay.
    const later = buildPins(parks, new Map([["beacon-hill", crewFlag(2, ["s1"], null)]]), start + 3 * 3_600_000, { crews: true });
    expect(later.collection.features[0].properties.icon).toBe("pin:0:3h:t1:crew:2:o:s1");
  });

  it("keeps a solo flag after its hour, and every pin with crews off, as before", () => {
    const solo = buildPins(parks, new Map([["beacon-hill", crewFlag(1, [], null)]]), now, { crews: true });
    expect(solo.collection.features[0].properties.icon).toBe(pinIconId("t1", 0, "10m"));
    const off = buildPins(parks, new Map([["beacon-hill", crewFlag(6, ["s1", "s2", "s3"], until)]]), now);
    expect(off.collection.features[0].properties.icon).toBe("pin:0:10m:t1");
    expect(pinImageSvg([...off.images.values()][1])).toBe(flagPinSvg("t1", { weather: 0, label: "10m", idPrefix: "pin", scale: 2 }));
  });

  it("draws pennants in members' colours, a +N tag and the shield", () => {
    const { images, collection } = buildPins(parks, new Map([["beacon-hill", crewFlag(6, ["s1", "s2", "s3"], until)]]), now, { crews: true });
    const svg = pinImageSvg(images.get(collection.features[0].properties.icon)!);
    for (const seed of ["s1", "s2", "s3"]) expect(svg).toContain(`fill="${flagSpec(seed).field}"`);
    expect(svg).toContain(">+2</text>");
    expect(svg).toContain(">10m</text>");
    expect(svg).toContain("#FFC93C");
    expect(svg.match(/<svg/g)).toHaveLength(1);
    expect(svg.endsWith("</svg>")).toBe(true);
  });
});
