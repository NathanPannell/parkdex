import { describe, expect, it } from "vitest";
import type { GameMe, ParkFlag } from "./client";
import { formatClockTime, formatMinutesLeft, loggedVisitLine, protectionPhase } from "./protection";
import { buildPins, pinIconId } from "./mapPins";

const MIN = 60_000;
const start = Date.parse("2026-10-13T17:00:00.000Z");
const until = new Date(start + 60 * MIN).toISOString();
const flag = (crew: ParkFlag["crew"] = { size: 1, memberSeeds: [], protectedUntil: until }): ParkFlag => ({
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

describe("the protected hour", () => {
  const during = start + 18 * MIN;
  const after = start + 61 * MIN;

  it("protects someone else's new flag for an hour, from everyone else", () => {
    expect(protectionPhase({ flag: flag(), myHandle: "bee", me: me("bee"), now: during })).toEqual({ kind: "outsider", until, holder: "tom", logged: false });
    // Signed out, the server still protects it.
    expect(protectionPhase({ flag: flag(), myHandle: null, me: null, now: during })).toMatchObject({ kind: "outsider" });
    expect(protectionPhase({ flag: flag(), myHandle: "bee", me: me("bee"), now: after })).toEqual({ kind: "none" });
    expect(protectionPhase({ flag: null, myHandle: "bee", me: me("bee"), now: during })).toEqual({ kind: "none" });
    expect(protectionPhase({ flag: flag(null), myHandle: "bee", me: me("bee"), now: during })).toEqual({ kind: "none" });
  });

  it("never protects a flag from the walker who holds it", () => {
    expect(protectionPhase({ flag: flag(), myHandle: "tom", me: me("tom"), now: start + MIN })).toEqual({ kind: "none" });
    // Someone who joined it before crews were retired holds it too (/me lists it).
    const sara = me("sara", { parks: [{ parkId: "beacon-hill", since: flag().since, days: 0, hours: 0 }] });
    expect(protectionPhase({ flag: flag(), myHandle: "sara", me: sara, now: start + MIN })).toEqual({ kind: "none" });
  });

  it("knows a walker who already logged a visit today", () => {
    const logged = me("bee", { loggedToday: ["beacon-hill"], visitedTodayUntil: "2026-10-14T07:00:00.000Z" });
    expect(protectionPhase({ flag: flag(), myHandle: "bee", me: logged, now: start + 20 * MIN })).toMatchObject({ kind: "outsider", logged: true });
    // The list expires when the server's day ends.
    expect(
      protectionPhase({ flag: flag(), myHandle: "bee", me: { ...logged, visitedTodayUntil: new Date(start).toISOString() }, now: start + 20 * MIN }),
    ).toMatchObject({
      logged: false,
    });
  });

  it("writes the countdown and the logged line", () => {
    const now = start + 18 * MIN + 10_000;
    expect(formatMinutesLeft(until, now)).toBe("42 min");
    expect(formatMinutesLeft(until, start + 59 * MIN + 59_000)).toBe("1 min");
    expect(formatMinutesLeft(until, start + 61 * MIN)).toBe("0 min");
    const clock = new Date(2026, 9, 13, 15, 42).toISOString();
    expect(formatClockTime(clock)).toBe("3:42 pm");
    expect(formatClockTime(new Date(2026, 9, 13, 0, 5).getTime())).toBe("12:05 am");
    expect(formatClockTime("not a time")).toBe("later");
    expect(loggedVisitLine(clock)).toBe("Visit logged · +1. Come back after 3:42 pm to take this park.");
  });
});

describe("map pins after crews", () => {
  it("draw the holder's plain flag, whatever crew the server still lists", () => {
    const parks = [{ id: "beacon-hill", lng: -123.36, lat: 48.41 }];
    const crewFlag = { ...flag(), crew: { size: 6, memberSeeds: ["s1", "s2", "s3"], protectedUntil: until } };
    const { collection } = buildPins(parks, new Map([["beacon-hill", crewFlag]]), start + 10 * MIN);
    expect(collection.features[0].properties.icon).toBe(pinIconId("t1", 0, "10m"));
    expect(collection.features[0].properties.icon).toBe("pin:0:10m:t1");
  });
});
