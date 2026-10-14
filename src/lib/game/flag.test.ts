import { describe, expect, it } from "vitest";
import { contrast, describeFlagAge, flagAgeDays, flagAgeMs, flagBody, flagOutline, flagSpec, flagSvg, formatFlagAge, weatherForDays } from "./flag";

const seeds = Array.from({ length: 400 }, (_, index) => `seed-${index.toString(16)}-${(index * 2654435761) >>> 0}`);

describe("flag generator", () => {
  it("draws the same flag for the same seed", () => {
    for (const seed of seeds.slice(0, 50)) {
      expect(flagSpec(seed)).toEqual(flagSpec(seed));
      expect(flagSvg(seed, { weather: 2, idPrefix: "a" })).toBe(flagSvg(seed, { weather: 2, idPrefix: "a" }));
    }
  });

  // Pinned outputs: if these change, every player's flag changed on every device.
  it("keeps known seeds stable across builds", () => {
    expect(flagSpec("0f6c1d2e9a7b4c3d")).toMatchInlineSnapshot(`
      {
        "accent": "#E2589B",
        "emblem": "circle",
        "emblemColor": "#FFF8EC",
        "field": "#1B2A4A",
        "layout": "quarters",
      }
    `);
    expect(flagSpec("player-1")).toMatchInlineSnapshot(`
      {
        "accent": "#1B2A4A",
        "emblem": "star",
        "emblemColor": "#FFF8EC",
        "field": "#159A8C",
        "layout": "border",
      }
    `);
  });

  it("gives a small group visibly different flags", () => {
    const distinct = new Set(seeds.map((seed) => JSON.stringify(flagSpec(seed))));
    expect(distinct.size).toBeGreaterThan(300);
    const layouts = new Set(seeds.map((seed) => flagSpec(seed).layout));
    expect(layouts.size).toBe(8);
    const emblems = new Set(seeds.map((seed) => flagSpec(seed).emblem));
    expect(emblems.size).toBe(6);
  });

  it("keeps the two field colours and the emblem readable", () => {
    for (const seed of seeds) {
      const spec = flagSpec(seed);
      expect(spec.accent).not.toBe(spec.field);
      expect(contrast(spec.field, spec.accent)).toBeGreaterThanOrEqual(1.8);
      if (spec.layout === "plain") expect(spec.emblem).not.toBeNull();
      if (spec.layout === "cross") expect(spec.emblem).toBeNull();
    }
  });

  it("frays and fades older flags", () => {
    const seed = "player-1";
    expect(weatherForDays(0)).toBe(0);
    expect(weatherForDays(6)).toBe(0);
    expect(weatherForDays(7)).toBe(1);
    expect(weatherForDays(21)).toBe(2);
    expect(flagOutline(0).split(" ")).toHaveLength(4);
    expect(flagOutline(2).split(" ").length).toBeGreaterThan(flagOutline(1).split(" ").length);
    expect(flagBody(seed, { weather: 0 })).not.toContain("clipPath");
    expect(flagBody(seed, { weather: 1, idPrefix: "x" })).toContain('clipPath id="x-clip"');
    expect(flagBody(seed, { weather: 2 })).not.toBe(flagBody(seed, { weather: 1 }));
  });

  it("only writes safe characters into clip path ids", () => {
    expect(flagBody("player-1", { weather: 1, idPrefix: '«r1»"><script>' })).toContain('clipPath id="r1script-clip"');
  });
});

describe("flag age", () => {
  it("counts whole days up to the server time", () => {
    expect(flagAgeDays("2026-10-01T12:00:00Z", "2026-10-07T11:59:59Z")).toBe(5);
    expect(flagAgeDays("2026-10-01T12:00:00Z", "2026-10-07T12:00:00Z")).toBe(6);
    expect(flagAgeDays("2026-10-08T00:00:00Z", "2026-10-07T00:00:00Z")).toBe(0);
    expect(flagAgeDays("nonsense", Date.now())).toBe(0);
  });

  it("labels fresh and older flags", () => {
    const minute = 60_000;
    const hour = 60 * minute;
    expect(formatFlagAge(0)).toBe("0m");
    expect(formatFlagAge(35 * minute + 59_000)).toBe("35m");
    expect(formatFlagAge(hour - 1)).toBe("59m");
    expect(formatFlagAge(hour)).toBe("1h");
    expect(formatFlagAge(3 * hour + 59 * minute)).toBe("3h");
    expect(formatFlagAge(24 * hour - 1)).toBe("23h");
    expect(formatFlagAge(24 * hour)).toBe("1d");
    expect(formatFlagAge(2 * 24 * hour + 23 * hour)).toBe("2d");
    expect(formatFlagAge(-5)).toBe("0m");
    expect(formatFlagAge(Number.NaN)).toBe("0m");
    expect(flagAgeMs("2026-10-01T12:00:00Z", "2026-10-01T12:35:00Z")).toBe(35 * minute);
    expect(flagAgeMs("2026-10-01T12:00:00Z", "2026-10-01T11:00:00Z")).toBe(0);
    expect(flagAgeMs("nonsense", Date.now())).toBe(0);
  });

  it("says a flag's age in words", () => {
    const minute = 60_000;
    const hour = 60 * minute;
    expect(describeFlagAge(0)).toBe("0 minutes");
    expect(describeFlagAge(minute)).toBe("1 minute");
    expect(describeFlagAge(12 * minute + 30_000)).toBe("12 minutes");
    expect(describeFlagAge(hour)).toBe("1 hour");
    expect(describeFlagAge(3 * hour + 59 * minute)).toBe("3 hours");
    expect(describeFlagAge(24 * hour)).toBe("1 day");
    expect(describeFlagAge(2 * 24 * hour + 23 * hour)).toBe("2 days");
    expect(describeFlagAge(Number.NaN)).toBe("0 minutes");
  });
});
